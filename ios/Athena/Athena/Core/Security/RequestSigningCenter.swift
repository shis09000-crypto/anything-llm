import CryptoKit
import Foundation
import Observation

private struct SigningSecretResponse: Decodable {
    let success: Bool
    let signingSecret: String
    let signatureVersion: String?
    let signingSecretVersion: String?
}

private struct DeviceKeyRotationRequest: Encodable {
    let publicKey: String
    let deviceKeyAlgorithm: String
}

private struct DeviceKeyRotationResponse: Decodable {
    let success: Bool
    let rotated: Bool
    let prepared: Bool?
    let deviceKeyAlgorithm: String
}

private enum AthenaDeviceSigningKey {
    case software(P256.Signing.PrivateKey)
    case secureEnclave(SecureEnclave.P256.Signing.PrivateKey)

    var publicKey: P256.Signing.PublicKey {
        switch self {
        case .software(let key): key.publicKey
        case .secureEnclave(let key): key.publicKey
        }
    }

    var algorithm: String {
        switch self {
        case .software: "p256-software-v1"
        case .secureEnclave: "p256-secure-enclave-v1"
        }
    }

    func signature(for data: Data) throws -> P256.Signing.ECDSASignature {
        switch self {
        case .software(let key): try key.signature(for: data)
        case .secureEnclave(let key): try key.signature(for: data)
        }
    }
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
        static let secureEnclaveKeyReference = "requestSigning.secureEnclaveKeyReference"
        static let secureEnclaveRotationPending = "requestSigning.secureEnclaveRotationPending"
        static let signingSecret = "requestSigning.secret"
        static let signingSecretVersion = "requestSigning.secretVersion"
    }

    private let secureStore: SecureValueStore
    private var privateKey: AthenaDeviceSigningKey?
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
        if let data = try secureStore.data(forKey: Keys.secureEnclaveKeyReference) {
            guard SecureEnclave.isAvailable else {
                throw APIClientError.signingUnavailable
            }
            privateKey = .secureEnclave(
                try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: data)
            )
        } else if let data = try secureStore.data(forKey: Keys.devicePrivateKey) {
            privateKey = .software(try P256.Signing.PrivateKey(rawRepresentation: data))
        } else if SecureEnclave.isAvailable {
            var accessError: Unmanaged<CFError>?
            guard let accessControl = SecAccessControlCreateWithFlags(
                nil,
                kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
                .privateKeyUsage,
                &accessError
            ) else {
                throw APIClientError.signingUnavailable
            }
            let generated = try SecureEnclave.P256.Signing.PrivateKey(
                accessControl: accessControl
            )
            try secureStore.setData(
                generated.dataRepresentation,
                forKey: Keys.secureEnclaveKeyReference
            )
            privateKey = .secureEnclave(generated)
        } else {
            let generated = P256.Signing.PrivateKey()
            try secureStore.setData(generated.rawRepresentation, forKey: Keys.devicePrivateKey)
            privateKey = .software(generated)
        }

        if let data = try secureStore.data(forKey: Keys.signingSecret) {
            signingSecret = String(data: data, encoding: .utf8)
        }
        if let data = try secureStore.data(forKey: Keys.signingSecretVersion) {
            signingSecretVersion = String(data: data, encoding: .utf8)
        }
        updateStatus()
    }

    func migrateDeviceKeyToSecureEnclave(using apiClient: APIClient) async throws -> Bool {
        if try secureStore.data(forKey: Keys.secureEnclaveRotationPending) != nil,
           let currentKey = privateKey,
           case .secureEnclave = currentKey
        {
            let request = DeviceKeyRotationRequest(
                publicKey: try publicJWK(for: currentKey.publicKey),
                deviceKeyAlgorithm: currentKey.algorithm
            )
            do {
                let response = try await commitDeviceKeyRotation(
                    request,
                    using: apiClient
                )
                try secureStore.removeData(forKey: Keys.secureEnclaveRotationPending)
                try secureStore.removeData(forKey: Keys.devicePrivateKey)
                return response.rotated
            } catch APIClientError.httpStatus(let status, _, _) where status == 409 {
                if let legacy = try secureStore.data(forKey: Keys.devicePrivateKey) {
                    privateKey = .software(
                        try P256.Signing.PrivateKey(rawRepresentation: legacy)
                    )
                    try secureStore.removeData(forKey: Keys.secureEnclaveKeyReference)
                    try secureStore.removeData(forKey: Keys.secureEnclaveRotationPending)
                }
                throw APIClientError.signingUnavailable
            }
        }
        guard let currentKey = privateKey,
              case .software = currentKey,
              SecureEnclave.isAvailable else {
            return false
        }
        var accessError: Unmanaged<CFError>?
        guard let accessControl = SecAccessControlCreateWithFlags(
            nil,
            kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            .privateKeyUsage,
            &accessError
        ) else {
            throw APIClientError.signingUnavailable
        }
        let candidate = try SecureEnclave.P256.Signing.PrivateKey(
            accessControl: accessControl
        )
        let request = DeviceKeyRotationRequest(
            publicKey: try publicJWK(for: candidate.publicKey),
            deviceKeyAlgorithm: "p256-secure-enclave-v1"
        )
        let prepared = try await apiClient.requestJSON(
            DeviceKeyRotationResponse.self,
            method: .post,
            path: "/api/client-identity/device-key-rotation/prepare",
            body: request,
            authorization: .required,
            signing: .required
        )
        guard prepared.success,
              prepared.deviceKeyAlgorithm == "p256-secure-enclave-v1" else {
            throw APIClientError.signingUnavailable
        }
        try secureStore.setData(
            candidate.dataRepresentation,
            forKey: Keys.secureEnclaveKeyReference
        )
        try secureStore.setData(
            Data("pending".utf8),
            forKey: Keys.secureEnclaveRotationPending
        )
        privateKey = .secureEnclave(candidate)
        let response: DeviceKeyRotationResponse
        do {
            response = try await commitDeviceKeyRotation(request, using: apiClient)
        } catch APIClientError.httpStatus(let status, _, _) where status == 409 {
            privateKey = currentKey
            try secureStore.removeData(forKey: Keys.secureEnclaveKeyReference)
            try secureStore.removeData(forKey: Keys.secureEnclaveRotationPending)
            throw APIClientError.signingUnavailable
        }
        guard response.success,
              response.deviceKeyAlgorithm == "p256-secure-enclave-v1" else {
            privateKey = currentKey
            try secureStore.removeData(forKey: Keys.secureEnclaveKeyReference)
            throw APIClientError.signingUnavailable
        }
        try secureStore.removeData(forKey: Keys.devicePrivateKey)
        try secureStore.removeData(forKey: Keys.secureEnclaveRotationPending)
        return response.rotated
    }

    private func commitDeviceKeyRotation(
        _ request: DeviceKeyRotationRequest,
        using apiClient: APIClient
    ) async throws -> DeviceKeyRotationResponse {
        try await apiClient.requestJSON(
            DeviceKeyRotationResponse.self,
            method: .post,
            path: "/api/client-identity/device-key-rotation/commit",
            body: request,
            authorization: .required,
            signing: .required,
            retryOnConnectionLoss: true
        )
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
        try secureStore.removeData(forKey: Keys.secureEnclaveKeyReference)
        try secureStore.removeData(forKey: Keys.secureEnclaveRotationPending)
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
            headerName(for: "deviceKeyAlgorithm", fallback: "X-Athena-Device-Key-Algorithm"): privateKey.algorithm,
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
            deviceKeyAlgorithm: privateKey.algorithm
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
