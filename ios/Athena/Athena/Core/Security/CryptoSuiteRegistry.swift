import Foundation

struct AthenaCryptoSuiteDescriptor: Codable, Equatable, Sendable {
    let suiteId: String
    let purpose: String
    let classicalAlgorithm: String?
    let pqAlgorithm: String?
    let parameterSet: String
    let keyEncoding: String
    let signatureEncoding: String?
    let minimumClientVersion: String?
    let status: String
    let notBefore: String?
    let deprecatedAfter: String?
}

enum AthenaCryptoSuiteRegistry {
    static let registryVersion = "athena-crypto-suites:v1"
    static let requestSignaturePurpose = "request-signature"
    static let deviceKeyPurpose = "device-key"

    static let requestHMACV1 = "v1"
    static let requestDeviceP256V2 = "v2-device-p256"
    static let deviceP256SoftwareV1 = "p256-software-v1"
    static let deviceP256SecureEnclaveV1 = "p256-secure-enclave-v1"
    static let secureEnclaveMLDSA65ExperimentV1 = "ios-se-mldsa65-exp-v1"
    static let mlKEM768ExperimentV1 = "ml-kem-768-exp-v1"
    static let xWingMLKEM768X25519ExperimentV1 = "x-wing-mlkem768-x25519-exp-v1"
    static let vaultXWingMLDSA65ExperimentV1 = "vault-xwing-mldsa65-exp-v1"
    static let deviceHybridP256MLDSA65V1 = "device-hybrid-p256-mldsa65-v1"
    static let requestDeviceMLDSA65V1 = "request-device-mldsa65-v1"

    private static let requestDeviceP256Fallback = AthenaCryptoSuiteDescriptor(
        suiteId: requestDeviceP256V2,
        purpose: requestSignaturePurpose,
        classicalAlgorithm: "ECDSA-P256-SHA256",
        pqAlgorithm: nil,
        parameterSet: "secp256r1",
        keyEncoding: "jwk",
        signatureEncoding: "ieee-p1363-base64url",
        minimumClientVersion: "0.0.0",
        status: "active",
        notBefore: "2020-01-01T00:00:00.000Z",
        deprecatedAfter: nil
    )

    static let fallbackSuites: [AthenaCryptoSuiteDescriptor] = [
        requestDeviceP256Fallback,
        AthenaCryptoSuiteDescriptor(
            suiteId: requestHMACV1,
            purpose: requestSignaturePurpose,
            classicalAlgorithm: "HMAC-SHA256",
            pqAlgorithm: nil,
            parameterSet: "SHA-256/256-bit-key",
            keyEncoding: "raw-base64url",
            signatureEncoding: "base64url",
            minimumClientVersion: "0.0.0",
            status: "compatibility",
            notBefore: "2020-01-01T00:00:00.000Z",
            deprecatedAfter: nil
        ),
        AthenaCryptoSuiteDescriptor(
            suiteId: deviceP256SoftwareV1,
            purpose: deviceKeyPurpose,
            classicalAlgorithm: "ECDSA-P256-SHA256",
            pqAlgorithm: nil,
            parameterSet: "secp256r1",
            keyEncoding: "jwk",
            signatureEncoding: "ieee-p1363-base64url",
            minimumClientVersion: "0.0.0",
            status: "active",
            notBefore: "2020-01-01T00:00:00.000Z",
            deprecatedAfter: nil
        ),
        AthenaCryptoSuiteDescriptor(
            suiteId: deviceP256SecureEnclaveV1,
            purpose: deviceKeyPurpose,
            classicalAlgorithm: "ECDSA-P256-SHA256",
            pqAlgorithm: nil,
            parameterSet: "secp256r1",
            keyEncoding: "jwk",
            signatureEncoding: "ieee-p1363-base64url",
            minimumClientVersion: "0.0.0",
            status: "active",
            notBefore: "2020-01-01T00:00:00.000Z",
            deprecatedAfter: nil
        ),
    ]

    static let strictPostQuantumSuites: [AthenaCryptoSuiteDescriptor] =
        fallbackSuites + [
            AthenaCryptoSuiteDescriptor(
                suiteId: requestDeviceMLDSA65V1,
                purpose: requestSignaturePurpose,
                classicalAlgorithm: nil,
                pqAlgorithm: "ML-DSA-65",
                parameterSet: "ML-DSA-65",
                keyEncoding: "raw-base64url",
                signatureEncoding: "raw-base64url",
                minimumClientVersion: "2.4.0",
                status: "active",
                notBefore: "2026-07-22T00:00:00.000Z",
                deprecatedAfter: nil
            ),
            AthenaCryptoSuiteDescriptor(
                suiteId: deviceHybridP256MLDSA65V1,
                purpose: requestSignaturePurpose,
                classicalAlgorithm: "ECDSA-P256-SHA256",
                pqAlgorithm: "ML-DSA-65",
                parameterSet: "secp256r1+ML-DSA-65",
                keyEncoding: "composite-cbor-v1",
                signatureEncoding: "composite-base64url-v1",
                minimumClientVersion: "2.4.0",
                status: "active",
                notBefore: "2026-07-22T00:00:00.000Z",
                deprecatedAfter: nil
            ),
        ]

    static func resolve(
        _ suiteId: String,
        purpose: String,
        suites: [AthenaCryptoSuiteDescriptor],
        clientVersion: String = currentClientVersion,
        now: Date = Date()
    ) -> AthenaCryptoSuiteDescriptor? {
        suites.first { suite in
            suite.suiteId == suiteId &&
                suite.purpose == purpose &&
                isAvailable(suite, clientVersion: clientVersion, now: now) &&
                suite.pqAlgorithm == nil
        }
    }

    static func preferredRequestSignature(
        serverPreferred: String?,
        suites: [AthenaCryptoSuiteDescriptor]
    ) -> AthenaCryptoSuiteDescriptor {
        if let serverPreferred,
           let suite = resolve(
               serverPreferred,
               purpose: requestSignaturePurpose,
               suites: suites
           ),
           suite.classicalAlgorithm == "ECDSA-P256-SHA256"
        {
            return suite
        }
        return requestDeviceP256Fallback
    }

    private static var currentClientVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"
    }

    private static func isAvailable(
        _ suite: AthenaCryptoSuiteDescriptor,
        clientVersion: String,
        now: Date
    ) -> Bool {
        guard ["active", "compatibility"].contains(suite.status) else {
            return false
        }
        if let minimum = suite.minimumClientVersion,
           compareVersions(clientVersion, minimum) == .orderedAscending
        {
            return false
        }
        if let notBefore = date(suite.notBefore), now < notBefore {
            return false
        }
        if let deprecatedAfter = date(suite.deprecatedAfter), now >= deprecatedAfter {
            return false
        }
        return true
    }

    private static func date(_ value: String?) -> Date? {
        guard let value else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let parsed = fractional.date(from: value) { return parsed }
        return ISO8601DateFormatter().date(from: value)
    }

    private static func compareVersions(
        _ left: String,
        _ right: String
    ) -> ComparisonResult {
        let leftParts = versionParts(left)
        let rightParts = versionParts(right)
        for index in 0..<3 where leftParts[index] != rightParts[index] {
            return leftParts[index] < rightParts[index] ? .orderedAscending : .orderedDescending
        }
        return .orderedSame
    }

    private static func versionParts(_ value: String) -> [Int] {
        let parts = value.split(separator: ".", maxSplits: 3).prefix(3).map {
            Int($0.prefix { $0.isNumber }) ?? 0
        }
        return parts + Array(repeating: 0, count: max(0, 3 - parts.count))
    }
}
