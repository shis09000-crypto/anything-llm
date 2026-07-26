import DeviceCheck
import Foundation
import Observation

@MainActor
@Observable
final class DeviceAttestationCenter {
    enum Status: Equatable {
        case unsupported
        case idle
        case verifying
        case verified(Date)
        case failed(String)
    }

    enum AttestationError: Error, Equatable {
        case unsupported
        case invalidChallenge
        case missingKey
        case invalidConfiguration
        case verificationFailed
    }

    private enum Keys {
        static let appAttestKeyID = "deviceAttestation.apple.keyID.v1"
        static let pendingSubmission = "deviceAttestation.apple.pending.v1"
    }

    private struct ChallengeResponse: Decodable {
        let success: Bool
        let provider: String
        let verificationType: String
        let challengeId: String
        let clientDataHash: String
        let expiresAt: String
    }

    private struct VerifyBody: Codable {
        let challengeId: String
        let keyId: String
        let attestationObject: String?
        let assertionObject: String?
        let appId: String
    }

    private struct VerifyResponse: Decodable {
        let success: Bool
        let status: String
        let expiresAt: String
    }

    private struct PendingSubmission: Codable {
        let body: VerifyBody
        let expiresAt: Date
    }

    private let secureStore: SecureValueStore
    private let service: DCAppAttestService
    private let now: () -> Date
    private(set) var status: Status

    init(
        secureStore: SecureValueStore,
        service: DCAppAttestService = .shared,
        now: @escaping () -> Date = Date.init
    ) {
        self.secureStore = secureStore
        self.service = service
        self.now = now
        status = service.isSupported ? .idle : .unsupported
    }

    @discardableResult
    func attestIfSupported(using apiClient: APIClient) async throws -> Bool {
        guard service.isSupported else {
            status = .unsupported
            return false
        }
        status = .verifying
        do {
            if let pending = try pendingSubmission(), pending.expiresAt > now() {
                if try await submit(pending.body, using: apiClient) {
                    try secureStore.removeData(forKey: Keys.pendingSubmission)
                    return true
                }
            } else {
                try secureStore.removeData(forKey: Keys.pendingSubmission)
            }

            let challenge = try await apiClient.requestJSON(
                ChallengeResponse.self,
                method: .post,
                path: "/api/client-identity/attestation/challenge",
                body: [String: String](),
                authorization: .required,
                signing: .required,
                retryOnConnectionLoss: true
            )
            guard challenge.success,
                  challenge.provider == "apple-app-attest",
                  let clientDataHash = Data(attestationBase64URL: challenge.clientDataHash),
                  clientDataHash.count == 32,
                  let expiresAt = ISO8601DateFormatter().date(from: challenge.expiresAt),
                  expiresAt > now()
            else { throw AttestationError.invalidChallenge }
            let appID = try applicationIdentifier()
            let body: VerifyBody
            switch challenge.verificationType {
            case "attestation":
                let keyID = try await generateKey()
                try secureStore.setData(Data(keyID.utf8), forKey: Keys.appAttestKeyID)
                let object = try await attestKey(keyID, clientDataHash: clientDataHash)
                body = VerifyBody(
                    challengeId: challenge.challengeId,
                    keyId: keyID,
                    attestationObject: object.attestationBase64URL(),
                    assertionObject: nil,
                    appId: appID
                )
            case "assertion":
                guard let keyID = try storedKeyID() else {
                    throw AttestationError.missingKey
                }
                let assertion = try await generateAssertion(
                    keyID,
                    clientDataHash: clientDataHash
                )
                body = VerifyBody(
                    challengeId: challenge.challengeId,
                    keyId: keyID,
                    attestationObject: nil,
                    assertionObject: assertion.attestationBase64URL(),
                    appId: appID
                )
            default:
                throw AttestationError.invalidChallenge
            }
            try secureStore.setData(
                JSONEncoder().encode(PendingSubmission(body: body, expiresAt: expiresAt)),
                forKey: Keys.pendingSubmission
            )
            guard try await submit(body, using: apiClient) else {
                throw AttestationError.verificationFailed
            }
            try secureStore.removeData(forKey: Keys.pendingSubmission)
            return true
        } catch {
            status = .failed(String(describing: error))
            throw error
        }
    }

    @available(iOS 26.0, *)
    @discardableResult
    func establishBoundDeviceIdentity(
        clientID: String,
        using apiClient: APIClient
    ) async throws -> Bool {
        let keys = try VaultHybridKeyDistribution.DeviceKeys.loadOrCreate(
            secureStore: secureStore
        )
        try await VaultHybridKeyDistribution.register(
            keys.registration(clientId: clientID),
            using: apiClient
        )
        return try await attestIfSupported(using: apiClient)
    }

    private func submit(_ body: VerifyBody, using apiClient: APIClient) async throws -> Bool {
        let response = try await apiClient.requestJSON(
            VerifyResponse.self,
            method: .post,
            path: "/api/client-identity/attestation/verify",
            body: body,
            authorization: .required,
            signing: .required,
            retryOnConnectionLoss: true
        )
        guard response.success,
              response.status == "verified",
              let expiresAt = ISO8601DateFormatter().date(from: response.expiresAt),
              expiresAt > now()
        else { throw AttestationError.verificationFailed }
        status = .verified(expiresAt)
        return true
    }

    private func applicationIdentifier() throws -> String {
        guard let value = Bundle.main.object(
            forInfoDictionaryKey: "AthenaAppAttestAppID"
        ) as? String,
        !value.isEmpty,
        !value.contains("$(")
        else { throw AttestationError.invalidConfiguration }
        return value
    }

    private func pendingSubmission() throws -> PendingSubmission? {
        guard let data = try secureStore.data(forKey: Keys.pendingSubmission) else {
            return nil
        }
        return try JSONDecoder().decode(PendingSubmission.self, from: data)
    }

    private func storedKeyID() throws -> String? {
        guard let data = try secureStore.data(forKey: Keys.appAttestKeyID),
              let value = String(data: data, encoding: .utf8),
              !value.isEmpty else { return nil }
        return value
    }

    private func generateKey() async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            service.generateKey { keyID, error in
                if let keyID { continuation.resume(returning: keyID) }
                else { continuation.resume(throwing: error ?? AttestationError.missingKey) }
            }
        }
    }

    private func attestKey(_ keyID: String, clientDataHash: Data) async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            service.attestKey(keyID, clientDataHash: clientDataHash) { data, error in
                if let data { continuation.resume(returning: data) }
                else { continuation.resume(throwing: error ?? AttestationError.verificationFailed) }
            }
        }
    }

    private func generateAssertion(
        _ keyID: String,
        clientDataHash: Data
    ) async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            service.generateAssertion(keyID, clientDataHash: clientDataHash) { data, error in
                if let data { continuation.resume(returning: data) }
                else { continuation.resume(throwing: error ?? AttestationError.verificationFailed) }
            }
        }
    }
}

private extension Data {
    init?(attestationBase64URL value: String) {
        let standard = value
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let padding = String(repeating: "=", count: (4 - standard.count % 4) % 4)
        self.init(base64Encoded: standard + padding)
    }

    func attestationBase64URL() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
