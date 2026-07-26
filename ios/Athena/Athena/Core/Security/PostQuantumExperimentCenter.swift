import CryptoKit
import Foundation

/// Isolated iOS 26 post-quantum experiments. None of these envelopes grant a
/// session, device trust or Vault access; production authorization continues
/// to use the existing P-256 and server policy paths.
@available(iOS 26.0, *)
enum PostQuantumExperimentCenter {
    static let envelopeVersion = "athena-pq-experiment:v1"

    struct CapabilityReport: Equatable, Sendable {
        let mlDSA65: Bool
        let mlKEM768: Bool
        let xWing: Bool
        let secureEnclaveAvailable: Bool
        let secureEnclaveMLDSA65: Bool
        let secureEnclaveMLKEM768: Bool
        let failures: [String]
    }

    struct DeviceRegistrationEnvelope: Codable, Equatable, Sendable {
        let version: String
        let experimentOnly: Bool
        let deviceId: String
        let challengeSHA256: String
        let signatureSuiteId: String
        let signaturePublicKey: String
        let kemSuiteId: String
        let kemPublicKey: String
        let hybridKEMSuiteId: String
        let hybridKEMPublicKey: String
        let keyOrigin: String
        let hardwareProtection: String
        let signature: String
        let createdAt: String
    }

    struct VaultNewDeviceAuthorizationEnvelope: Codable, Equatable, Sendable {
        let version: String
        let experimentOnly: Bool
        let sourceDeviceId: String
        let targetDeviceId: String
        let challengeSHA256: String
        let kemSuiteId: String
        let encapsulatedKey: String
        let sealedAuthorization: String
        let signatureSuiteId: String
        let signaturePublicKey: String
        let signature: String
        let createdAt: String
    }

    struct VaultAuthorizationReceipt: Equatable, Sendable {
        let sourceDeviceId: String
        let targetDeviceId: String
        let challengeSHA256: String
        let productionAuthorization: Bool
        let createdAt: String
    }

    final class ExperimentSession {
        fileprivate let signingKey: SecureEnclave.MLDSA65.PrivateKey
        fileprivate let kemKey: SecureEnclave.MLKEM768.PrivateKey
        fileprivate let hybridKEMKey: XWingMLKEM768X25519.PrivateKey
        let registration: DeviceRegistrationEnvelope

        fileprivate init(
            signingKey: SecureEnclave.MLDSA65.PrivateKey,
            kemKey: SecureEnclave.MLKEM768.PrivateKey,
            hybridKEMKey: XWingMLKEM768X25519.PrivateKey,
            registration: DeviceRegistrationEnvelope
        ) {
            self.signingKey = signingKey
            self.kemKey = kemKey
            self.hybridKEMKey = hybridKEMKey
            self.registration = registration
        }
    }

    enum ExperimentError: Error, Equatable {
        case disabled
        case secureEnclaveUnavailable
        case invalidTargetPublicKey
        case invalidAuthorization
        case encodingFailed
    }

    static var isEnabled: Bool {
        let environment = ProcessInfo.processInfo.environment["ATHENA_IOS_PQ_EXPERIMENTS"]
        if ["1", "true", "yes", "on"].contains(environment?.lowercased()) {
            return true
        }
        return Bundle.main.object(forInfoDictionaryKey: "AthenaPQExperimentsEnabled") as? Bool == true
    }

    static func capabilityReport() -> CapabilityReport {
        var failures: [String] = []
        var mlDSA65Available = false
        var mlKEM768Available = false
        var xWingAvailable = false
        var secureEnclaveMLDSA65Available = false
        var secureEnclaveMLKEM768Available = false
        let message = Data("athena-pq-capability-probe".utf8)

        do {
            let key = try MLDSA65.PrivateKey()
            let signature = try key.signature(for: message)
            mlDSA65Available = key.publicKey.isValidSignature(signature, for: message)
        } catch {
            failures.append("ml-dsa-65-unavailable")
        }

        do {
            let key = try MLKEM768.PrivateKey.generate()
            let encapsulation = try key.publicKey.encapsulate()
            let recovered = try key.decapsulate(encapsulation.encapsulated)
            mlKEM768Available = constantTimeEqual(encapsulation.sharedSecret, recovered)
        } catch {
            failures.append("ml-kem-768-unavailable")
        }

        do {
            let key = try XWingMLKEM768X25519.PrivateKey.generate()
            let encapsulation = try key.publicKey.encapsulate()
            let recovered = try key.decapsulate(encapsulation.encapsulated)
            xWingAvailable = constantTimeEqual(encapsulation.sharedSecret, recovered)
        } catch {
            failures.append("x-wing-unavailable")
        }

        if SecureEnclave.isAvailable {
            do {
                let key = try SecureEnclave.MLDSA65.PrivateKey()
                let signature = try key.signature(for: message)
                secureEnclaveMLDSA65Available = key.publicKey.isValidSignature(signature, for: message)
            } catch {
                failures.append("secure-enclave-ml-dsa-65-unavailable")
            }
            do {
                let key = try SecureEnclave.MLKEM768.PrivateKey.generate()
                let encapsulation = try key.publicKey.encapsulate()
                let recovered = try key.decapsulate(encapsulation.encapsulated)
                secureEnclaveMLKEM768Available = constantTimeEqual(
                    encapsulation.sharedSecret,
                    recovered
                )
            } catch {
                failures.append("secure-enclave-ml-kem-768-unavailable")
            }
        }

        return CapabilityReport(
            mlDSA65: mlDSA65Available,
            mlKEM768: mlKEM768Available,
            xWing: xWingAvailable,
            secureEnclaveAvailable: SecureEnclave.isAvailable,
            secureEnclaveMLDSA65: secureEnclaveMLDSA65Available,
            secureEnclaveMLKEM768: secureEnclaveMLKEM768Available,
            failures: failures
        )
    }

    static func makeDeviceRegistrationExperiment(
        deviceId: String,
        challenge: Data,
        now: Date = Date()
    ) throws -> ExperimentSession {
        guard isEnabled else { throw ExperimentError.disabled }
        guard SecureEnclave.isAvailable else {
            throw ExperimentError.secureEnclaveUnavailable
        }

        let signingKey = try SecureEnclave.MLDSA65.PrivateKey()
        let kemKey = try SecureEnclave.MLKEM768.PrivateKey.generate()
        let hybridKEMKey = try XWingMLKEM768X25519.PrivateKey.generate()
        let createdAt = timestamp(now)
        let payload = RegistrationSigningPayload(
            version: envelopeVersion,
            experimentOnly: true,
            deviceId: deviceId,
            challengeSHA256: sha256Base64URL(challenge),
            signatureSuiteId: AthenaCryptoSuiteRegistry.secureEnclaveMLDSA65ExperimentV1,
            signaturePublicKey: signingKey.publicKey.rawRepresentation.base64URLEncodedString(),
            kemSuiteId: AthenaCryptoSuiteRegistry.mlKEM768ExperimentV1,
            kemPublicKey: kemKey.publicKey.rawRepresentation.base64URLEncodedString(),
            hybridKEMSuiteId: AthenaCryptoSuiteRegistry.xWingMLKEM768X25519ExperimentV1,
            hybridKEMPublicKey: hybridKEMKey.publicKey.rawRepresentation.base64URLEncodedString(),
            keyOrigin: "apple-cryptokit-ios26-experiment",
            hardwareProtection: "secure-enclave-signature-and-ml-kem",
            createdAt: createdAt
        )
        let signature = try signingKey.signature(for: canonicalData(payload))
        let registration = DeviceRegistrationEnvelope(
            version: payload.version,
            experimentOnly: true,
            deviceId: payload.deviceId,
            challengeSHA256: payload.challengeSHA256,
            signatureSuiteId: payload.signatureSuiteId,
            signaturePublicKey: payload.signaturePublicKey,
            kemSuiteId: payload.kemSuiteId,
            kemPublicKey: payload.kemPublicKey,
            hybridKEMSuiteId: payload.hybridKEMSuiteId,
            hybridKEMPublicKey: payload.hybridKEMPublicKey,
            keyOrigin: payload.keyOrigin,
            hardwareProtection: payload.hardwareProtection,
            signature: signature.base64URLEncodedString(),
            createdAt: payload.createdAt
        )
        return ExperimentSession(
            signingKey: signingKey,
            kemKey: kemKey,
            hybridKEMKey: hybridKEMKey,
            registration: registration
        )
    }

    static func makeVaultNewDeviceAuthorizationExperiment(
        source: ExperimentSession,
        targetRegistration: DeviceRegistrationEnvelope,
        challenge: Data,
        now: Date = Date()
    ) throws -> VaultNewDeviceAuthorizationEnvelope {
        guard isEnabled else { throw ExperimentError.disabled }
        guard
            let publicKeyData = Data(base64URLEncoded: targetRegistration.hybridKEMPublicKey),
            let targetPublicKey = try? XWingMLKEM768X25519.PublicKey(
                rawRepresentation: publicKeyData
            )
        else {
            throw ExperimentError.invalidTargetPublicKey
        }

        let challengeHash = sha256Base64URL(challenge)
        let encapsulation = try targetPublicKey.encapsulate()
        let authorizationKey = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: encapsulation.sharedSecret,
            salt: Data("athena-vault-new-device:pq-exp-v1".utf8),
            info: Data(challengeHash.utf8),
            outputByteCount: 32
        )
        let createdAt = timestamp(now)
        let plaintext = try canonicalData(
            VaultAuthorizationPlaintext(
                sourceDeviceId: source.registration.deviceId,
                targetDeviceId: targetRegistration.deviceId,
                challengeSHA256: challengeHash,
                productionAuthorization: false,
                createdAt: createdAt
            )
        )
        let aad = Data("athena-vault-new-device:pq-exp-v1".utf8)
        guard
            let combined = try AES.GCM.seal(
                plaintext,
                using: authorizationKey,
                authenticating: aad
            ).combined
        else {
            throw ExperimentError.encodingFailed
        }
        let signaturePayload = VaultAuthorizationSigningPayload(
            version: envelopeVersion,
            experimentOnly: true,
            sourceDeviceId: source.registration.deviceId,
            targetDeviceId: targetRegistration.deviceId,
            challengeSHA256: challengeHash,
            kemSuiteId: AthenaCryptoSuiteRegistry.xWingMLKEM768X25519ExperimentV1,
            encapsulatedKey: encapsulation.encapsulated.base64URLEncodedString(),
            sealedAuthorization: combined.base64URLEncodedString(),
            signatureSuiteId: AthenaCryptoSuiteRegistry.secureEnclaveMLDSA65ExperimentV1,
            signaturePublicKey: source.registration.signaturePublicKey,
            createdAt: createdAt
        )
        let signature = try source.signingKey.signature(for: canonicalData(signaturePayload))
        return VaultNewDeviceAuthorizationEnvelope(
            version: signaturePayload.version,
            experimentOnly: true,
            sourceDeviceId: signaturePayload.sourceDeviceId,
            targetDeviceId: signaturePayload.targetDeviceId,
            challengeSHA256: signaturePayload.challengeSHA256,
            kemSuiteId: signaturePayload.kemSuiteId,
            encapsulatedKey: signaturePayload.encapsulatedKey,
            sealedAuthorization: signaturePayload.sealedAuthorization,
            signatureSuiteId: signaturePayload.signatureSuiteId,
            signaturePublicKey: signaturePayload.signaturePublicKey,
            signature: signature.base64URLEncodedString(),
            createdAt: signaturePayload.createdAt
        )
    }

    static func openVaultNewDeviceAuthorizationExperiment(
        target: ExperimentSession,
        envelope: VaultNewDeviceAuthorizationEnvelope
    ) throws -> VaultAuthorizationReceipt {
        guard isEnabled else { throw ExperimentError.disabled }
        guard
            envelope.experimentOnly,
            envelope.targetDeviceId == target.registration.deviceId,
            envelope.kemSuiteId == AthenaCryptoSuiteRegistry.xWingMLKEM768X25519ExperimentV1,
            envelope.signatureSuiteId == AthenaCryptoSuiteRegistry.secureEnclaveMLDSA65ExperimentV1,
            let signaturePublicKeyData = Data(
                base64URLEncoded: envelope.signaturePublicKey
            ),
            let signatureData = Data(base64URLEncoded: envelope.signature),
            let encapsulated = Data(base64URLEncoded: envelope.encapsulatedKey),
            let sealedAuthorization = Data(
                base64URLEncoded: envelope.sealedAuthorization
            ),
            let publicKey = try? MLDSA65.PublicKey(
                rawRepresentation: signaturePublicKeyData
            )
        else {
            throw ExperimentError.invalidAuthorization
        }
        let signaturePayload = VaultAuthorizationSigningPayload(
            version: envelope.version,
            experimentOnly: envelope.experimentOnly,
            sourceDeviceId: envelope.sourceDeviceId,
            targetDeviceId: envelope.targetDeviceId,
            challengeSHA256: envelope.challengeSHA256,
            kemSuiteId: envelope.kemSuiteId,
            encapsulatedKey: envelope.encapsulatedKey,
            sealedAuthorization: envelope.sealedAuthorization,
            signatureSuiteId: envelope.signatureSuiteId,
            signaturePublicKey: envelope.signaturePublicKey,
            createdAt: envelope.createdAt
        )
        guard
            publicKey.isValidSignature(
                signatureData,
                for: try canonicalData(signaturePayload)
            )
        else {
            throw ExperimentError.invalidAuthorization
        }
        let sharedSecret = try target.hybridKEMKey.decapsulate(encapsulated)
        let authorizationKey = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: sharedSecret,
            salt: Data("athena-vault-new-device:pq-exp-v1".utf8),
            info: Data(envelope.challengeSHA256.utf8),
            outputByteCount: 32
        )
        let sealedBox = try AES.GCM.SealedBox(combined: sealedAuthorization)
        let plaintext = try AES.GCM.open(
            sealedBox,
            using: authorizationKey,
            authenticating: Data("athena-vault-new-device:pq-exp-v1".utf8)
        )
        let authorization = try JSONDecoder().decode(
            VaultAuthorizationPlaintext.self,
            from: plaintext
        )
        guard
            authorization.sourceDeviceId == envelope.sourceDeviceId,
            authorization.targetDeviceId == envelope.targetDeviceId,
            authorization.challengeSHA256 == envelope.challengeSHA256,
            authorization.productionAuthorization == false
        else {
            throw ExperimentError.invalidAuthorization
        }
        return VaultAuthorizationReceipt(
            sourceDeviceId: authorization.sourceDeviceId,
            targetDeviceId: authorization.targetDeviceId,
            challengeSHA256: authorization.challengeSHA256,
            productionAuthorization: false,
            createdAt: authorization.createdAt
        )
    }

    private struct RegistrationSigningPayload: Codable {
        let version: String
        let experimentOnly: Bool
        let deviceId: String
        let challengeSHA256: String
        let signatureSuiteId: String
        let signaturePublicKey: String
        let kemSuiteId: String
        let kemPublicKey: String
        let hybridKEMSuiteId: String
        let hybridKEMPublicKey: String
        let keyOrigin: String
        let hardwareProtection: String
        let createdAt: String
    }

    private struct VaultAuthorizationPlaintext: Codable {
        let sourceDeviceId: String
        let targetDeviceId: String
        let challengeSHA256: String
        let productionAuthorization: Bool
        let createdAt: String
    }

    private struct VaultAuthorizationSigningPayload: Codable {
        let version: String
        let experimentOnly: Bool
        let sourceDeviceId: String
        let targetDeviceId: String
        let challengeSHA256: String
        let kemSuiteId: String
        let encapsulatedKey: String
        let sealedAuthorization: String
        let signatureSuiteId: String
        let signaturePublicKey: String
        let createdAt: String
    }

    private static func canonicalData<T: Encodable>(_ value: T) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(value)
    }

    private static func timestamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    private static func sha256Base64URL(_ value: Data) -> String {
        Data(SHA256.hash(data: value)).base64URLEncodedString()
    }

    private static func constantTimeEqual(_ left: SymmetricKey, _ right: SymmetricKey) -> Bool {
        let leftData = left.withUnsafeBytes { Data($0) }
        let rightData = right.withUnsafeBytes { Data($0) }
        return leftData.count == rightData.count &&
            zip(leftData, rightData).reduce(UInt8(0)) { $0 | ($1.0 ^ $1.1) } == 0
    }
}

private extension Data {
    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    init?(base64URLEncoded value: String) {
        let standard = value
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let padding = String(repeating: "=", count: (4 - standard.count % 4) % 4)
        self.init(base64Encoded: standard + padding)
    }
}
