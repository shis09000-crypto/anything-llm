import CryptoKit
import Foundation
import Observation

private struct SigningSecretResponse: Decodable {
    let success: Bool
    let signingSecret: String
    let signatureVersion: String?
    let signingSecretVersion: String?
}

@MainActor
@Observable
final class RequestSigningCenter {
    enum Status: Equatable {
        case missingDeviceKey
        case missingSigningSecret
        case ready

        var displayTitle: String {
            switch self {
            case .missingDeviceKey:
                "Device Key Needed"
            case .missingSigningSecret:
                "Signing Secret Needed"
            case .ready:
                "Ready"
            }
        }
    }

    private enum Keys {
        static let devicePrivateKey = "requestSigning.devicePrivateKey"
        static let signingSecret = "requestSigning.secret"
        static let signingSecretVersion = "requestSigning.secretVersion"
    }

    private let secureStore: SecureValueStore
    private var privateKey: P256.Signing.PrivateKey?
    private var signingSecret: String?

    var status: Status = .missingDeviceKey
    var preferredSignatureVersion = "v2-device-p256"
    var signingSecretPath = "/api/client-identity/signing-secret"
    var signingHeaders: [String: String] = [:]
    var signingSecretVersion: String?

    init(secureStore: SecureValueStore) {
        self.secureStore = secureStore
    }

    func applyBootstrap(_ bootstrap: NativeAppBootstrap?) {
        preferredSignatureVersion = bootstrap?.security.preferredSignatureVersion ?? "v2-device-p256"
        signingSecretPath = bootstrap?.security.signingSecretPath ?? "/api/client-identity/signing-secret"
        signingHeaders = bootstrap?.security.requestSigningHeaders ?? [:]
    }

    func prepareDeviceKey() throws {
        if let data = try secureStore.data(forKey: Keys.devicePrivateKey) {
            privateKey = try P256.Signing.PrivateKey(rawRepresentation: data)
        } else {
            let generated = P256.Signing.PrivateKey()
            try secureStore.setData(generated.rawRepresentation, forKey: Keys.devicePrivateKey)
            privateKey = generated
        }

        if let data = try secureStore.data(forKey: Keys.signingSecret) {
            signingSecret = String(data: data, encoding: .utf8)
        }
        if let data = try secureStore.data(forKey: Keys.signingSecretVersion) {
            signingSecretVersion = String(data: data, encoding: .utf8)
        }
        updateStatus()
    }

    func refreshSigningSecret(using apiClient: APIClient) async throws {
        let response = try await apiClient.requestJSON(
            SigningSecretResponse.self,
            method: .post,
            path: signingSecretPath,
            body: EmptyRequestBody(),
            authorization: .required,
            signing: .none
        )
        guard response.success else {
            throw APIClientError.signingUnavailable
        }

        signingSecret = response.signingSecret
        signingSecretVersion = response.signingSecretVersion
        try secureStore.setData(Data(response.signingSecret.utf8), forKey: Keys.signingSecret)
        if let signingSecretVersion {
            try secureStore.setData(Data(signingSecretVersion.utf8), forKey: Keys.signingSecretVersion)
        }
        updateStatus()
    }

    func clearSigningSecret() throws {
        signingSecret = nil
        signingSecretVersion = nil
        try secureStore.removeData(forKey: Keys.signingSecret)
        try secureStore.removeData(forKey: Keys.signingSecretVersion)
        updateStatus()
    }

    func resetDeviceKey() throws {
        privateKey = nil
        try secureStore.removeData(forKey: Keys.devicePrivateKey)
        try clearSigningSecret()
        status = .missingDeviceKey
    }

    func headers(
        for request: URLRequest,
        body: Data,
        requestID: String,
        clientID: String?
    ) throws -> [String: String]? {
        guard let privateKey, let clientID, let url = request.url else {
            return nil
        }

        let timestamp = String(Int64(Date().timeIntervalSince1970 * 1_000))
        let nonce = UUID().uuidString.lowercased()
        let bodyHash = SHA256.hash(data: body).data.base64URLEncodedString()
        let canonicalPath = url.path + (url.query.map { "?\($0)" } ?? "")
        let canonical = [
            "ATHENA-DEVICE-SIGN-V1",
            request.httpMethod?.uppercased() ?? "GET",
            canonicalPath,
            timestamp,
            nonce,
            requestID,
            clientID,
            bodyHash,
        ].joined(separator: "\n")
        let signature = try privateKey.signature(for: Data(canonical.utf8))

        return [
            headerName(for: "timestamp", fallback: "X-Athena-Timestamp"): timestamp,
            headerName(for: "nonce", fallback: "X-Athena-Nonce"): nonce,
            headerName(for: "bodySha256", fallback: "X-Athena-Body-SHA256"): bodyHash,
            headerName(for: "signature", fallback: "X-Athena-Signature"): signature.rawRepresentation.base64URLEncodedString(),
            headerName(for: "signatureVersion", fallback: "X-Athena-Signature-Version"): preferredSignatureVersion,
            headerName(for: "devicePublicKey", fallback: "X-Athena-Device-Public-Key"): try publicJWK(for: privateKey.publicKey),
            headerName(for: "deviceKeyAlgorithm", fallback: "X-Athena-Device-Key-Algorithm"): "p256-v1",
        ]
    }

    func signedWebSocketMessage<Payload: Encodable>(
        payload: Payload,
        url: URL,
        clientID: String?
    ) throws -> Data {
        guard let privateKey, let clientID else {
            throw APIClientError.signingUnavailable
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let payloadData = try encoder.encode(payload)
        let timestamp = String(Int64(Date().timeIntervalSince1970 * 1_000))
        let nonce = UUID().uuidString.lowercased()
        let requestID = "ws_\(UUID().uuidString.lowercased())"
        let bodyHash = SHA256.hash(data: payloadData).data.base64URLEncodedString()
        let canonical = [
            "ATHENA-DEVICE-SIGN-V1",
            "WS",
            url.path.isEmpty ? "/" : url.path,
            timestamp,
            nonce,
            requestID,
            clientID,
            bodyHash,
        ].joined(separator: "\n")
        let signature = try privateKey.signature(for: Data(canonical.utf8))
        let signed = WebSocketSignedMetadata(
            clientId: clientID,
            requestId: requestID,
            timestamp: timestamp,
            nonce: nonce,
            bodySha256: bodyHash,
            signature: signature.rawRepresentation.base64URLEncodedString(),
            devicePublicKey: try publicJWK(for: privateKey.publicKey),
            deviceKeyAlgorithm: "p256-v1"
        )
        return try encoder.encode(
            WebSocketSignedEnvelope(
                type: "athenaSignedMessage",
                signatureVersion: preferredSignatureVersion,
                signed: signed,
                payload: payload
            )
        )
    }

    private func updateStatus() {
        if privateKey == nil {
            status = .missingDeviceKey
        } else if signingSecret == nil {
            status = .missingSigningSecret
        } else {
            status = .ready
        }
    }

    private func publicJWK(for key: P256.Signing.PublicKey) throws -> String {
        let representation = key.x963Representation
        guard representation.count == 65, representation.first == 0x04 else {
            throw APIClientError.signingUnavailable
        }

        let x = representation[representation.index(after: representation.startIndex)..<representation.index(representation.startIndex, offsetBy: 33)]
        let y = representation[representation.index(representation.startIndex, offsetBy: 33)..<representation.endIndex]
        let jwk: [String: Any] = [
            "kty": "EC",
            "crv": "P-256",
            "x": Data(x).base64URLEncodedString(),
            "y": Data(y).base64URLEncodedString(),
            "ext": true,
            "key_ops": ["verify"],
        ]
        let data = try JSONSerialization.data(withJSONObject: jwk, options: [.sortedKeys])
        guard let string = String(data: data, encoding: .utf8) else {
            throw APIClientError.signingUnavailable
        }
        return string
    }

    private func headerName(for key: String, fallback: String) -> String {
        signingHeaders[key] ?? fallback
    }
}

private struct WebSocketSignedEnvelope<Payload: Encodable>: Encodable {
    let type: String
    let signatureVersion: String
    let signed: WebSocketSignedMetadata
    let payload: Payload
}

private struct WebSocketSignedMetadata: Encodable {
    let clientId: String
    let requestId: String
    let timestamp: String
    let nonce: String
    let bodySha256: String
    let signature: String
    let devicePublicKey: String
    let deviceKeyAlgorithm: String
}

private struct EmptyRequestBody: Encodable {}

private extension Digest {
    var data: Data { Data(self) }
}

private extension Data {
    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
