import Foundation
import Observation

struct APIClientConfiguration: Equatable {
    var baseURL: URL
    var appVersion: String
    var osVersion: String
    var platform: String

    var normalizedBaseURL: URL {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
        let trimmedPath = components?.path.trimmingCharacters(in: CharacterSet(charactersIn: "/")) ?? ""
        components?.path = trimmedPath.isEmpty ? "" : "/\(trimmedPath)"
        return components?.url ?? baseURL
    }
}

enum HTTPMethod: String {
    case get = "GET"
    case post = "POST"
    case put = "PUT"
    case patch = "PATCH"
    case delete = "DELETE"
}

enum APIAuthorizationPolicy: Equatable {
    case none
    case optional
    case required
}

enum APIRequestSigningPolicy: Equatable {
    case none
    case whenAvailable
    case required
}

enum APISecurityIncident: Equatable {
    case sessionExpired
    case clientRevoked
    case invalidSignature
    case signingSecretRotated
}

struct APIEmptyResponse: Decodable, Equatable {
    init() {}
}

struct APITransportFailure: Equatable, Sendable {
    let requestID: String
    let path: String
    let code: URLError.Code
    let attempt: Int
}

enum APIClientError: LocalizedError, Equatable {
    case invalidURL(String)
    case invalidResponse
    case authenticationRequired
    case clientIdentityRequired
    case signingUnavailable
    case httpStatus(status: Int, code: String?, message: String?)
    case superseded

    var errorDescription: String? {
        switch self {
        case .invalidURL(let path):
            "Invalid URL for \(path)"
        case .invalidResponse:
            "Invalid server response"
        case .authenticationRequired:
            "Authentication is required"
        case .clientIdentityRequired:
            "Client identity is required"
        case .signingUnavailable:
            "Request signing is not ready"
        case .httpStatus(let status, _, let message):
            message ?? "Server returned HTTP \(status)"
        case .superseded:
            "The request was superseded by newer state"
        }
    }
}

private struct APIErrorEnvelope: Decodable {
    let error: String?
    let code: String?
    let message: String?
}

@MainActor
@Observable
final class APIClient {
    typealias SecurityRecoveryHandler = (APISecurityIncident) async -> Bool

    var configuration: APIClientConfiguration
    var securityRecoveryHandler: SecurityRecoveryHandler?
    private(set) var lastTransportFailure: APITransportFailure?

    private let session: URLSession
    private let retrySession: URLSession
    private weak var authCenter: AuthCenter?
    private weak var clientIdentityCenter: ClientIdentityCenter?
    private weak var requestSigningCenter: RequestSigningCenter?

    init(
        configuration: APIClientConfiguration,
        session: URLSession = .shared
    ) {
        self.configuration = configuration
        self.session = session
        let retryConfiguration = session.configuration
        retryConfiguration.requestCachePolicy = .reloadIgnoringLocalCacheData
        retryConfiguration.waitsForConnectivity = true
        self.retrySession = URLSession(configuration: retryConfiguration)
    }

    func configureSecurity(
        authCenter: AuthCenter,
        clientIdentityCenter: ClientIdentityCenter,
        requestSigningCenter: RequestSigningCenter
    ) {
        self.authCenter = authCenter
        self.clientIdentityCenter = clientIdentityCenter
        self.requestSigningCenter = requestSigningCenter
    }

    func url(for path: String, queryItems: [URLQueryItem] = []) throws -> URL {
        var trimmedPath = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard !trimmedPath.isEmpty else {
            throw APIClientError.invalidURL(path)
        }

        var url = configuration.normalizedBaseURL
        if url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/")) == "api",
           trimmedPath.hasPrefix("api/")
        {
            trimmedPath.removeFirst("api/".count)
        }

        for component in trimmedPath.split(separator: "/") {
            url.appendPathComponent(String(component))
        }

        if !queryItems.isEmpty {
            var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
            components?.queryItems = queryItems
            guard let nextURL = components?.url else {
                throw APIClientError.invalidURL(path)
            }
            url = nextURL
        }

        return url
    }

    func getJSON<Value: Decodable>(
        _ type: Value.Type,
        path: String,
        queryItems: [URLQueryItem] = [],
        headers: [String: String] = [:],
        authorization: APIAuthorizationPolicy = .required,
        signing: APIRequestSigningPolicy = .none,
        retryOnConnectionLoss: Bool = false,
        decoder: JSONDecoder = JSONDecoder()
    ) async throws -> Value {
        try await requestJSON(
            type,
            method: .get,
            path: path,
            queryItems: queryItems,
            headers: headers,
            authorization: authorization,
            signing: signing,
            retryOnConnectionLoss: retryOnConnectionLoss,
            decoder: decoder
        )
    }

    func requestJSON<Value: Decodable>(
        _ type: Value.Type,
        method: HTTPMethod,
        path: String,
        queryItems: [URLQueryItem] = [],
        headers: [String: String] = [:],
        authorization: APIAuthorizationPolicy = .required,
        signing: APIRequestSigningPolicy = .none,
        retryOnConnectionLoss: Bool = false,
        decoder: JSONDecoder = JSONDecoder()
    ) async throws -> Value {
        let data = try await requestData(
            method: method,
            path: path,
            queryItems: queryItems,
            headers: headers,
            body: nil,
            authorization: authorization,
            signing: signing,
            retryOnConnectionLoss: retryOnConnectionLoss
        )
        if data.isEmpty, let empty = APIEmptyResponse() as? Value {
            return empty
        }
        return try decoder.decode(Value.self, from: data)
    }

    func requestJSON<Value: Decodable, Body: Encodable>(
        _ type: Value.Type,
        method: HTTPMethod,
        path: String,
        queryItems: [URLQueryItem] = [],
        headers: [String: String] = [:],
        body: Body,
        authorization: APIAuthorizationPolicy = .required,
        signing: APIRequestSigningPolicy = .none,
        retryOnConnectionLoss: Bool = false,
        decoder: JSONDecoder = JSONDecoder()
    ) async throws -> Value {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let bodyData = try encoder.encode(body)
        let data = try await requestData(
            method: method,
            path: path,
            queryItems: queryItems,
            headers: headers,
            body: bodyData,
            authorization: authorization,
            signing: signing,
            retryOnConnectionLoss: retryOnConnectionLoss
        )
        if data.isEmpty, let empty = APIEmptyResponse() as? Value {
            return empty
        }
        return try decoder.decode(Value.self, from: data)
    }

    func requestData(
        method: HTTPMethod,
        path: String,
        queryItems: [URLQueryItem] = [],
        headers: [String: String] = [:],
        body: Data? = nil,
        authorization: APIAuthorizationPolicy = .required,
        signing: APIRequestSigningPolicy = .none,
        retryOnConnectionLoss: Bool = false
    ) async throws -> Data {
        let targetURL = try url(for: path, queryItems: queryItems)
        var retryCount = 0
        var transportAttempt = 0

        while true {
            let request = try makeRequest(
                url: targetURL,
                method: method,
                headers: headers,
                body: body,
                authorization: authorization,
                signing: signing
            )
            let dataAndResponse: (Data, URLResponse)
            do {
                let transport = transportAttempt == 0 ? session : retrySession
                dataAndResponse = try await transport.data(for: request)
            } catch let error as URLError {
                let requestID = request.value(forHTTPHeaderField: "X-Athena-Request-Id") ?? "unknown"
                lastTransportFailure = APITransportFailure(
                    requestID: requestID,
                    path: targetURL.path,
                    code: error.code,
                    attempt: transportAttempt + 1
                )
#if DEBUG
                debugRequestLog(
                    requestID: requestID,
                    method: method,
                    outcome: "transport",
                    status: nil,
                    code: String(error.code.rawValue),
                    attempt: transportAttempt + 1
                )
#endif
                if retryOnConnectionLoss,
                   transportAttempt == 0,
                   error.code == .networkConnectionLost
                {
                    transportAttempt += 1
                    continue
                }
                throw error
            }
            let (data, response) = dataAndResponse
            guard let httpResponse = response as? HTTPURLResponse else {
                throw APIClientError.invalidResponse
            }
            guard (200..<300).contains(httpResponse.statusCode) else {
                let error = serverError(status: httpResponse.statusCode, data: data)
#if DEBUG
                debugRequestLog(
                    requestID: request.value(forHTTPHeaderField: "X-Athena-Request-Id") ?? "unknown",
                    method: method,
                    outcome: "http",
                    status: httpResponse.statusCode,
                    code: errorCode(for: error),
                    attempt: transportAttempt + 1
                )
#endif
                if authorization != .none,
                   retryCount == 0,
                   let incident = securityIncident(for: error),
                   let securityRecoveryHandler,
                   await securityRecoveryHandler(incident)
                {
                    retryCount += 1
                    continue
                }
                throw error
            }
#if DEBUG
            debugRequestLog(
                requestID: request.value(forHTTPHeaderField: "X-Athena-Request-Id") ?? "unknown",
                method: method,
                outcome: "success",
                status: httpResponse.statusCode,
                code: nil,
                attempt: transportAttempt + 1
            )
#endif
            return data
        }
    }

    func openJSONStream<Body: Encodable>(
        path: String,
        body: Body,
        authorization: APIAuthorizationPolicy = .required
    ) async throws -> (URLSession.AsyncBytes, HTTPURLResponse) {
        let targetURL = try url(for: path)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let bodyData = try encoder.encode(body)
        let request = try makeRequest(
            url: targetURL,
            method: .post,
            headers: ["Accept": "text/event-stream"],
            body: bodyData,
            authorization: authorization,
            signing: .none
        )
        let (bytes, response) = try await session.bytes(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw APIClientError.invalidResponse
        }
        guard (200..<300).contains(httpResponse.statusCode) else {
            throw APIClientError.httpStatus(
                status: httpResponse.statusCode,
                code: nil,
                message: "Server returned HTTP \(httpResponse.statusCode)"
            )
        }
        return (bytes, httpResponse)
    }

    func makeAuthenticatedWebSocketTask(
        path: String,
        queryItems: [URLQueryItem] = []
    ) throws -> URLSessionWebSocketTask {
        let httpURL = try url(for: path, queryItems: queryItems)
        guard var components = URLComponents(url: httpURL, resolvingAgainstBaseURL: false) else {
            throw APIClientError.invalidURL(path)
        }
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        guard let webSocketURL = components.url else {
            throw APIClientError.invalidURL(path)
        }
        let request = try makeRequest(
            url: webSocketURL,
            method: .get,
            headers: [:],
            body: nil,
            authorization: .required,
            signing: .none
        )
        return session.webSocketTask(with: request)
    }

    private func makeRequest(
        url: URL,
        method: HTTPMethod,
        headers: [String: String],
        body: Data?,
        authorization: APIAuthorizationPolicy,
        signing: APIRequestSigningPolicy
    ) throws -> URLRequest {
        let requestID = "req_\(UUID().uuidString.lowercased())"
        var request = URLRequest(url: url)
        request.httpMethod = method.rawValue
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if body != nil {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        request.setValue(configuration.appVersion, forHTTPHeaderField: "X-Athena-App-Version")
        request.setValue(configuration.platform, forHTTPHeaderField: "X-Athena-Platform")
        request.setValue(configuration.osVersion, forHTTPHeaderField: "X-Athena-OS-Version")
        request.setValue(requestID, forHTTPHeaderField: "X-Athena-Request-Id")
        for (header, value) in headers {
            request.setValue(value, forHTTPHeaderField: header)
        }

        if let identityHeaders = clientIdentityCenter?.headers(
            requestID: requestID,
            configuration: configuration
        ) {
            for (header, value) in identityHeaders {
                request.setValue(value, forHTTPHeaderField: header)
            }
        }

        if authorization != .none {
            guard let token = authCenter?.accessToken, !token.isEmpty else {
                if authorization == .required {
                    throw APIClientError.authenticationRequired
                }
                return request
            }
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            guard clientIdentityCenter?.clientID != nil else {
                throw APIClientError.clientIdentityRequired
            }
        }

        if signing != .none {
            guard let signingHeaders = try requestSigningCenter?.headers(
                for: request,
                body: body ?? Data(),
                requestID: requestID,
                clientID: clientIdentityCenter?.clientID
            ) else {
                if signing == .required {
                    throw APIClientError.signingUnavailable
                }
                return request
            }
            for (header, value) in signingHeaders {
                request.setValue(value, forHTTPHeaderField: header)
            }
        }

        return request
    }

    private func serverError(status: Int, data: Data) -> APIClientError {
        let payload = try? JSONDecoder().decode(APIErrorEnvelope.self, from: data)
        let code = payload?.code ?? payload?.error
        let message = payload?.message ?? payload?.error
        return .httpStatus(status: status, code: code, message: message)
    }

    private func securityIncident(for error: APIClientError) -> APISecurityIncident? {
        guard case .httpStatus(let status, let code, _) = error else {
            return nil
        }
        switch code {
        case "CLIENT_REVOKED":
            return .clientRevoked
        case "INVALID_SIGNATURE":
            return .invalidSignature
        case "SIGNING_SECRET_ROTATED":
            return .signingSecretRotated
        default:
            return status == 401 || status == 403 ? .sessionExpired : nil
        }
    }

#if DEBUG
    private func debugRequestLog(
        requestID: String,
        method: HTTPMethod,
        outcome: String,
        status: Int?,
        code: String?,
        attempt: Int
    ) {
        let statusText = status.map(String.init) ?? "none"
        let codeText = code ?? "none"
        print(
            "[AthenaNetwork] request=\(requestID) method=\(method.rawValue) outcome=\(outcome) status=\(statusText) code=\(codeText) attempt=\(attempt)"
        )
    }

    private func errorCode(for error: APIClientError) -> String? {
        guard case .httpStatus(_, let code, _) = error else { return nil }
        return code
    }
#endif
}
