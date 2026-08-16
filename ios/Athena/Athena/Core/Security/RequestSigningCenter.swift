import CryptoKit
import Foundation
import Observation

@available(iOS 26.0, *)
private final class AthenaHighRiskPQSigner {
    let privateKey: SecureEnclave.MLDSA65.PrivateKey

    init(dataRepresentation: Data?) throws {
        if let dataRepresentation {
            privateKey = try SecureEnclave.MLDSA65.PrivateKey(
                dataRepresentation: dataRepresentation
            )
        } else {
            privateKey = try SecureEnclave.MLDSA65.PrivateKey()
        }
    }

    var dataRepresentation: Data { privateKey.dataRepresentation }
    var publicKey: Data { privateKey.publicKey.rawRepresentation }

    func signature(for data: Data) throws -> Data {
        try privateKey.signature(for: data)
    }
}

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

struct DeviceBindingP256Proof: Codable, Equatable {
    let publicKey: String
    let keyAlgorithm: String
    let signature: String
}

struct DeviceBindingPostQuantumProof: Codable, Equatable {
    let publicKey: String
    let keyAlgorithm: String
    let hybridSignatureVersion: String
    let signature: String
}

struct DeviceBindingAssertion: Codable, Equatable {
    let challengeId: String
    let challenge: String
    let p256: DeviceBindingP256Proof
    let postQuantum: DeviceBindingPostQuantumProof
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
        case .software: AthenaCryptoSuiteRegistry.deviceP256SoftwareV1
        case .secureEnclave: AthenaCryptoSuiteRegistry.deviceP256SecureEnclaveV1
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
    typealias PostQuantumTestSignatureProvider =
        (_ payload: Data) throws -> (signature: Data, publicKey: Data)

    enum Status: Equatable {
        case missingDeviceKey
        case missingSigningSecret
        case postQuantumContractUnavailable
        case ready

        var displayTitle: String {
            switch self {
            case .missingDeviceKey:
                "Device Key Needed"
            case .missingSigningSecret:
                "Signing Secret Needed"
            case .postQuantumContractUnavailable:
                "Post-Quantum Contract Required"
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
        static let highRiskPQKeyReference = "requestSigning.highRiskPQKeyReference"
    }

    private let secureStore: SecureValueStore
    private var privateKey: AthenaDeviceSigningKey?
    private var signingSecret: String?
    private var highRiskPQSigner: Any?
    private let postQuantumTestSignatureProvider:
        PostQuantumTestSignatureProvider?
    private var cryptoSuites = AthenaCryptoSuiteRegistry.fallbackSuites
    private var pqHighRiskRequired = false
    private var pqHighRiskAvailable = false
    private(set) var postQuantumContractReady = false

    var status: Status = .missingDeviceKey
    var preferredSignatureVersion = AthenaCryptoSuiteRegistry.requestDeviceP256V2
    var signingSecretPath = "/api/client-identity/signing-secret"
    var signingHeaders: [String: String] = [:]
    var signingSecretVersion: String?

    init(
        secureStore: SecureValueStore,
        postQuantumTestSignatureProvider:
            PostQuantumTestSignatureProvider? = nil
    ) {
        self.secureStore = secureStore
        self.postQuantumTestSignatureProvider =
            postQuantumTestSignatureProvider
    }

    func applyBootstrap(_ bootstrap: NativeAppBootstrap?) {
        if let advertised = bootstrap?.security.cryptoSuites, !advertised.isEmpty {
            cryptoSuites = advertised
        }
        let policy = bootstrap?.security.highRiskRequestSigning
        pqHighRiskRequired =
            policy?.enforcementMode == "required" &&
            policy?.hardwareBackedPostQuantumKeyRequired == true
        preferredSignatureVersion = AthenaCryptoSuiteRegistry.preferredRequestSignature(
            serverPreferred: bootstrap?.security.preferredSignatureVersion,
            suites: cryptoSuites
        ).suiteId
        let expectedRegistry =
            bootstrap?.security.cryptoSuiteRegistryVersion ==
            AthenaCryptoSuiteRegistry.registryVersion
        let expectedPolicy =
            policy?.classicalSuiteId == AthenaCryptoSuiteRegistry.requestDeviceP256V2 &&
            policy?.postQuantumSuiteId == AthenaCryptoSuiteRegistry.requestDeviceMLDSA65V1 &&
            policy?.hybridSuiteId == AthenaCryptoSuiteRegistry.deviceHybridP256MLDSA65V1
        pqHighRiskAvailable = expectedRegistry && expectedPolicy && cryptoSuites.contains {
            $0.suiteId == policy?.postQuantumSuiteId &&
                $0.status == "active"
        } && cryptoSuites.contains {
            $0.suiteId == policy?.hybridSuiteId &&
                $0.status == "active"
        }
        postQuantumContractReady =
            pqHighRiskRequired &&
            pqHighRiskAvailable &&
            Self.isVersion(
                policy?.minimumOSVersion,
                atLeast: "26.0"
            )
        signingSecretPath = bootstrap?.security.signingSecretPath ?? "/api/client-identity/signing-secret"
        signingHeaders = bootstrap?.security.requestSigningHeaders ?? [:]
        updateStatus()
    }

    private static func isVersion(
        _ value: String?,
        atLeast minimum: String
    ) -> Bool {
        guard let value else { return false }
        let current = value.split(separator: ".").map {
            Int($0.prefix { $0.isNumber }) ?? 0
        }
        let required = minimum.split(separator: ".").map {
            Int($0.prefix { $0.isNumber }) ?? 0
        }
        let width = max(current.count, required.count)
        for index in 0..<width {
            let lhs = current.indices.contains(index) ? current[index] : 0
            let rhs = required.indices.contains(index) ? required[index] : 0
            if lhs != rhs {
                return lhs > rhs
            }
        }
        return true
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

    func deviceBindingAssertion(
        challengeId: String,
        challenge: String,
        clientID: String
    ) throws -> DeviceBindingAssertion {
        guard let privateKey else { throw APIClientError.signingUnavailable }
        guard postQuantumContractReady else {
            throw APIClientError.postQuantumSigningUnavailable
        }
        let proof = [
            "athena-device-binding-preflight:v1",
            challengeId,
            challenge,
            clientID,
        ].joined(separator: "\n")
        let payload = Data(proof.utf8)
        let p256Signature = try privateKey.signature(for: payload)
        let pqMaterial: (signature: Data, publicKey: Data)
        if let postQuantumTestSignatureProvider {
            pqMaterial = try postQuantumTestSignatureProvider(payload)
        } else {
            guard #available(iOS 26.0, *), SecureEnclave.isAvailable else {
                throw APIClientError.postQuantumSigningUnavailable
            }
            let signer = try highRiskSigner()
            pqMaterial = (
                signature: try signer.signature(for: payload),
                publicKey: signer.publicKey
            )
        }
        return DeviceBindingAssertion(
            challengeId: challengeId,
            challenge: challenge,
            p256: DeviceBindingP256Proof(
                publicKey: try publicJWK(for: privateKey.publicKey),
                keyAlgorithm: privateKey.algorithm,
                signature: p256Signature.rawRepresentation.base64URLEncodedString()
            ),
            postQuantum: DeviceBindingPostQuantumProof(
                publicKey: pqMaterial.publicKey.base64URLEncodedString(),
                keyAlgorithm: AthenaCryptoSuiteRegistry.requestDeviceMLDSA65V1,
                hybridSignatureVersion: AthenaCryptoSuiteRegistry.deviceHybridP256MLDSA65V1,
                signature: pqMaterial.signature.base64URLEncodedString()
            )
        )
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
            deviceKeyAlgorithm: AthenaCryptoSuiteRegistry.deviceP256SecureEnclaveV1
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
              prepared.deviceKeyAlgorithm == AthenaCryptoSuiteRegistry.deviceP256SecureEnclaveV1 else {
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
              response.deviceKeyAlgorithm == AthenaCryptoSuiteRegistry.deviceP256SecureEnclaveV1 else {
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
        try secureStore.removeData(forKey: Keys.highRiskPQKeyReference)
        try clearSigningSecret()
        status = .missingDeviceKey
    }

    func headers(
        for request: URLRequest,
        body: Data,
        requestID: String,
        clientID: String?,
        requirePostQuantum: Bool = false
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

        var headers = [
            headerName(for: "timestamp", fallback: "X-Athena-Timestamp"): timestamp,
            headerName(for: "nonce", fallback: "X-Athena-Nonce"): nonce,
            headerName(for: "bodySha256", fallback: "X-Athena-Body-SHA256"): bodyHash,
            headerName(for: "signature", fallback: "X-Athena-Signature"): signature.rawRepresentation.base64URLEncodedString(),
            headerName(for: "signatureVersion", fallback: "X-Athena-Signature-Version"): preferredSignatureVersion,
            headerName(for: "devicePublicKey", fallback: "X-Athena-Device-Public-Key"): try publicJWK(for: privateKey.publicKey),
            headerName(for: "deviceKeyAlgorithm", fallback: "X-Athena-Device-Key-Algorithm"): privateKey.algorithm,
        ]
        if requirePostQuantum {
            guard postQuantumContractReady else {
                throw APIClientError.postQuantumSigningUnavailable
            }
            let pqPayload = Data(canonical.utf8)
            let pqMaterial: (signature: Data, publicKey: Data)
            if let postQuantumTestSignatureProvider {
                pqMaterial = try postQuantumTestSignatureProvider(pqPayload)
            } else {
                guard #available(iOS 26.0, *), SecureEnclave.isAvailable else {
                    throw APIClientError.postQuantumSigningUnavailable
                }
                let signer = try highRiskSigner()
                pqMaterial = (
                    signature: try signer.signature(for: pqPayload),
                    publicKey: signer.publicKey
                )
            }
            headers[
                headerName(
                    for: "hybridSignatureVersion",
                    fallback: "X-Athena-Hybrid-Signature-Version"
                )
            ] = AthenaCryptoSuiteRegistry.deviceHybridP256MLDSA65V1
            headers[
                headerName(
                    for: "pqSignature",
                    fallback: "X-Athena-PQ-Signature"
                )
            ] = pqMaterial.signature.base64URLEncodedString()
            headers[
                headerName(
                    for: "pqPublicKey",
                    fallback: "X-Athena-PQ-Public-Key"
                )
            ] = pqMaterial.publicKey.base64URLEncodedString()
            headers[
                headerName(
                    for: "pqKeyAlgorithm",
                    fallback: "X-Athena-PQ-Key-Algorithm"
                )
            ] = AthenaCryptoSuiteRegistry.requestDeviceMLDSA65V1
            headers[
                headerName(
                    for: "pqKeyOrigin",
                    fallback: "X-Athena-PQ-Key-Origin"
                )
            ] = "apple-secure-enclave-ios26"
            headers[
                headerName(
                    for: "pqHardwareProtection",
                    fallback: "X-Athena-PQ-Hardware-Protection"
                )
            ] = "secure-enclave"
        }
        return headers
    }

    @available(iOS 26.0, *)
    private func highRiskSigner() throws -> AthenaHighRiskPQSigner {
        if let signer = highRiskPQSigner as? AthenaHighRiskPQSigner {
            return signer
        }
        guard SecureEnclave.isAvailable else {
            throw APIClientError.signingUnavailable
        }
        let stored = try secureStore.data(forKey: Keys.highRiskPQKeyReference)
        let signer = try AthenaHighRiskPQSigner(dataRepresentation: stored)
        if stored == nil {
            try secureStore.setData(
                signer.dataRepresentation,
                forKey: Keys.highRiskPQKeyReference
            )
        }
        highRiskPQSigner = signer
        return signer
    }

    func signedWebSocketMessage<Payload: Encodable>(
        payload: Payload,
        url: URL,
        clientID: String?
    ) throws -> Data {
        guard let privateKey, let clientID else {
            throw APIClientError.signingUnavailable
        }
        guard postQuantumContractReady else {
            throw APIClientError.postQuantumSigningUnavailable
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
        let canonicalData = Data(canonical.utf8)
        let signature = try privateKey.signature(for: canonicalData)
        let pqMaterial: (signature: Data, publicKey: Data)
        if let postQuantumTestSignatureProvider {
            pqMaterial = try postQuantumTestSignatureProvider(canonicalData)
        } else {
            guard #available(iOS 26.0, *), SecureEnclave.isAvailable else {
                throw APIClientError.postQuantumSigningUnavailable
            }
            let signer = try highRiskSigner()
            pqMaterial = (
                signature: try signer.signature(for: canonicalData),
                publicKey: signer.publicKey
            )
        }
        let signed = WebSocketSignedMetadata(
            clientId: clientID,
            requestId: requestID,
            timestamp: timestamp,
            nonce: nonce,
            bodySha256: bodyHash,
            signature: signature.rawRepresentation.base64URLEncodedString(),
            devicePublicKey: try publicJWK(for: privateKey.publicKey),
            deviceKeyAlgorithm: privateKey.algorithm,
            hybridSignatureVersion: AthenaCryptoSuiteRegistry.deviceHybridP256MLDSA65V1,
            pqSignature: pqMaterial.signature.base64URLEncodedString(),
            pqPublicKey: pqMaterial.publicKey.base64URLEncodedString(),
            pqKeyAlgorithm: AthenaCryptoSuiteRegistry.requestDeviceMLDSA65V1
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
        if !postQuantumContractReady {
            status = .postQuantumContractUnavailable
        } else if privateKey == nil {
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
    let hybridSignatureVersion: String
    let pqSignature: String
    let pqPublicKey: String
    let pqKeyAlgorithm: String
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
