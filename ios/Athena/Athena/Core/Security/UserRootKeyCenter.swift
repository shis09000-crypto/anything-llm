import CryptoKit
import Foundation
import Observation

// The coordinator keeps the complete Root lifecycle in one auditable unit.
// swiftlint:disable file_length

@MainActor
@Observable
final class UserRootKeyCenter {
    nonisolated static let deviceMigratableResourceTypes: Set<String> = [
        "chat-conversation-key",
        "content-object",
        "vault-master-key",
        "direct-field-dek",
    ]

    struct UserDomainMigrationResult: Equatable, Sendable {
        let discovered: Int
        let completed: Int
        let deferredDeviceMaterial: Int
        let failed: Int
    }

    enum Status: Equatable {
        case idle
        case loading
        case notInitialized
        case authorizationRequired(rootEpoch: Int, rootKeyId: String)
        case ready(rootEpoch: Int, rootKeyId: String)
        case failed(String)

        var displayTitle: String {
            switch self {
            case .idle:
                "未检查"
            case .loading:
                "检查中"
            case .notInitialized:
                "尚未初始化"
            case .authorizationRequired:
                "等待设备授权"
            case .ready:
                "已就绪"
            case .failed:
                "检查失败"
            }
        }
    }

    private enum Keys {
        static let deviceKeys = "vault.hybrid.deviceKeys.v1"
        static let deviceKeyRing = "vault.hybrid.deviceKeyRing.v2"
        static let userRootRing = "identity.userRootKeyRing.v1"
    }

    private let secureStore: SecureValueStore
    private(set) var status: Status = .idle
    private(set) var remoteStatus: VaultHybridKeyDistribution.UserRootStatus?
    private(set) var authorizationTargets:
        [VaultHybridKeyDistribution.DeviceRegistration] = []

    init(secureStore: SecureValueStore) {
        self.secureStore = secureStore
    }

    @discardableResult
    func refresh(
        authUserId: Int?,
        clientId: String?,
        using apiClient: APIClient
    ) async throws -> Status {
        guard let authUserId, authUserId > 0, clientId?.isEmpty == false else {
            status = .failed("共享身份或设备身份不可用。")
            throw VaultHybridKeyDistribution.DistributionError.invalidUserRoot
        }
        status = .loading
        do {
            let remote = try await VaultHybridKeyDistribution.userRootStatus(
                using: apiClient
            )
            remoteStatus = remote
            #if DEBUG
            print(
                "[AthenaUserRoot] refresh remote initialized=\(remote.initialized) "
                    + "epoch=\(remote.rootEpoch ?? 0) client=\(clientId ?? "none")"
            )
            #endif
            guard remote.initialized else {
                status = .notInitialized
                return status
            }
            guard
                let rootEpoch = remote.rootEpoch,
                let rootKeyId = remote.rootKeyId,
                remote.derivationSuiteId ==
                    VaultHybridKeyDistribution.userRootDerivationSuiteId,
                remote.transportSuiteId == VaultHybridKeyDistribution.suiteId
            else {
                throw VaultHybridKeyDistribution.DistributionError.invalidUserRoot
            }
            let ring = try rootKeyRing()
            if let local = ring.material(
                authUserId: authUserId,
                rootEpoch: rootEpoch
            ), local.rootKeyId == rootKeyId {
                status = .ready(rootEpoch: rootEpoch, rootKeyId: rootKeyId)
            } else {
                status = .authorizationRequired(
                    rootEpoch: rootEpoch,
                    rootKeyId: rootKeyId
                )
            }
            return status
        } catch {
            #if DEBUG
            print("[AthenaUserRoot] refresh failed error=\(String(reflecting: error))")
            #endif
            status = .failed(error.localizedDescription)
            throw error
        }
    }
}

extension UserRootKeyCenter {
    @discardableResult
    // swiftlint:disable:next function_body_length
    func initialize(
        authUserId: Int,
        clientId: String,
        currentPassword: String,
        using apiClient: APIClient
    ) async throws -> VaultHybridKeyDistribution.UserRootKeyMaterial {
        guard
            authUserId > 0,
            !clientId.isEmpty,
            !currentPassword.isEmpty
        else {
            throw VaultHybridKeyDistribution.DistributionError.invalidUserRoot
        }
        let remote = try await VaultHybridKeyDistribution.userRootStatus(
            using: apiClient
        )
        if remote.initialized {
            return try await existingMaterial(
                authUserId: authUserId,
                clientId: clientId,
                using: apiClient
            )
        }

        let grant = try await VaultHybridKeyDistribution.passwordVaultGrant(
            currentPassword: currentPassword,
            using: apiClient
        )
        let keys = try deviceKeys()
        let registration = keys.registration(clientId: clientId)
        try await VaultHybridKeyDistribution.register(
            registration,
            using: apiClient
        )
        let ring = try rootKeyRing()
        let material = try ring.createInitial(authUserId: authUserId)
        do {
            let challenge =
                try await VaultHybridKeyDistribution.requestUserRootChallenge(
                    purpose: "initialize",
                    targetClientId: clientId,
                    using: apiClient
                )
            guard
                challenge.purpose == "initialize",
                challenge.targetClientId == clientId,
                challenge.rootEpoch == material.rootEpoch,
                challenge.rootKeyId == nil,
                let challengeData = challenge.challengeData
            else {
                throw VaultHybridKeyDistribution.DistributionError.invalidUserRoot
            }
            let envelope = try VaultHybridKeyDistribution.sealUserRoot(
                material,
                challengeId: challenge.challengeId,
                challenge: challengeData,
                sourceClientId: clientId,
                sourceKeys: keys,
                target: registration
            )
            try await VaultHybridKeyDistribution.initializeUserRoot(
                envelope,
                challengeId: challenge.challengeId,
                vaultGrant: grant.token,
                using: apiClient
            )
            remoteStatus = try await VaultHybridKeyDistribution.userRootStatus(
                using: apiClient
            )
            status = .ready(
                rootEpoch: material.rootEpoch,
                rootKeyId: material.rootKeyId
            )
            return material
        } catch {
            return try await recoverInitialization(
                material: material,
                ring: ring,
                authUserId: authUserId,
                originalError: error,
                using: apiClient
            )
        }
    }

    @discardableResult
    func authorize(
        target: VaultHybridKeyDistribution.DeviceRegistration,
        authUserId: Int,
        sourceClientId: String,
        currentPassword: String,
        using apiClient: APIClient
    ) async throws -> String {
        let remote = try await VaultHybridKeyDistribution.userRootStatus(
            using: apiClient
        )
        remoteStatus = remote
        guard let material = try activeMaterial(authUserId: authUserId) else {
            throw VaultHybridKeyDistribution.DistributionError.invalidUserRoot
        }
        guard
            remote.rootEpoch == material.rootEpoch,
            remote.rootKeyId == material.rootKeyId
        else {
            throw VaultHybridKeyDistribution.DistributionError.invalidUserRoot
        }
        let grant = try await VaultHybridKeyDistribution.passwordVaultGrant(
            currentPassword: currentPassword,
            using: apiClient
        )
        let challenge =
            try await VaultHybridKeyDistribution.requestUserRootChallenge(
                purpose: "authorize",
                targetClientId: target.clientId,
                using: apiClient
            )
        guard
            challenge.purpose == "authorize",
            challenge.targetClientId == target.clientId,
            challenge.rootEpoch == material.rootEpoch,
            challenge.rootKeyId == material.rootKeyId,
            let challengeData = challenge.challengeData
        else {
            throw VaultHybridKeyDistribution.DistributionError.invalidUserRoot
        }
        let envelope = try VaultHybridKeyDistribution.sealUserRoot(
            material,
            challengeId: challenge.challengeId,
            challenge: challengeData,
            sourceClientId: sourceClientId,
            sourceKeys: try deviceKeys(),
            target: target
        )
        return try await VaultHybridKeyDistribution.submitUserRootEnvelope(
            envelope,
            challengeId: challenge.challengeId,
            vaultGrant: grant.token,
            using: apiClient
        )
    }

    @discardableResult
    func refreshAuthorizationTargets(using apiClient: APIClient) async throws
        -> [VaultHybridKeyDistribution.DeviceRegistration]
    {
        guard case .ready = status else {
            authorizationTargets = []
            return []
        }
        authorizationTargets =
            try await VaultHybridKeyDistribution.userRootAuthorizationTargets(
                using: apiClient
            )
        return authorizationTargets
    }
}

extension UserRootKeyCenter {
    func userDomainKey(
        resourceType: String,
        resourceId: String,
        authUserId: Int,
        using apiClient: APIClient
    ) async throws -> Data? {
        guard let root = try activeMaterial(authUserId: authUserId) else {
            throw VaultHybridKeyDistribution.DistributionError.invalidUserRoot
        }
        let wraps = try await VaultHybridKeyDistribution.userDomainWraps(
            resourceType: resourceType,
            resourceId: resourceId,
            includeEnvelope: true,
            using: apiClient
        )
        guard
            let record = wraps.first(where: {
                $0.resourceType == resourceType &&
                    $0.resourceId == resourceId &&
                    ["active", "active_device_verified"].contains($0.status) &&
                    $0.rootKeyId == root.rootKeyId &&
                    $0.rootEpoch == root.rootEpoch
            }),
            let envelope = record.envelope
        else { return nil }
        return try VaultHybridKeyDistribution.unwrapUserDomainKey(
            envelope,
            root: root
        )
    }

    @discardableResult
    func migratePendingUserDomainWraps(
        authUserId: Int,
        clientId: String,
        currentPassword: String,
        using apiClient: APIClient
    ) async throws -> UserDomainMigrationResult {
        _ = try await refresh(
            authUserId: authUserId,
            clientId: clientId,
            using: apiClient
        )
        guard let root = try activeMaterial(authUserId: authUserId) else {
            throw VaultHybridKeyDistribution.DistributionError.invalidUserRoot
        }
        let grant = try await VaultHybridKeyDistribution.passwordVaultGrant(
            currentPassword: currentPassword,
            using: apiClient
        )
        let keys = try deviceKeys()
        let pending =
            try await VaultHybridKeyDistribution.pendingUserDomainWraps(
                using: apiClient
            )
        var completed = 0
        var deferred = 0
        var failed = 0
        for record in pending {
            guard record.rootKeyId == root.rootKeyId,
                record.rootEpoch == root.rootEpoch
            else {
                failed += 1
                continue
            }
            guard Self.deviceMigratableResourceTypes.contains(record.resourceType)
            else {
                deferred += 1
                continue
            }
            do {
                let transport =
                    try await VaultHybridKeyDistribution.prepareUserDomainWrap(
                        record.id,
                        vaultGrant: grant.token,
                        using: apiClient
                    )
                guard
                    transport.resourceType == record.resourceType,
                    transport.resourceId == record.resourceId,
                    transport.domain == record.domain,
                    transport.domainKeyVersion == record.domainKeyVersion
                else {
                    throw VaultHybridKeyDistribution.DistributionError
                        .invalidEnvelope
                }
                let keyMaterial =
                    try VaultHybridKeyDistribution.openUserDomainMaterial(
                        transport,
                        root: root,
                        targetClientId: clientId,
                        targetKeys: keys
                    )
                let envelope =
                    try VaultHybridKeyDistribution.wrapUserDomainKey(
                        keyMaterial,
                        root: root,
                        domain: record.domain,
                        resourceType: record.resourceType,
                        resourceId: record.resourceId,
                        domainKeyVersion: record.domainKeyVersion
                    )
                _ =
                    try await VaultHybridKeyDistribution
                        .completeUserDomainWrap(
                            record.id,
                            envelope: envelope,
                            using: apiClient
                        )
                completed += 1
            } catch {
                failed += 1
            }
        }
        return UserDomainMigrationResult(
            discovered: pending.count,
            completed: completed,
            deferredDeviceMaterial: deferred,
            failed: failed
        )
    }
}

extension UserRootKeyCenter {
    @discardableResult
    // swiftlint:disable:next function_body_length
    func receivePending(
        authUserId: Int,
        clientId: String,
        using apiClient: APIClient
    ) async throws -> Bool {
        let remote = try await VaultHybridKeyDistribution.userRootStatus(
            using: apiClient
        )
        guard
            let rootEpoch = remote.rootEpoch,
            let rootKeyId = remote.rootKeyId
        else {
            status = .notInitialized
            return false
        }
        let keys = try deviceKeys()
        let pending =
            try await VaultHybridKeyDistribution.pendingUserRootEnvelopes(
                using: apiClient
            )
        guard let entry = pending.first(where: {
            matches(
                $0,
                clientId: clientId,
                keyGeneration: keys.keyGeneration,
                rootEpoch: rootEpoch,
                rootKeyId: rootKeyId
            )
        }) else {
            status = .authorizationRequired(
                rootEpoch: rootEpoch,
                rootKeyId: rootKeyId
            )
            return false
        }
        let material = try VaultHybridKeyDistribution.openUserRoot(
            entry.envelope,
            targetKeys: keys,
            trustedSource: entry.trustedSource,
            expectedAuthUserId: authUserId,
            minimumRootEpoch: max(0, rootEpoch - 1)
        )
        let ring = try rootKeyRing()
        if let local = ring.material(
            authUserId: authUserId,
            rootEpoch: rootEpoch
        ), local.rootKeyId != material.rootKeyId {
            _ = try ring.remove(
                authUserId: authUserId,
                rootEpoch: rootEpoch,
                matchingRootKeyId: local.rootKeyId
            )
        }
        try ring.store(material)
        try await VaultHybridKeyDistribution.consumeUserRootEnvelope(
            entry.id,
            using: apiClient
        )
        remoteStatus = remote
        status = .ready(rootEpoch: rootEpoch, rootKeyId: rootKeyId)
        return true
    }

    func domainKey(
        _ domain: VaultHybridKeyDistribution.UserKeyDomain,
        authUserId: Int
    ) throws -> SymmetricKey {
        guard
            case .ready(let rootEpoch, let rootKeyId) = status,
            let material = try rootKeyRing().material(
                authUserId: authUserId,
                rootEpoch: rootEpoch
            ),
            material.rootKeyId == rootKeyId
        else {
            throw VaultHybridKeyDistribution.DistributionError.invalidUserRoot
        }
        return SymmetricKey(
            data: try VaultHybridKeyDistribution.deriveUserKey(
                material,
                domain: domain
            )
        )
    }

    func lock() {
        remoteStatus = nil
        authorizationTargets = []
        status = .idle
    }

    func resetDeviceIdentity() throws {
        try secureStore.removeData(forKey: Keys.deviceKeys)
        try secureStore.removeData(forKey: Keys.deviceKeyRing)
        // Root material belongs to the shared user identity, not the replaceable
        // Client ID. Keeping it lets this device authorize a recovered identity.
        lock()
    }

    private func activeMaterial(authUserId: Int) throws
        -> VaultHybridKeyDistribution.UserRootKeyMaterial? {
        guard
            let remoteStatus,
            let rootEpoch = remoteStatus.rootEpoch,
            let rootKeyId = remoteStatus.rootKeyId,
            let material = try rootKeyRing().material(
                authUserId: authUserId,
                rootEpoch: rootEpoch
            ),
            material.rootKeyId == rootKeyId
        else { return nil }
        return material
    }

    private func rootKeyRing() throws
        -> VaultHybridKeyDistribution.UserRootKeyRing {
        try VaultHybridKeyDistribution.UserRootKeyRing(
            secureStore: secureStore,
            storageKey: Keys.userRootRing
        )
    }

    private func deviceKeys() throws
        -> VaultHybridKeyDistribution.DeviceKeys {
        try VaultHybridKeyDistribution.DeviceKeys.loadOrCreate(
            secureStore: secureStore,
            storageKey: Keys.deviceKeys
        )
    }

    private func existingMaterial(
        authUserId: Int,
        clientId: String,
        using apiClient: APIClient
    ) async throws -> VaultHybridKeyDistribution.UserRootKeyMaterial {
        _ = try await refresh(
            authUserId: authUserId,
            clientId: clientId,
            using: apiClient
        )
        guard let material = try activeMaterial(authUserId: authUserId) else {
            throw VaultHybridKeyDistribution.DistributionError.invalidUserRoot
        }
        return material
    }

    private func recoverInitialization(
        material: VaultHybridKeyDistribution.UserRootKeyMaterial,
        ring: VaultHybridKeyDistribution.UserRootKeyRing,
        authUserId: Int,
        originalError: Error,
        using apiClient: APIClient
    ) async throws -> VaultHybridKeyDistribution.UserRootKeyMaterial {
        let recovered = try? await VaultHybridKeyDistribution.userRootStatus(
            using: apiClient
        )
        if let confirmed = recovered,
            confirmed.rootEpoch == material.rootEpoch,
            confirmed.rootKeyId == material.rootKeyId {
            remoteStatus = confirmed
            status = .ready(
                rootEpoch: material.rootEpoch,
                rootKeyId: material.rootKeyId
            )
            return material
        }
        if let competing = recovered,
            competing.initialized,
            competing.rootKeyId != material.rootKeyId {
            _ = try? ring.remove(
                authUserId: authUserId,
                rootEpoch: material.rootEpoch,
                matchingRootKeyId: material.rootKeyId
            )
            remoteStatus = competing
            status = .authorizationRequired(
                rootEpoch: competing.rootEpoch ?? 1,
                rootKeyId: competing.rootKeyId ?? "unknown"
            )
        } else {
            status = .failed(originalError.localizedDescription)
        }
        throw originalError
    }

    private func matches(
        _ entry: VaultHybridKeyDistribution.PendingUserRootEnvelope,
        clientId: String,
        keyGeneration: Int,
        rootEpoch: Int,
        rootKeyId: String
    ) -> Bool {
        entry.targetClientId == clientId &&
            entry.targetKeyGeneration == keyGeneration &&
            entry.rootEpoch == rootEpoch &&
            entry.rootKeyId == rootKeyId
    }
}
