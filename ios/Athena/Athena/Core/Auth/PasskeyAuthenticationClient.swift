import AuthenticationServices
import CryptoKit
import Foundation
import UIKit

enum PasskeyAuthenticationError: LocalizedError, Equatable {
    case unavailable
    case cancelled
    case invalidCallback
    case authorization(String)

    var errorDescription: String? {
        switch self {
        case .unavailable:
            "此设备尚未配置通行密钥登录。"
        case .cancelled:
            ""
        case .invalidCallback:
            "通行密钥登录回调无效。"
        case .authorization(let message):
            message
        }
    }
}

enum NativeWebPasskeyPurpose: String, Sendable {
    case login
    case quickLoginEnrollment = "zk_enroll"
    case sensitiveMemoryReveal = "sensitive_memory_reveal"
}

struct NativeWebPasskeyResult: Sendable {
    let user: AthenaUser?
    let token: String?
    let reauthToken: String?
}

private struct NativeWebPasskeyExchangeRequest: Encodable {
    let code: String
    let codeVerifier: String
}

private struct NativeWebPasskeyExchangeResponse: Decodable {
    let valid: Bool
    let user: AthenaUser?
    let token: String?
    let reauthToken: String?
    let purpose: String?
    let message: String?
}

private struct NativePasskeyRegistrationStartRequest: Encodable {
    let state: String
    let codeChallenge: String
}

private struct NativePasskeyRegistrationStartResponse: Decodable {
    let success: Bool
    let startUrl: String?
    let expiresInSeconds: Int?
    let error: String?
}

private struct NativePasskeyRegistrationExchangeResponse: Decodable {
    let success: Bool
    let error: String?
}

private struct NativeWebPasskeyChallenge {
    let state: String
    let verifier: String

    var codeChallenge: String {
        base64URLEncoded(Data(SHA256.hash(data: Data(verifier.utf8))))
    }

    static func make() -> NativeWebPasskeyChallenge {
        NativeWebPasskeyChallenge(
            state: randomURLSafeString(byteCount: 32),
            verifier: randomURLSafeString(byteCount: 48)
        )
    }

    private static func randomURLSafeString(byteCount: Int) -> String {
        var bytes = [UInt8](repeating: 0, count: byteCount)
        _ = SecRandomCopyBytes(kSecRandomDefault, byteCount, &bytes)
        return base64URLEncoded(Data(bytes))
    }
}

/// Temporary browser-based passkey transport. The WebAuthn ceremony remains on
/// the Athena HTTPS origin; this client only receives an opaque PKCE-protected code.
@MainActor
final class PasskeyAuthenticationClient: NSObject {
    private var session: ASWebAuthenticationSession?
    private var continuation: CheckedContinuation<URL, Error>?

    func performNativeHandoff(
        purpose: NativeWebPasskeyPurpose,
        using apiClient: APIClient
    ) async throws -> NativeWebPasskeyResult {
        let challenge = NativeWebPasskeyChallenge.make()
        let startURL = try apiClient.url(
            for: "/api/auth/passkeys/native-web",
            queryItems: [
                URLQueryItem(name: "state", value: challenge.state),
                URLQueryItem(name: "code_challenge", value: challenge.codeChallenge),
                URLQueryItem(name: "code_challenge_method", value: "S256"),
                URLQueryItem(name: "purpose", value: purpose.rawValue),
            ]
        )
        let callbackURL = try await authenticate(startURL: startURL)
        guard
            callbackURL.scheme == "athena",
            callbackURL.host == "auth",
            callbackURL.path == "/callback",
            let components = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false),
            let callbackState = components.queryItems?.first(where: { $0.name == "state" })?.value,
            callbackState == challenge.state
        else {
            throw PasskeyAuthenticationError.invalidCallback
        }
        if components.queryItems?.contains(where: {
            $0.name == "error" && $0.value == "passkey_failed"
        }) == true {
            throw PasskeyAuthenticationError.authorization(
                "通行密钥验证失败，请使用账号密码验证。"
            )
        }
        guard let code = components.queryItems?.first(where: { $0.name == "code" })?.value,
              !code.isEmpty else {
            throw PasskeyAuthenticationError.invalidCallback
        }

        let response = try await apiClient.requestJSON(
            NativeWebPasskeyExchangeResponse.self,
            method: .post,
            path: "/api/auth/passkeys/native-web/exchange",
            body: NativeWebPasskeyExchangeRequest(
                code: code,
                codeVerifier: challenge.verifier
            ),
            authorization: .none,
            signing: .none,
            retryOnConnectionLoss: true
        )
        let purposeMatches = response.purpose == purpose.rawValue
            || (purpose == .login && response.purpose == nil)
        guard response.valid, purposeMatches else {
            throw PasskeyAuthenticationError.authorization(
                response.message ?? "无法验证通行密钥。"
            )
        }
        return NativeWebPasskeyResult(
            user: response.user,
            token: response.token,
            reauthToken: response.reauthToken
        )
    }

    func registerPasskey(using apiClient: APIClient) async throws {
        let challenge = NativeWebPasskeyChallenge.make()
        let start = try await apiClient.requestJSON(
            NativePasskeyRegistrationStartResponse.self,
            method: .post,
            path: "/api/auth/passkeys/native-register/start",
            body: NativePasskeyRegistrationStartRequest(
                state: challenge.state,
                codeChallenge: challenge.codeChallenge
            ),
            authorization: .required,
            signing: .required,
            retryOnConnectionLoss: true
        )
        guard start.success,
              let startURLString = start.startUrl,
              let startURL = URL(string: startURLString) else {
            throw PasskeyAuthenticationError.authorization(
                start.error ?? "无法启动通行密钥注册。"
            )
        }
        let callbackURL = try await authenticate(startURL: startURL)
        guard
            callbackURL.scheme == "athena",
            callbackURL.host == "auth",
            callbackURL.path == "/callback",
            let components = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false),
            let callbackState = components.queryItems?.first(where: { $0.name == "state" })?.value,
            callbackState == challenge.state
        else {
            throw PasskeyAuthenticationError.invalidCallback
        }
        if components.queryItems?.contains(where: {
            $0.name == "error" && $0.value == "passkey_registration_failed"
        }) == true {
            throw PasskeyAuthenticationError.authorization(
                "通行密钥注册失败，请稍后重试。"
            )
        }
        guard let code = components.queryItems?.first(where: { $0.name == "code" })?.value,
              !code.isEmpty else {
            throw PasskeyAuthenticationError.invalidCallback
        }
        let exchange = try await apiClient.requestJSON(
            NativePasskeyRegistrationExchangeResponse.self,
            method: .post,
            path: "/api/auth/passkeys/native-register/exchange",
            body: NativeWebPasskeyExchangeRequest(
                code: code,
                codeVerifier: challenge.verifier
            ),
            authorization: .required,
            signing: .required,
            retryOnConnectionLoss: true
        )
        guard exchange.success else {
            throw PasskeyAuthenticationError.authorization(
                exchange.error ?? "无法确认通行密钥注册。"
            )
        }
    }

    private func authenticate(startURL: URL) async throws -> URL {
        guard session == nil, continuation == nil else {
            throw PasskeyAuthenticationError.authorization("通行密钥登录已在进行中。")
        }

        return try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            let session = ASWebAuthenticationSession(
                url: startURL,
                callback: .customScheme("athena")
            ) { [weak self] callbackURL, error in
                Task { @MainActor in
                    guard let self else { return }
                    if let error {
                        if let sessionError = error as? ASWebAuthenticationSessionError,
                           sessionError.code == .canceledLogin
                        {
                            self.complete(.failure(PasskeyAuthenticationError.cancelled))
                        } else {
                            self.complete(.failure(PasskeyAuthenticationError.authorization(error.localizedDescription)))
                        }
                        return
                    }
                    guard let callbackURL else {
                        self.complete(.failure(PasskeyAuthenticationError.invalidCallback))
                        return
                    }
                    self.complete(.success(callbackURL))
                }
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = false
            self.session = session
            if !session.start() {
                self.complete(.failure(PasskeyAuthenticationError.authorization("无法启动通行密钥登录。")))
            }
        }
    }

    private func complete(_ result: Result<URL, Error>) {
        guard let continuation else { return }
        self.continuation = nil
        self.session = nil
        continuation.resume(with: result)
    }
}

extension PasskeyAuthenticationClient: ASWebAuthenticationPresentationContextProviding {
    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            guard let scene = UIApplication.shared.connectedScenes
                .compactMap({ $0 as? UIWindowScene })
                .first(where: { $0.activationState == .foregroundActive }) else {
                preconditionFailure("A web authentication session requires an active window scene.")
            }
            return scene.windows.first(where: { $0.isKeyWindow })
                ?? UIWindow(windowScene: scene)
        }
    }
}

private func base64URLEncoded(_ data: Data) -> String {
    data.base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}
