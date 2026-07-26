import CryptoKit
import Foundation

@available(iOS 26.0, *)
enum VaultHybridKeyDistribution {
    static let envelopeVersion = "athena-vault-key-envelope:v2"
    static let suiteId = "vault-xwing-mldsa65-v1"
    static let userRootEnvelopeVersion = "athena-user-root-key-envelope:v2"
    static let userRootDerivationSuiteId = "user-root-hkdf-sha256-v1"

    struct DeviceRegistration: Codable, Equatable, Sendable {
        let clientId: String
        let keyGeneration: Int
        let kemSuiteId: String
        let kemPublicKey: String
        let p256PublicKey: String
        let mlDSA65PublicKey: String

        var signingIdentity: SigningIdentity {
            SigningIdentity(
                clientId: clientId,
                suiteId: kemSuiteId,
                keyGeneration: keyGeneration,
                p256PublicKey: p256PublicKey,
                mlDSA65PublicKey: mlDSA65PublicKey
            )
        }
    }

    struct SigningIdentity: Codable, Equatable, Sendable {
        let clientId: String
        let suiteId: String
        let keyGeneration: Int?
        let p256PublicKey: String
        let mlDSA65PublicKey: String
    }

    struct Envelope: Codable, Equatable, Sendable {
        let version: String
        let kemSuiteId: String
        let sourceClientId: String
        let targetClientId: String
        let sourceKeyGeneration: Int?
        let targetKeyGeneration: Int?
        let targetKEMPublicKey: String
        let keyEpoch: Int
        let challengeSHA256: String
        let encapsulatedKey: String
        let sealedKeyMaterial: String
        let p256PublicKey: String
        let p256Signature: String
        let mlDSA65PublicKey: String
        let mlDSA65Signature: String
        let createdAt: String
        let expiresAt: String
    }

    struct KeyMaterial: Codable, Equatable, Sendable {
        let umk: Data
        let vmk: Data
        let keyEpoch: Int
    }

    enum UserKeyDomain: String, Codable, CaseIterable, Sendable {
        case data
        case file
        case agent
        case vault
    }

    struct UserRootKeyMaterial: Codable, Equatable, Sendable {
        let version: String
        let userRootKey: Data
        let authUserId: Int
        let rootEpoch: Int
        let derivationSuiteId: String
        let rootKeyId: String

        init(
            userRootKey: Data,
            authUserId: Int,
            rootEpoch: Int = 1
        ) throws {
            guard userRootKey.count == 32, authUserId > 0, rootEpoch > 0 else {
                throw DistributionError.invalidUserRoot
            }
            version = "athena-user-root-key-material:v1"
            self.userRootKey = userRootKey
            self.authUserId = authUserId
            self.rootEpoch = rootEpoch
            derivationSuiteId = userRootDerivationSuiteId
            rootKeyId = sha256(userRootKey)
        }
    }

    struct UserRootEnvelope: Codable, Equatable, Sendable {
        let version: String
        let materialType: String
        let derivationSuiteId: String
        let transportSuiteId: String
        let authUserId: Int
        let sourceClientId: String
        let targetClientId: String
        let sourceKeyGeneration: Int
        let targetKeyGeneration: Int
        let targetKEMPublicKey: String
        let rootEpoch: Int
        let rootKeyId: String
        let challengeId: String
        let challenge: String
        let challengeSHA256: String
        let encapsulatedKey: String
        let sealedRootKey: String
        let p256PublicKey: String
        let p256Signature: String
        let mlDSA65PublicKey: String
        let mlDSA65Signature: String
        let createdAt: String
        let expiresAt: String
    }

    final class DeviceKeys {
        fileprivate struct StoredKeys: Codable {
            let p256: Data
            let mlDSA65: Data
            let kem: Data
            let keyGeneration: Int?
        }

        fileprivate let p256: SecureEnclave.P256.Signing.PrivateKey
        fileprivate let mlDSA65: SecureEnclave.MLDSA65.PrivateKey
        fileprivate let kem: XWingMLKEM768X25519.PrivateKey
        let keyGeneration: Int

        init(keyGeneration: Int = 1) throws {
            guard SecureEnclave.isAvailable else {
                throw DistributionError.secureEnclaveUnavailable
            }
            guard keyGeneration > 0 else {
                throw DistributionError.invalidRegistration
            }
            p256 = try SecureEnclave.P256.Signing.PrivateKey()
            mlDSA65 = try SecureEnclave.MLDSA65.PrivateKey()
            kem = try XWingMLKEM768X25519.PrivateKey.generate()
            self.keyGeneration = keyGeneration
        }

        fileprivate init(stored: StoredKeys) throws {
            guard SecureEnclave.isAvailable else {
                throw DistributionError.secureEnclaveUnavailable
            }
            p256 = try SecureEnclave.P256.Signing.PrivateKey(
                dataRepresentation: stored.p256
            )
            mlDSA65 = try SecureEnclave.MLDSA65.PrivateKey(
                dataRepresentation: stored.mlDSA65
            )
            kem = try XWingMLKEM768X25519.PrivateKey(
                integrityCheckedRepresentation: stored.kem
            )
            keyGeneration = max(stored.keyGeneration ?? 1, 1)
        }

        static func loadOrCreate(
            secureStore: SecureValueStore,
            storageKey: String = "vault.hybrid.deviceKeys.v1"
        ) throws -> DeviceKeys {
            if let encoded = try secureStore.data(forKey: storageKey) {
                return try DeviceKeys(stored: JSONDecoder().decode(StoredKeys.self, from: encoded))
            }
            let keys = try DeviceKeys()
            let encoded = try JSONEncoder().encode(
                StoredKeys(
                    p256: keys.p256.dataRepresentation,
                    mlDSA65: keys.mlDSA65.dataRepresentation,
                    kem: keys.kem.integrityCheckedRepresentation,
                    keyGeneration: keys.keyGeneration
                )
            )
            try secureStore.setData(encoded, forKey: storageKey)
            return keys
        }

        func registration(clientId: String) -> DeviceRegistration {
            DeviceRegistration(
                clientId: clientId,
                keyGeneration: keyGeneration,
                kemSuiteId: suiteId,
                kemPublicKey: kem.publicKey.rawRepresentation.athenaBase64URL(),
                p256PublicKey: p256.publicKey.x963Representation.athenaBase64URL(),
                mlDSA65PublicKey: mlDSA65.publicKey.rawRepresentation.athenaBase64URL()
            )
        }

        fileprivate var storedRepresentation: StoredKeys {
            StoredKeys(
                p256: p256.dataRepresentation,
                mlDSA65: mlDSA65.dataRepresentation,
                kem: kem.integrityCheckedRepresentation,
                keyGeneration: keyGeneration
            )
        }
    }

    final class DeviceKeyRing {
        private struct Archive: Codable {
            var currentGeneration: Int
            var generations: [DeviceKeys.StoredKeys]
        }

        private let secureStore: SecureValueStore
        private let storageKey: String
        private var archive: Archive

        private init(
            secureStore: SecureValueStore,
            storageKey: String,
            archive: Archive
        ) {
            self.secureStore = secureStore
            self.storageKey = storageKey
            self.archive = archive
        }

        static func loadOrCreate(
            secureStore: SecureValueStore,
            storageKey: String = "vault.hybrid.deviceKeyRing.v2"
        ) throws -> DeviceKeyRing {
            if let encoded = try secureStore.data(forKey: storageKey) {
                let archive = try JSONDecoder().decode(Archive.self, from: encoded)
                guard
                    archive.currentGeneration > 0,
                    archive.generations.contains(where: {
                        ($0.keyGeneration ?? 1) == archive.currentGeneration
                    })
                else { throw DistributionError.invalidRegistration }
                return DeviceKeyRing(
                    secureStore: secureStore,
                    storageKey: storageKey,
                    archive: archive
                )
            }
            let first = try DeviceKeys(keyGeneration: 1)
            let ring = DeviceKeyRing(
                secureStore: secureStore,
                storageKey: storageKey,
                archive: Archive(
                    currentGeneration: 1,
                    generations: [first.storedRepresentation]
                )
            )
            try ring.persist()
            return ring
        }

        static func recoverAfterSecureEnclaveReset(
            secureStore: SecureValueStore,
            storageKey: String = "vault.hybrid.deviceKeyRing.v2",
            lastKnownGeneration: Int,
            recoveredMaterials: [KeyMaterial],
            epochKeyRing: EpochKeyRing
        ) throws -> DeviceKeyRing {
            guard lastKnownGeneration > 0, !recoveredMaterials.isEmpty else {
                throw DistributionError.invalidRegistration
            }
            for material in recoveredMaterials {
                try epochKeyRing.store(material)
            }
            let replacement = try DeviceKeys(
                keyGeneration: lastKnownGeneration + 1
            )
            let ring = DeviceKeyRing(
                secureStore: secureStore,
                storageKey: storageKey,
                archive: Archive(
                    currentGeneration: replacement.keyGeneration,
                    generations: [replacement.storedRepresentation]
                )
            )
            try ring.persist()
            return ring
        }

        var currentGeneration: Int { archive.currentGeneration }

        func current() throws -> DeviceKeys {
            try keys(for: archive.currentGeneration)
        }

        func keys(for generation: Int) throws -> DeviceKeys {
            guard let stored = archive.generations.first(where: {
                ($0.keyGeneration ?? 1) == generation
            }) else { throw DistributionError.keyGenerationUnavailable }
            return try DeviceKeys(stored: stored)
        }

        @discardableResult
        func rotate() throws -> DeviceKeys {
            let nextGeneration = archive.currentGeneration + 1
            let keys = try DeviceKeys(keyGeneration: nextGeneration)
            archive.generations.append(keys.storedRepresentation)
            archive.currentGeneration = nextGeneration
            try persist()
            return keys
        }

        @discardableResult
        func recoverAfterSecureEnclaveReset(
            nextGeneration: Int,
            recoveredMaterials: [KeyMaterial],
            epochKeyRing: EpochKeyRing
        ) throws -> DeviceKeys {
            guard
                nextGeneration > archive.currentGeneration,
                !recoveredMaterials.isEmpty
            else { throw DistributionError.invalidRegistration }
            for material in recoveredMaterials {
                try epochKeyRing.store(material)
            }
            let replacement = try DeviceKeys(keyGeneration: nextGeneration)
            archive = Archive(
                currentGeneration: nextGeneration,
                generations: [replacement.storedRepresentation]
            )
            try persist()
            return replacement
        }

        func retire(
            generation: Int,
            referencedEnvelopeGenerations: Set<Int>,
            minimumRetainedGenerations: Int = 2
        ) throws {
            guard
                generation != archive.currentGeneration,
                !referencedEnvelopeGenerations.contains(generation),
                archive.generations.count > max(minimumRetainedGenerations, 1)
            else { throw DistributionError.keyGenerationStillRequired }
            archive.generations.removeAll {
                ($0.keyGeneration ?? 1) == generation
            }
            try persist()
        }

        private func persist() throws {
            try secureStore.setData(
                JSONEncoder().encode(archive),
                forKey: storageKey
            )
        }
    }

    final class EpochKeyRing {
        enum Status: String, Codable {
            case active
            case retiring
            case retired
        }

        private struct Entry: Codable {
            let material: KeyMaterial
            var status: Status
        }

        private struct Archive: Codable {
            var entries: [Entry]
        }

        private let secureStore: SecureValueStore
        private let storageKey: String
        private var archive: Archive

        init(
            secureStore: SecureValueStore,
            storageKey: String = "vault.hybrid.epochKeyRing.v2"
        ) throws {
            self.secureStore = secureStore
            self.storageKey = storageKey
            if let encoded = try secureStore.data(forKey: storageKey) {
                archive = try JSONDecoder().decode(Archive.self, from: encoded)
            } else {
                archive = Archive(entries: [])
            }
        }

        var epochs: [Int] {
            archive.entries.map(\.material.keyEpoch).sorted()
        }

        func material(for epoch: Int) -> KeyMaterial? {
            archive.entries.first {
                $0.material.keyEpoch == epoch && $0.status != .retired
            }?.material
        }

        func store(_ material: KeyMaterial) throws {
            guard material.keyEpoch > 0 else {
                throw DistributionError.staleKeyEpoch
            }
            if let index = archive.entries.firstIndex(where: {
                $0.material.keyEpoch == material.keyEpoch
            }) {
                guard archive.entries[index].material == material else {
                    throw DistributionError.invalidEnvelope
                }
            } else {
                archive.entries.append(Entry(material: material, status: .active))
            }
            try persist()
        }

        func markRetiring(epoch: Int) throws {
            guard let index = archive.entries.firstIndex(where: {
                $0.material.keyEpoch == epoch
            }) else { throw DistributionError.staleKeyEpoch }
            archive.entries[index].status = .retiring
            try persist()
        }

        func retire(
            epoch: Int,
            referencedItemEpochs: Set<Int>,
            recoveryEpochs: Set<Int>,
            minimumRetainedEpochs: Int = 2
        ) throws {
            guard
                !referencedItemEpochs.contains(epoch),
                archive.entries.count > max(minimumRetainedEpochs, 1),
                recoveryEpochs.contains(where: { $0 > epoch }),
                archive.entries.contains(where: {
                    $0.material.keyEpoch > epoch && $0.status == .active
                }),
                let index = archive.entries.firstIndex(where: {
                    $0.material.keyEpoch == epoch
                })
            else { throw DistributionError.keyEpochStillRequired }
            archive.entries[index].status = .retired
            try persist()
        }

        private func persist() throws {
            try secureStore.setData(
                JSONEncoder().encode(archive),
                forKey: storageKey
            )
        }
    }

    final class UserRootKeyRing {
        private struct Archive: Codable {
            var materials: [UserRootKeyMaterial]
        }

        private let secureStore: SecureValueStore
        private let storageKey: String
        private var archive: Archive

        init(
            secureStore: SecureValueStore,
            storageKey: String = "identity.userRootKeyRing.v1"
        ) throws {
            self.secureStore = secureStore
            self.storageKey = storageKey
            if let encoded = try secureStore.data(forKey: storageKey) {
                archive = try JSONDecoder().decode(Archive.self, from: encoded)
            } else {
                archive = Archive(materials: [])
            }
        }

        var epochs: [Int] {
            archive.materials.map(\.rootEpoch).sorted()
        }

        func material(authUserId: Int, rootEpoch: Int? = nil)
            -> UserRootKeyMaterial?
        {
            archive.materials
                .filter {
                    $0.authUserId == authUserId &&
                        (rootEpoch == nil || $0.rootEpoch == rootEpoch)
                }
                .max { $0.rootEpoch < $1.rootEpoch }
        }

        @discardableResult
        func createInitial(authUserId: Int) throws -> UserRootKeyMaterial {
            guard authUserId > 0 else {
                throw DistributionError.invalidUserRoot
            }
            if let existing = material(authUserId: authUserId) {
                return existing
            }
            let root = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
            let material = try UserRootKeyMaterial(
                userRootKey: root,
                authUserId: authUserId,
                rootEpoch: 1
            )
            try store(material)
            return material
        }

        func store(_ material: UserRootKeyMaterial) throws {
            guard
                material.version == "athena-user-root-key-material:v1",
                material.userRootKey.count == 32,
                material.authUserId > 0,
                material.rootEpoch > 0,
                material.derivationSuiteId == userRootDerivationSuiteId,
                material.rootKeyId == sha256(material.userRootKey)
            else { throw DistributionError.invalidUserRoot }
            if let index = archive.materials.firstIndex(where: {
                $0.authUserId == material.authUserId &&
                    $0.rootEpoch == material.rootEpoch
            }) {
                guard archive.materials[index] == material else {
                    throw DistributionError.invalidUserRoot
                }
                return
            }
            archive.materials.append(material)
            try persist()
        }

        @discardableResult
        func remove(
            authUserId: Int,
            rootEpoch: Int,
            matchingRootKeyId: String
        ) throws -> Bool {
            guard
                let index = archive.materials.firstIndex(where: {
                    $0.authUserId == authUserId &&
                        $0.rootEpoch == rootEpoch &&
                        $0.rootKeyId == matchingRootKeyId
                })
            else { return false }
            archive.materials.remove(at: index)
            try persist()
            return true
        }

        private func persist() throws {
            try secureStore.setData(
                JSONEncoder().encode(archive),
                forKey: storageKey
            )
        }
    }

    struct RecoveryPackage: Codable, Equatable, Sendable {
        let version: String
        let recoveryKeyId: String
        let highestKeyEpoch: Int
        let salt: String
        let sealedEpochMaterials: String
        let createdAt: String
    }

    struct KeyEpochDescriptor: Codable, Equatable, Sendable {
        let keyEpoch: Int
        let status: String
        let createdAt: String
        let activatedAt: String?
        let retiredAt: String?
    }

    struct UserRootStatus: Decodable, Equatable, Sendable {
        let initialized: Bool
        let rootEpoch: Int?
        let rootKeyId: String?
        let derivationSuiteId: String?
        let transportSuiteId: String?
        let status: String
        let initializedByClientId: String?
        let pendingEnvelopes: Int
    }

    struct UserDomainWrapRecord: Decodable, Equatable, Sendable {
        let id: String
        let resourceType: String
        let resourceId: String
        let domain: UserKeyDomain
        let wrapVersion: String
        let rootKeyId: String
        let rootEpoch: Int
        let domainKeyVersion: Int
        let platformWrapVersion: String?
        let platformKeyId: String?
        let status: String
        let createdAt: String
        let updatedAt: String
        let completedAt: String?
        let envelope: UserDomainWrapEnvelope?
    }

    struct UserDomainWrapEnvelope: Codable, Equatable, Sendable {
        let version: String
        let algorithm: String
        let authUserId: Int
        let rootKeyId: String
        let rootEpoch: Int
        let domainKeyVersion: Int
        let domain: UserKeyDomain
        let resourceType: String
        let resourceId: String
        let iv: String
        let authTag: String
        let ciphertext: String
        let keyCommitment: String
    }

    struct UserDomainMaterialEnvelope: Decodable, Equatable, Sendable {
        let version: String
        let suiteId: String
        let authUserId: Int
        let rootKeyId: String
        let rootEpoch: Int
        let domainKeyVersion: Int
        let domain: UserKeyDomain
        let resourceType: String
        let resourceId: String
        let targetClientId: String
        let targetKeyGeneration: Int
        let targetKEMPublicKey: String
        let encapsulatedKey: String
        let sealedKeyMaterial: String
        let keyCommitment: String
        let createdAt: String
        let expiresAt: String
    }

    struct UserRootChallenge: Decodable, Equatable, Sendable {
        let challengeId: String
        let challenge: String
        let challengeHash: String
        let purpose: String
        let targetClientId: String
        let rootEpoch: Int
        let rootKeyId: String?
        let expiresAt: String

        var challengeData: Data? {
            Data(athenaBase64URL: challenge)
        }
    }

    struct VaultGrant: Equatable, Sendable {
        let token: String
        let expiresAt: String
    }

    struct PendingUserRootEnvelope: Decodable, Sendable {
        let id: String
        let sourceClientId: String
        let targetClientId: String
        let sourceKeyGeneration: Int
        let targetKeyGeneration: Int
        let rootEpoch: Int
        let rootKeyId: String
        let envelope: UserRootEnvelope
        let trustedSource: SigningIdentity
        let createdAt: String
        let expiresAt: String
    }

    enum DistributionError: Error, Equatable {
        case secureEnclaveUnavailable
        case invalidRegistration
        case invalidEnvelope
        case expired
        case challengeMismatch
        case staleKeyEpoch
        case keyEpochStillRequired
        case keyGenerationUnavailable
        case keyGenerationStillRequired
        case decapsulationFailed
        case aeadFailed
        case invalidUserRoot
    }

    struct PendingEnvelope: Decodable, Sendable {
        let id: String
        let sourceClientId: String
        let targetClientId: String
        let keyEpoch: Int
        let envelope: Envelope
        let trustedSource: SigningIdentity
        let createdAt: String
    }

    private struct SuccessResponse: Decodable { let success: Bool }
    private struct RegistrationResponse: Decodable {
        let success: Bool
        let suiteId: String
        let keyGeneration: Int?
    }
    private struct PendingResponse: Decodable {
        let success: Bool
        let envelopes: [PendingEnvelope]
    }
    private struct SubmitResponse: Decodable {
        let success: Bool
        let envelopeId: String
        let keyEpoch: Int
    }
    private struct KeyEpochsResponse: Decodable {
        let success: Bool
        let epochs: [KeyEpochDescriptor]
    }
    private struct KeyEpochResponse: Decodable {
        let success: Bool
        let epoch: KeyEpochDescriptor
    }
    private struct UserRootStatusResponse: Decodable {
        let success: Bool
        let initialized: Bool
        let rootEpoch: Int?
        let rootKeyId: String?
        let derivationSuiteId: String?
        let transportSuiteId: String?
        let status: String
        let initializedByClientId: String?
        let pendingEnvelopes: Int

        var value: UserRootStatus {
            UserRootStatus(
                initialized: initialized,
                rootEpoch: rootEpoch,
                rootKeyId: rootKeyId,
                derivationSuiteId: derivationSuiteId,
                transportSuiteId: transportSuiteId,
                status: status,
                initializedByClientId: initializedByClientId,
                pendingEnvelopes: pendingEnvelopes
            )
        }
    }
    private struct UserRootAuthorizationTargetsResponse: Decodable {
        let success: Bool
        let targets: [DeviceRegistration]
    }
    private struct UserRootChallengeResponse: Decodable {
        let success: Bool
        let challengeId: String
        let challenge: String
        let challengeHash: String
        let purpose: String
        let targetClientId: String
        let rootEpoch: Int
        let rootKeyId: String?
        let expiresAt: String

        var value: UserRootChallenge {
            UserRootChallenge(
                challengeId: challengeId,
                challenge: challenge,
                challengeHash: challengeHash,
                purpose: purpose,
                targetClientId: targetClientId,
                rootEpoch: rootEpoch,
                rootKeyId: rootKeyId,
                expiresAt: expiresAt
            )
        }
    }
    private struct UserRootInitializeResponse: Decodable {
        let success: Bool
        let initialized: Bool
        let rootEpoch: Int
        let rootKeyId: String
    }

    private struct VaultGrantResponse: Decodable {
        let success: Bool
        let vaultGrant: String?
        let expiresAt: String?
    }
    private struct UserRootSubmitResponse: Decodable {
        let success: Bool
        let envelopeId: String
        let rootEpoch: Int
    }
    private struct PendingUserRootResponse: Decodable {
        let success: Bool
        let envelopes: [PendingUserRootEnvelope]
    }
    private struct UserDomainWrapsResponse: Decodable {
        let success: Bool
        let wraps: [UserDomainWrapRecord]
    }
    private struct UserDomainMaterialResponse: Decodable {
        let success: Bool
        let envelope: UserDomainMaterialEnvelope
    }
    private struct UserDomainWrapResponse: Decodable {
        let success: Bool
        let wrap: UserDomainWrapRecord
    }
    private struct UserDomainWrapAADBinding: Encodable {
        let version: String
        let algorithm: String
        let authUserId: Int
        let rootKeyId: String
        let rootEpoch: Int
        let domainKeyVersion: Int
        let domain: UserKeyDomain
        let resourceType: String
        let resourceId: String
    }
    private struct UserDomainTransportBinding: Encodable {
        let authUserId: Int
        let rootKeyId: String
        let rootEpoch: Int
        let domainKeyVersion: Int
        let domain: UserKeyDomain
        let resourceType: String
        let resourceId: String
        let targetClientId: String
        let targetKeyGeneration: Int
        let targetKEMPublicKey: String
    }

    static func register(
        _ registration: DeviceRegistration,
        using apiClient: APIClient
    ) async throws {
        struct Body: Encodable {
            let suiteId: String
            let keyGeneration: Int
            let kemPublicKey: String
            let p256PublicKey: String
            let mlDSA65PublicKey: String
        }
        let response = try await apiClient.requestJSON(
            RegistrationResponse.self,
            method: .post,
            path: "/api/client-identity/vault-kem-key",
            body: Body(
                suiteId: registration.kemSuiteId,
                keyGeneration: registration.keyGeneration,
                kemPublicKey: registration.kemPublicKey,
                p256PublicKey: registration.p256PublicKey,
                mlDSA65PublicKey: registration.mlDSA65PublicKey
            ),
            authorization: .required,
            signing: .required,
            retryOnConnectionLoss: true
        )
        guard
            response.success,
            response.suiteId == suiteId,
            (response.keyGeneration ?? 1) == registration.keyGeneration
        else {
            throw DistributionError.invalidRegistration
        }
    }

    static func userRootStatus(using apiClient: APIClient) async throws
        -> UserRootStatus
    {
        let response = try await apiClient.requestJSON(
            UserRootStatusResponse.self,
            method: .get,
            path: "/api/vault/user-root-key",
            authorization: .required,
            signing: .required
        )
        guard response.success else { throw DistributionError.invalidUserRoot }
        return response.value
    }

    static func passwordVaultGrant(
        currentPassword: String,
        using apiClient: APIClient
    ) async throws -> VaultGrant {
        struct Body: Encodable {
            let currentPassword: String
        }
        let response = try await apiClient.requestJSON(
            VaultGrantResponse.self,
            method: .post,
            path: "/api/vault/reauth/password",
            body: Body(currentPassword: currentPassword),
            authorization: .required,
            signing: .required,
            retryOnConnectionLoss: true
        )
        guard
            response.success,
            let token = response.vaultGrant,
            !token.isEmpty,
            let expiresAt = response.expiresAt,
            let expiration = date(expiresAt),
            expiration > Date()
        else { throw DistributionError.invalidUserRoot }
        return VaultGrant(token: token, expiresAt: expiresAt)
    }

    static func requestUserRootChallenge(
        purpose: String,
        targetClientId: String,
        using apiClient: APIClient
    ) async throws -> UserRootChallenge {
        struct Body: Encodable {
            let purpose: String
            let targetClientId: String
        }
        let response = try await apiClient.requestJSON(
            UserRootChallengeResponse.self,
            method: .post,
            path: "/api/vault/user-root-key/challenge",
            body: Body(
                purpose: purpose,
                targetClientId: targetClientId
            ),
            authorization: .required,
            signing: .required
        )
        guard
            response.success,
            ["initialize", "authorize"].contains(response.purpose),
            let challenge = response.value.challengeData,
            challenge.count == 32,
            sha256(challenge) == response.challengeHash
        else { throw DistributionError.invalidUserRoot }
        return response.value
    }

    static func initializeUserRoot(
        _ envelope: UserRootEnvelope,
        challengeId: String,
        vaultGrant: String,
        using apiClient: APIClient
    ) async throws {
        struct Body: Encodable {
            let rootEpoch: Int
            let challengeId: String
            let envelope: UserRootEnvelope
        }
        let response = try await apiClient.requestJSON(
            UserRootInitializeResponse.self,
            method: .post,
            path: "/api/vault/user-root-key/initialize",
            headers: ["X-Athena-Vault-Grant": vaultGrant],
            body: Body(
                rootEpoch: envelope.rootEpoch,
                challengeId: challengeId,
                envelope: envelope
            ),
            authorization: .required,
            signing: .required,
            retryOnConnectionLoss: true
        )
        guard
            response.success,
            response.rootEpoch == envelope.rootEpoch,
            response.rootKeyId == envelope.rootKeyId
        else { throw DistributionError.invalidUserRoot }
    }

    static func submitUserRootEnvelope(
        _ envelope: UserRootEnvelope,
        challengeId: String,
        vaultGrant: String,
        using apiClient: APIClient
    ) async throws -> String {
        struct Body: Encodable {
            let targetClientId: String
            let rootEpoch: Int
            let challengeId: String
            let envelope: UserRootEnvelope
        }
        let response = try await apiClient.requestJSON(
            UserRootSubmitResponse.self,
            method: .post,
            path: "/api/vault/user-root-key/envelopes",
            headers: ["X-Athena-Vault-Grant": vaultGrant],
            body: Body(
                targetClientId: envelope.targetClientId,
                rootEpoch: envelope.rootEpoch,
                challengeId: challengeId,
                envelope: envelope
            ),
            authorization: .required,
            signing: .required,
            retryOnConnectionLoss: true
        )
        guard response.success, response.rootEpoch == envelope.rootEpoch else {
            throw DistributionError.invalidUserRoot
        }
        return response.envelopeId
    }

    static func pendingUserRootEnvelopes(using apiClient: APIClient) async throws
        -> [PendingUserRootEnvelope]
    {
        let response = try await apiClient.requestJSON(
            PendingUserRootResponse.self,
            method: .get,
            path: "/api/vault/user-root-key/envelopes",
            authorization: .required,
            signing: .required,
            retryOnConnectionLoss: true
        )
        guard response.success else { throw DistributionError.invalidUserRoot }
        return response.envelopes
    }

    static func userRootAuthorizationTargets(using apiClient: APIClient)
        async throws -> [DeviceRegistration]
    {
        let response = try await apiClient.requestJSON(
            UserRootAuthorizationTargetsResponse.self,
            method: .get,
            path: "/api/vault/user-root-key/authorization-targets",
            authorization: .required,
            signing: .required,
            retryOnConnectionLoss: true
        )
        guard response.success else { throw DistributionError.invalidUserRoot }
        return response.targets
    }

    static func consumeUserRootEnvelope(
        _ envelopeId: String,
        using apiClient: APIClient
    ) async throws {
        let response = try await apiClient.requestJSON(
            SuccessResponse.self,
            method: .post,
            path: "/api/vault/user-root-key/envelopes/\(envelopeId)/consume",
            body: [String: String](),
            authorization: .required,
            signing: .required,
            retryOnConnectionLoss: true
        )
        guard response.success else { throw DistributionError.invalidUserRoot }
    }

    static func userDomainWraps(
        status: String? = nil,
        resourceType: String? = nil,
        resourceId: String? = nil,
        includeEnvelope: Bool = true,
        using apiClient: APIClient
    ) async throws -> [UserDomainWrapRecord] {
        var queryItems = [
            URLQueryItem(name: "limit", value: "200"),
            URLQueryItem(
                name: "includeEnvelope",
                value: includeEnvelope ? "true" : "false"
            ),
        ]
        if let status, !status.isEmpty {
            queryItems.append(URLQueryItem(name: "status", value: status))
        }
        if let resourceType, !resourceType.isEmpty {
            queryItems.append(
                URLQueryItem(name: "resourceType", value: resourceType)
            )
        }
        if let resourceId, !resourceId.isEmpty {
            queryItems.append(
                URLQueryItem(name: "resourceId", value: resourceId)
            )
        }
        let response = try await apiClient.requestJSON(
            UserDomainWrapsResponse.self,
            method: .get,
            path: "/api/vault/user-domain-wraps",
            queryItems: queryItems,
            authorization: .required,
            signing: .required,
            retryOnConnectionLoss: true
        )
        guard response.success else { throw DistributionError.invalidEnvelope }
        return response.wraps
    }

    static func pendingUserDomainWraps(
        using apiClient: APIClient
    ) async throws -> [UserDomainWrapRecord] {
        try await userDomainWraps(
            status: "pending",
            includeEnvelope: false,
            using: apiClient
        )
    }

    static func prepareUserDomainWrap(
        _ wrapId: String,
        vaultGrant: String,
        using apiClient: APIClient
    ) async throws -> UserDomainMaterialEnvelope {
        let response = try await apiClient.requestJSON(
            UserDomainMaterialResponse.self,
            method: .post,
            path: "/api/vault/user-domain-wraps/\(wrapId)/prepare",
            headers: ["X-Athena-Vault-Grant": vaultGrant],
            body: [String: String](),
            authorization: .required,
            signing: .required,
            retryOnConnectionLoss: true
        )
        guard response.success else { throw DistributionError.invalidEnvelope }
        return response.envelope
    }

    static func completeUserDomainWrap(
        _ wrapId: String,
        envelope: UserDomainWrapEnvelope,
        using apiClient: APIClient
    ) async throws -> UserDomainWrapRecord {
        struct Body: Encodable {
            let envelope: UserDomainWrapEnvelope
        }
        let response = try await apiClient.requestJSON(
            UserDomainWrapResponse.self,
            method: .put,
            path: "/api/vault/user-domain-wraps/\(wrapId)",
            body: Body(envelope: envelope),
            authorization: .required,
            signing: .required,
            retryOnConnectionLoss: true
        )
        guard response.success else { throw DistributionError.invalidEnvelope }
        return response.wrap
    }

    static func rotateRegistration(
        _ registration: DeviceRegistration,
        using apiClient: APIClient
    ) async throws {
        struct Body: Encodable {
            let suiteId: String
            let keyGeneration: Int
            let kemPublicKey: String
            let p256PublicKey: String
            let mlDSA65PublicKey: String
        }
        let response = try await apiClient.requestJSON(
            RegistrationResponse.self,
            method: .post,
            path: "/api/client-identity/vault-kem-key/rotate",
            body: Body(
                suiteId: registration.kemSuiteId,
                keyGeneration: registration.keyGeneration,
                kemPublicKey: registration.kemPublicKey,
                p256PublicKey: registration.p256PublicKey,
                mlDSA65PublicKey: registration.mlDSA65PublicKey
            ),
            authorization: .required,
            signing: .required
        )
        guard
            response.success,
            response.suiteId == suiteId,
            response.keyGeneration == registration.keyGeneration
        else { throw DistributionError.invalidRegistration }
    }

    static func uploadRecoveryPackage(
        _ package: RecoveryPackage,
        vaultGrant: String,
        using apiClient: APIClient
    ) async throws {
        struct Body: Encodable {
            let recoveryKeyId: String
            let keyEpoch: Int
            let suiteId: String
            let encryptedPackage: RecoveryPackage
        }
        let response = try await apiClient.requestJSON(
            SuccessResponse.self,
            method: .post,
            path: "/api/vault/recovery-packages",
            headers: ["X-Athena-Vault-Grant": vaultGrant],
            body: Body(
                recoveryKeyId: package.recoveryKeyId,
                keyEpoch: package.highestKeyEpoch,
                suiteId: suiteId,
                encryptedPackage: package
            ),
            authorization: .required,
            signing: .required
        )
        guard response.success else { throw DistributionError.invalidEnvelope }
    }

    static func keyEpochs(using apiClient: APIClient) async throws
        -> [KeyEpochDescriptor]
    {
        let response = try await apiClient.requestJSON(
            KeyEpochsResponse.self,
            method: .get,
            path: "/api/vault/key-epochs",
            authorization: .required,
            signing: .required
        )
        guard response.success else { throw DistributionError.invalidEnvelope }
        return response.epochs
    }

    static func beginKeyEpochRotation(
        vaultGrant: String,
        using apiClient: APIClient
    ) async throws -> KeyEpochDescriptor {
        let response = try await apiClient.requestJSON(
            KeyEpochResponse.self,
            method: .post,
            path: "/api/vault/key-epochs/rotate",
            headers: ["X-Athena-Vault-Grant": vaultGrant],
            body: [String: String](),
            authorization: .required,
            signing: .required
        )
        guard response.success else { throw DistributionError.invalidEnvelope }
        return response.epoch
    }

    static func acknowledgeKeyEpoch(
        _ keyEpoch: Int,
        inventoryHash: String?,
        using apiClient: APIClient
    ) async throws {
        struct Body: Encodable { let inventoryHash: String? }
        let response = try await apiClient.requestJSON(
            SuccessResponse.self,
            method: .post,
            path: "/api/vault/key-epochs/\(keyEpoch)/ack",
            body: Body(inventoryHash: inventoryHash),
            authorization: .required,
            signing: .required
        )
        guard response.success else { throw DistributionError.invalidEnvelope }
    }

    static func submit(
        _ envelope: Envelope,
        using apiClient: APIClient
    ) async throws -> String {
        struct Body: Encodable {
            let targetClientId: String
            let keyEpoch: Int
            let envelope: Envelope
        }
        let response = try await apiClient.requestJSON(
            SubmitResponse.self,
            method: .post,
            path: "/api/vault/device-key-envelopes",
            body: Body(
                targetClientId: envelope.targetClientId,
                keyEpoch: envelope.keyEpoch,
                envelope: envelope
            ),
            authorization: .required,
            signing: .required
        )
        guard response.success, response.keyEpoch == envelope.keyEpoch else {
            throw DistributionError.invalidEnvelope
        }
        return response.envelopeId
    }

    static func pending(using apiClient: APIClient) async throws -> [PendingEnvelope] {
        let response = try await apiClient.requestJSON(
            PendingResponse.self,
            method: .get,
            path: "/api/vault/device-key-envelopes",
            authorization: .required,
            signing: .required
        )
        guard response.success else { throw DistributionError.invalidEnvelope }
        return response.envelopes
    }

    static func consume(_ envelopeId: String, using apiClient: APIClient) async throws {
        let response = try await apiClient.requestJSON(
            SuccessResponse.self,
            method: .post,
            path: "/api/vault/device-key-envelopes/\(envelopeId)/consume",
            body: [String: String](),
            authorization: .required,
            signing: .required
        )
        guard response.success else { throw DistributionError.invalidEnvelope }
    }

    private static func reportUnseal(
        outcome: String,
        using apiClient: APIClient
    ) async {
        struct Body: Encodable {
            let category: String
            let operation: String
            let suiteId: String
            let outcome: String
        }
        _ = try? await apiClient.requestJSON(
            SuccessResponse.self,
            method: .post,
            path: "/api/client-identity/crypto-observations",
            body: Body(
                category: "vault_kem",
                operation: "unseal",
                suiteId: suiteId,
                outcome: outcome
            ),
            authorization: .required,
            signing: .required
        )
    }

    static func openAndReport(
        _ envelope: Envelope,
        challenge: Data,
        targetKeys: DeviceKeys,
        trustedSource: SigningIdentity,
        minimumKeyEpoch: Int = 0,
        using apiClient: APIClient,
        now: Date = Date()
    ) async throws -> KeyMaterial {
        do {
            let material = try open(
                envelope,
                challenge: challenge,
                targetKeys: targetKeys,
                trustedSource: trustedSource,
                minimumKeyEpoch: minimumKeyEpoch,
                now: now
            )
            await reportUnseal(outcome: "success", using: apiClient)
            return material
        } catch let error as DistributionError {
            let outcome: String
            switch error {
            case .staleKeyEpoch:
                outcome = "epoch_mismatch"
            case .keyEpochStillRequired, .keyGenerationUnavailable,
                 .keyGenerationStillRequired:
                outcome = "epoch_mismatch"
            case .invalidEnvelope, .expired, .challengeMismatch:
                outcome = "invalid_envelope"
            case .decapsulationFailed, .secureEnclaveUnavailable, .invalidRegistration:
                outcome = "decapsulation_failed"
            case .aeadFailed:
                outcome = "aead_failed"
            case .invalidUserRoot:
                outcome = "invalid_envelope"
            }
            await reportUnseal(outcome: outcome, using: apiClient)
            throw error
        } catch {
            await reportUnseal(outcome: "decapsulation_failed", using: apiClient)
            throw error
        }
    }

    static func deriveUserKey(
        _ material: UserRootKeyMaterial,
        domain: UserKeyDomain
    ) throws -> Data {
        guard
            material.version == "athena-user-root-key-material:v1",
            material.userRootKey.count == 32,
            material.authUserId > 0,
            material.rootEpoch > 0,
            material.derivationSuiteId == userRootDerivationSuiteId,
            material.rootKeyId == sha256(material.userRootKey)
        else { throw DistributionError.invalidUserRoot }
        let saltInput = Data(
            "athena-user-root-salt:v1\u{0}\(material.authUserId)\u{0}\(material.rootEpoch)".utf8
        )
        let salt = Data(SHA256.hash(data: saltInput))
        let info = Data(
            "athena-user-root-domain:v1\u{0}\(userRootDerivationSuiteId)\u{0}\(domain.rawValue)".utf8
        )
        let key = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: material.userRootKey),
            salt: salt,
            info: info,
            outputByteCount: 32
        )
        return key.withUnsafeBytes { Data($0) }
    }

    static func wrapUserDomainKey(
        _ keyMaterial: Data,
        root: UserRootKeyMaterial,
        domain: UserKeyDomain,
        resourceType: String,
        resourceId: String,
        domainKeyVersion: Int = 1
    ) throws -> UserDomainWrapEnvelope {
        let version = "athena-user-domain-key-wrap:v1"
        let algorithm = "aes-256-gcm"
        guard
            keyMaterial.count == 32,
            root.authUserId > 0,
            root.rootEpoch > 0,
            domainKeyVersion > 0,
            ["chat-conversation-key", "content-object", "vault-master-key",
             "direct-field-dek"].contains(resourceType),
            !resourceId.isEmpty
        else { throw DistributionError.invalidEnvelope }
        let binding = UserDomainWrapAADBinding(
            version: version,
            algorithm: algorithm,
            authUserId: root.authUserId,
            rootKeyId: root.rootKeyId,
            rootEpoch: root.rootEpoch,
            domainKeyVersion: domainKeyVersion,
            domain: domain,
            resourceType: resourceType,
            resourceId: resourceId
        )
        let domainKey = try deriveUserKey(root, domain: domain)
        let sealed: AES.GCM.SealedBox
        do {
            sealed = try AES.GCM.seal(
                keyMaterial,
                using: SymmetricKey(data: domainKey),
                authenticating: canonicalData(binding)
            )
        } catch {
            throw DistributionError.aeadFailed
        }
        return UserDomainWrapEnvelope(
            version: version,
            algorithm: algorithm,
            authUserId: root.authUserId,
            rootKeyId: root.rootKeyId,
            rootEpoch: root.rootEpoch,
            domainKeyVersion: domainKeyVersion,
            domain: domain,
            resourceType: resourceType,
            resourceId: resourceId,
            iv: Data(sealed.nonce).athenaBase64URL(),
            authTag: sealed.tag.athenaBase64URL(),
            ciphertext: sealed.ciphertext.athenaBase64URL(),
            keyCommitment: sha256(keyMaterial)
        )
    }

    static func unwrapUserDomainKey(
        _ envelope: UserDomainWrapEnvelope,
        root: UserRootKeyMaterial
    ) throws -> Data {
        guard
            envelope.version == "athena-user-domain-key-wrap:v1",
            envelope.algorithm == "aes-256-gcm",
            envelope.authUserId == root.authUserId,
            envelope.rootKeyId == root.rootKeyId,
            envelope.rootEpoch == root.rootEpoch,
            envelope.domainKeyVersion > 0,
            let nonceData = Data(athenaBase64URL: envelope.iv),
            nonceData.count == 12,
            let nonce = try? AES.GCM.Nonce(data: nonceData),
            let ciphertext = Data(athenaBase64URL: envelope.ciphertext),
            ciphertext.count == 32,
            let tag = Data(athenaBase64URL: envelope.authTag),
            tag.count == 16
        else { throw DistributionError.invalidEnvelope }
        let binding = UserDomainWrapAADBinding(
            version: envelope.version,
            algorithm: envelope.algorithm,
            authUserId: envelope.authUserId,
            rootKeyId: envelope.rootKeyId,
            rootEpoch: envelope.rootEpoch,
            domainKeyVersion: envelope.domainKeyVersion,
            domain: envelope.domain,
            resourceType: envelope.resourceType,
            resourceId: envelope.resourceId
        )
        let box = try AES.GCM.SealedBox(
            nonce: nonce,
            ciphertext: ciphertext,
            tag: tag
        )
        let plaintext: Data
        do {
            plaintext = try AES.GCM.open(
                box,
                using: SymmetricKey(
                    data: deriveUserKey(root, domain: envelope.domain)
                ),
                authenticating: canonicalData(binding)
            )
        } catch {
            throw DistributionError.aeadFailed
        }
        guard
            plaintext.count == 32,
            sha256(plaintext) == envelope.keyCommitment
        else { throw DistributionError.invalidEnvelope }
        return plaintext
    }

    static func openUserDomainMaterial(
        _ envelope: UserDomainMaterialEnvelope,
        root: UserRootKeyMaterial,
        targetClientId: String,
        targetKeys: DeviceKeys,
        now: Date = Date()
    ) throws -> Data {
        let registration = targetKeys.registration(clientId: targetClientId)
        guard
            envelope.version == "athena-user-domain-material-envelope:v1",
            envelope.suiteId == suiteId,
            envelope.authUserId == root.authUserId,
            envelope.rootKeyId == root.rootKeyId,
            envelope.rootEpoch == root.rootEpoch,
            envelope.domainKeyVersion > 0,
            envelope.targetClientId == targetClientId,
            envelope.targetKeyGeneration == targetKeys.keyGeneration,
            envelope.targetKEMPublicKey == registration.kemPublicKey,
            let creation = date(envelope.createdAt),
            let expiration = date(envelope.expiresAt),
            creation <= now.addingTimeInterval(60),
            expiration > now,
            expiration.timeIntervalSince(creation) <= 2 * 60,
            let encapsulated = Data(
                athenaBase64URL: envelope.encapsulatedKey
            ),
            let sealed = Data(athenaBase64URL: envelope.sealedKeyMaterial)
        else { throw DistributionError.invalidEnvelope }
        let binding = UserDomainTransportBinding(
            authUserId: envelope.authUserId,
            rootKeyId: envelope.rootKeyId,
            rootEpoch: envelope.rootEpoch,
            domainKeyVersion: envelope.domainKeyVersion,
            domain: envelope.domain,
            resourceType: envelope.resourceType,
            resourceId: envelope.resourceId,
            targetClientId: envelope.targetClientId,
            targetKeyGeneration: envelope.targetKeyGeneration,
            targetKEMPublicKey: envelope.targetKEMPublicKey
        )
        let secret: SymmetricKey
        do {
            secret = try targetKeys.kem.decapsulate(encapsulated)
        } catch {
            throw DistributionError.decapsulationFailed
        }
        let transportInfo = Data(
            SHA256.hash(
                data: Data(
                    "athena-user-domain-material-info:v1\u{0}".utf8
                ) + (try canonicalData(binding))
            )
        )
        let wrappingKey = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: secret,
            salt: Data("athena-user-domain-material-kem:v1".utf8),
            info: transportInfo,
            outputByteCount: 32
        )
        let plaintext: Data
        do {
            let box = try AES.GCM.SealedBox(combined: sealed)
            plaintext = try AES.GCM.open(
                box,
                using: wrappingKey,
                authenticating: Data(
                    "athena-user-domain-material-aad:v1\u{0}".utf8
                ) + canonicalData(binding)
            )
        } catch {
            throw DistributionError.aeadFailed
        }
        guard
            plaintext.count == 32,
            sha256(plaintext) == envelope.keyCommitment
        else { throw DistributionError.invalidEnvelope }
        return plaintext
    }

    static func sealUserRoot(
        _ material: UserRootKeyMaterial,
        challengeId: String,
        challenge: Data,
        sourceClientId: String,
        sourceKeys: DeviceKeys,
        target: DeviceRegistration,
        now: Date = Date(),
        ttl: TimeInterval = 10 * 60
    ) throws -> UserRootEnvelope {
        guard
            material.version == "athena-user-root-key-material:v1",
            material.userRootKey.count == 32,
            material.authUserId > 0,
            material.rootEpoch > 0,
            material.derivationSuiteId == userRootDerivationSuiteId,
            material.rootKeyId == sha256(material.userRootKey),
            !challengeId.isEmpty,
            challenge.count == 32,
            target.kemSuiteId == suiteId,
            let targetKeyData = Data(athenaBase64URL: target.kemPublicKey),
            let targetKey = try? XWingMLKEM768X25519.PublicKey(
                rawRepresentation: targetKeyData
            )
        else { throw DistributionError.invalidUserRoot }
        let challengeHash = sha256(challenge)
        let encapsulation = try targetKey.encapsulate()
        let binding = userRootEnvelopeBinding(
            authUserId: material.authUserId,
            sourceClientId: sourceClientId,
            targetClientId: target.clientId,
            rootEpoch: material.rootEpoch,
            rootKeyId: material.rootKeyId,
            challengeId: challengeId,
            challengeHash: challengeHash
        )
        let wrappingKey = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: encapsulation.sharedSecret,
            salt: Data("athena-user-root-envelope-kem:v1".utf8),
            info: Data("athena-user-root-envelope-info:v1\u{0}\(binding)".utf8),
            outputByteCount: 32
        )
        let plaintext = try canonicalData(material)
        guard let sealed = try AES.GCM.seal(
            plaintext,
            using: wrappingKey,
            authenticating: Data(
                "athena-user-root-envelope-aad:v1\u{0}\(binding)".utf8
            )
        ).combined else { throw DistributionError.aeadFailed }
        let unsigned = UnsignedUserRootEnvelope(
            version: userRootEnvelopeVersion,
            materialType: "user-root-key",
            derivationSuiteId: userRootDerivationSuiteId,
            transportSuiteId: suiteId,
            authUserId: material.authUserId,
            sourceClientId: sourceClientId,
            targetClientId: target.clientId,
            sourceKeyGeneration: sourceKeys.keyGeneration,
            targetKeyGeneration: target.keyGeneration,
            targetKEMPublicKey: target.kemPublicKey,
            rootEpoch: material.rootEpoch,
            rootKeyId: material.rootKeyId,
            challengeId: challengeId,
            challenge: challenge.athenaBase64URL(),
            challengeSHA256: challengeHash,
            encapsulatedKey: encapsulation.encapsulated.athenaBase64URL(),
            sealedRootKey: sealed.athenaBase64URL(),
            p256PublicKey: sourceKeys.p256.publicKey.x963Representation
                .athenaBase64URL(),
            mlDSA65PublicKey: sourceKeys.mlDSA65.publicKey.rawRepresentation
                .athenaBase64URL(),
            createdAt: timestamp(now),
            expiresAt: timestamp(now.addingTimeInterval(ttl))
        )
        let payload = try canonicalData(unsigned)
        return UserRootEnvelope(
            version: unsigned.version,
            materialType: unsigned.materialType,
            derivationSuiteId: unsigned.derivationSuiteId,
            transportSuiteId: unsigned.transportSuiteId,
            authUserId: unsigned.authUserId,
            sourceClientId: unsigned.sourceClientId,
            targetClientId: unsigned.targetClientId,
            sourceKeyGeneration: unsigned.sourceKeyGeneration,
            targetKeyGeneration: unsigned.targetKeyGeneration,
            targetKEMPublicKey: unsigned.targetKEMPublicKey,
            rootEpoch: unsigned.rootEpoch,
            rootKeyId: unsigned.rootKeyId,
            challengeId: unsigned.challengeId,
            challenge: unsigned.challenge,
            challengeSHA256: unsigned.challengeSHA256,
            encapsulatedKey: unsigned.encapsulatedKey,
            sealedRootKey: unsigned.sealedRootKey,
            p256PublicKey: unsigned.p256PublicKey,
            p256Signature: try sourceKeys.p256.signature(for: payload)
                .rawRepresentation.athenaBase64URL(),
            mlDSA65PublicKey: unsigned.mlDSA65PublicKey,
            mlDSA65Signature: try sourceKeys.mlDSA65.signature(for: payload)
                .athenaBase64URL(),
            createdAt: unsigned.createdAt,
            expiresAt: unsigned.expiresAt
        )
    }

    static func openUserRoot(
        _ envelope: UserRootEnvelope,
        targetKeys: DeviceKeys,
        trustedSource: SigningIdentity,
        expectedAuthUserId: Int,
        minimumRootEpoch: Int = 0,
        now: Date = Date()
    ) throws -> UserRootKeyMaterial {
        let target = targetKeys.registration(clientId: envelope.targetClientId)
        guard
            let challenge = Data(athenaBase64URL: envelope.challenge),
            challenge.count == 32,
            challenge.athenaBase64URL() == envelope.challenge
        else { throw DistributionError.invalidUserRoot }
        guard envelope.rootEpoch > minimumRootEpoch else {
            throw DistributionError.staleKeyEpoch
        }
        guard
            envelope.version == userRootEnvelopeVersion,
            envelope.materialType == "user-root-key",
            envelope.derivationSuiteId == userRootDerivationSuiteId,
            envelope.transportSuiteId == suiteId,
            envelope.authUserId == expectedAuthUserId,
            trustedSource.suiteId == suiteId,
            envelope.sourceClientId == trustedSource.clientId,
            envelope.sourceKeyGeneration ==
                (trustedSource.keyGeneration ?? 1),
            envelope.targetKeyGeneration == targetKeys.keyGeneration,
            envelope.p256PublicKey == trustedSource.p256PublicKey,
            envelope.mlDSA65PublicKey == trustedSource.mlDSA65PublicKey,
            envelope.targetKEMPublicKey == target.kemPublicKey,
            envelope.challengeSHA256 == sha256(challenge),
            let expiration = date(envelope.expiresAt),
            let creation = date(envelope.createdAt),
            creation <= now.addingTimeInterval(60),
            expiration > now,
            expiration.timeIntervalSince(creation) <= 10 * 60,
            let p256KeyData = Data(athenaBase64URL: envelope.p256PublicKey),
            let p256Key = try? P256.Signing.PublicKey(
                x963Representation: p256KeyData
            ),
            let p256SignatureData = Data(
                athenaBase64URL: envelope.p256Signature
            ),
            let p256Signature = try? P256.Signing.ECDSASignature(
                rawRepresentation: p256SignatureData
            ),
            let pqKeyData = Data(
                athenaBase64URL: envelope.mlDSA65PublicKey
            ),
            let pqKey = try? MLDSA65.PublicKey(
                rawRepresentation: pqKeyData
            ),
            let pqSignature = Data(
                athenaBase64URL: envelope.mlDSA65Signature
            ),
            let encapsulated = Data(
                athenaBase64URL: envelope.encapsulatedKey
            ),
            let sealed = Data(athenaBase64URL: envelope.sealedRootKey)
        else { throw DistributionError.invalidUserRoot }
        let unsigned = UnsignedUserRootEnvelope(envelope)
        let payload = try canonicalData(unsigned)
        guard
            p256Key.isValidSignature(p256Signature, for: payload),
            pqKey.isValidSignature(pqSignature, for: payload)
        else { throw DistributionError.invalidUserRoot }
        let secret: SymmetricKey
        do {
            secret = try targetKeys.kem.decapsulate(encapsulated)
        } catch {
            throw DistributionError.decapsulationFailed
        }
        let binding = userRootEnvelopeBinding(
            authUserId: envelope.authUserId,
            sourceClientId: envelope.sourceClientId,
            targetClientId: envelope.targetClientId,
            rootEpoch: envelope.rootEpoch,
            rootKeyId: envelope.rootKeyId,
            challengeId: envelope.challengeId,
            challengeHash: envelope.challengeSHA256
        )
        let wrappingKey = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: secret,
            salt: Data("athena-user-root-envelope-kem:v1".utf8),
            info: Data("athena-user-root-envelope-info:v1\u{0}\(binding)".utf8),
            outputByteCount: 32
        )
        let plaintext: Data
        do {
            plaintext = try AES.GCM.open(
                AES.GCM.SealedBox(combined: sealed),
                using: wrappingKey,
                authenticating: Data(
                    "athena-user-root-envelope-aad:v1\u{0}\(binding)".utf8
                )
            )
        } catch {
            throw DistributionError.aeadFailed
        }
        let material = try JSONDecoder().decode(
            UserRootKeyMaterial.self,
            from: plaintext
        )
        guard
            material.version == "athena-user-root-key-material:v1",
            material.userRootKey.count == 32,
            material.authUserId == expectedAuthUserId,
            material.rootEpoch == envelope.rootEpoch,
            material.rootKeyId == envelope.rootKeyId,
            material.rootKeyId == sha256(material.userRootKey),
            material.derivationSuiteId == userRootDerivationSuiteId
        else { throw DistributionError.invalidUserRoot }
        return material
    }

    static func seal(
        umk: Data,
        vmk: Data,
        keyEpoch: Int,
        challenge: Data,
        sourceClientId: String,
        sourceKeys: DeviceKeys,
        target: DeviceRegistration,
        now: Date = Date(),
        ttl: TimeInterval = 10 * 60
    ) throws -> Envelope {
        guard
            !umk.isEmpty,
            !vmk.isEmpty,
            keyEpoch > 0,
            target.kemSuiteId == suiteId,
            let targetKeyData = Data(athenaBase64URL: target.kemPublicKey),
            let targetKey = try? XWingMLKEM768X25519.PublicKey(
                rawRepresentation: targetKeyData
            )
        else { throw DistributionError.invalidRegistration }
        let challengeHash = sha256(challenge)
        let encapsulation = try targetKey.encapsulate()
        let wrappingKey = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: encapsulation.sharedSecret,
            salt: Data("athena-vault-hybrid-kem:v1".utf8),
            info: Data("\(target.clientId):\(keyEpoch):\(challengeHash)".utf8),
            outputByteCount: 32
        )
        let plaintext = try canonicalData(KeyMaterial(umk: umk, vmk: vmk, keyEpoch: keyEpoch))
        let aad = Data("\(sourceClientId):\(target.clientId):\(keyEpoch)".utf8)
        guard let sealed = try AES.GCM.seal(
            plaintext,
            using: wrappingKey,
            authenticating: aad
        ).combined else { throw DistributionError.invalidEnvelope }
        let unsigned = UnsignedEnvelope(
            version: envelopeVersion,
            kemSuiteId: suiteId,
            sourceClientId: sourceClientId,
            targetClientId: target.clientId,
            sourceKeyGeneration: sourceKeys.keyGeneration,
            targetKeyGeneration: target.keyGeneration,
            targetKEMPublicKey: target.kemPublicKey,
            keyEpoch: keyEpoch,
            challengeSHA256: challengeHash,
            encapsulatedKey: encapsulation.encapsulated.athenaBase64URL(),
            sealedKeyMaterial: sealed.athenaBase64URL(),
            p256PublicKey: sourceKeys.p256.publicKey.x963Representation.athenaBase64URL(),
            mlDSA65PublicKey: sourceKeys.mlDSA65.publicKey.rawRepresentation.athenaBase64URL(),
            createdAt: timestamp(now),
            expiresAt: timestamp(now.addingTimeInterval(ttl))
        )
        let payload = try canonicalData(unsigned)
        return Envelope(
            version: unsigned.version,
            kemSuiteId: unsigned.kemSuiteId,
            sourceClientId: unsigned.sourceClientId,
            targetClientId: unsigned.targetClientId,
            sourceKeyGeneration: unsigned.sourceKeyGeneration,
            targetKeyGeneration: unsigned.targetKeyGeneration,
            targetKEMPublicKey: unsigned.targetKEMPublicKey,
            keyEpoch: unsigned.keyEpoch,
            challengeSHA256: unsigned.challengeSHA256,
            encapsulatedKey: unsigned.encapsulatedKey,
            sealedKeyMaterial: unsigned.sealedKeyMaterial,
            p256PublicKey: unsigned.p256PublicKey,
            p256Signature: try sourceKeys.p256.signature(for: payload).rawRepresentation.athenaBase64URL(),
            mlDSA65PublicKey: unsigned.mlDSA65PublicKey,
            mlDSA65Signature: try sourceKeys.mlDSA65.signature(for: payload).athenaBase64URL(),
            createdAt: unsigned.createdAt,
            expiresAt: unsigned.expiresAt
        )
    }

    static func open(
        _ envelope: Envelope,
        challenge: Data,
        targetKeys: DeviceKeys,
        trustedSource: SigningIdentity,
        minimumKeyEpoch: Int = 0,
        now: Date = Date()
    ) throws -> KeyMaterial {
        let target = targetKeys.registration(clientId: envelope.targetClientId)
        guard envelope.keyEpoch > minimumKeyEpoch else {
            throw DistributionError.staleKeyEpoch
        }
        guard
            ["athena-vault-key-envelope:v1", envelopeVersion].contains(
                envelope.version
            ),
            envelope.kemSuiteId == suiteId,
            trustedSource.suiteId == suiteId,
            envelope.sourceClientId == trustedSource.clientId,
            (envelope.sourceKeyGeneration ?? 1) ==
                (trustedSource.keyGeneration ?? 1),
            (envelope.targetKeyGeneration ?? 1) ==
                targetKeys.keyGeneration,
            envelope.p256PublicKey == trustedSource.p256PublicKey,
            envelope.mlDSA65PublicKey == trustedSource.mlDSA65PublicKey,
            envelope.targetKEMPublicKey == target.kemPublicKey,
            envelope.challengeSHA256 == sha256(challenge),
            let expiration = date(envelope.expiresAt),
            let creation = date(envelope.createdAt),
            creation <= now.addingTimeInterval(60),
            expiration > now,
            expiration.timeIntervalSince(creation) <= 10 * 60,
            let p256KeyData = Data(athenaBase64URL: envelope.p256PublicKey),
            let p256Key = try? P256.Signing.PublicKey(x963Representation: p256KeyData),
            let p256SignatureData = Data(athenaBase64URL: envelope.p256Signature),
            let p256Signature = try? P256.Signing.ECDSASignature(
                rawRepresentation: p256SignatureData
            ),
            let pqKeyData = Data(athenaBase64URL: envelope.mlDSA65PublicKey),
            let pqKey = try? MLDSA65.PublicKey(rawRepresentation: pqKeyData),
            let pqSignature = Data(athenaBase64URL: envelope.mlDSA65Signature),
            let encapsulated = Data(athenaBase64URL: envelope.encapsulatedKey),
            let sealed = Data(athenaBase64URL: envelope.sealedKeyMaterial)
        else { throw DistributionError.invalidEnvelope }
        let unsigned = UnsignedEnvelope(envelope)
        let payload = try canonicalData(unsigned)
        guard
            p256Key.isValidSignature(p256Signature, for: payload),
            pqKey.isValidSignature(pqSignature, for: payload)
        else { throw DistributionError.invalidEnvelope }
        let secret: SymmetricKey
        do {
            secret = try targetKeys.kem.decapsulate(encapsulated)
        } catch {
            throw DistributionError.decapsulationFailed
        }
        let wrappingKey = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: secret,
            salt: Data("athena-vault-hybrid-kem:v1".utf8),
            info: Data("\(envelope.targetClientId):\(envelope.keyEpoch):\(envelope.challengeSHA256)".utf8),
            outputByteCount: 32
        )
        let plaintext: Data
        do {
            let box = try AES.GCM.SealedBox(combined: sealed)
            plaintext = try AES.GCM.open(
                box,
                using: wrappingKey,
                authenticating: Data(
                    "\(envelope.sourceClientId):\(envelope.targetClientId):\(envelope.keyEpoch)".utf8
                )
            )
        } catch {
            throw DistributionError.aeadFailed
        }
        let material = try JSONDecoder().decode(KeyMaterial.self, from: plaintext)
        guard material.keyEpoch == envelope.keyEpoch else {
            throw DistributionError.invalidEnvelope
        }
        return material
    }

    private struct UnsignedUserRootEnvelope: Codable {
        let version: String
        let materialType: String
        let derivationSuiteId: String
        let transportSuiteId: String
        let authUserId: Int
        let sourceClientId: String
        let targetClientId: String
        let sourceKeyGeneration: Int
        let targetKeyGeneration: Int
        let targetKEMPublicKey: String
        let rootEpoch: Int
        let rootKeyId: String
        let challengeId: String
        let challenge: String
        let challengeSHA256: String
        let encapsulatedKey: String
        let sealedRootKey: String
        let p256PublicKey: String
        let mlDSA65PublicKey: String
        let createdAt: String
        let expiresAt: String

        init(_ envelope: UserRootEnvelope) {
            version = envelope.version
            materialType = envelope.materialType
            derivationSuiteId = envelope.derivationSuiteId
            transportSuiteId = envelope.transportSuiteId
            authUserId = envelope.authUserId
            sourceClientId = envelope.sourceClientId
            targetClientId = envelope.targetClientId
            sourceKeyGeneration = envelope.sourceKeyGeneration
            targetKeyGeneration = envelope.targetKeyGeneration
            targetKEMPublicKey = envelope.targetKEMPublicKey
            rootEpoch = envelope.rootEpoch
            rootKeyId = envelope.rootKeyId
            challengeId = envelope.challengeId
            challenge = envelope.challenge
            challengeSHA256 = envelope.challengeSHA256
            encapsulatedKey = envelope.encapsulatedKey
            sealedRootKey = envelope.sealedRootKey
            p256PublicKey = envelope.p256PublicKey
            mlDSA65PublicKey = envelope.mlDSA65PublicKey
            createdAt = envelope.createdAt
            expiresAt = envelope.expiresAt
        }

        init(
            version: String,
            materialType: String,
            derivationSuiteId: String,
            transportSuiteId: String,
            authUserId: Int,
            sourceClientId: String,
            targetClientId: String,
            sourceKeyGeneration: Int,
            targetKeyGeneration: Int,
            targetKEMPublicKey: String,
            rootEpoch: Int,
            rootKeyId: String,
            challengeId: String,
            challenge: String,
            challengeSHA256: String,
            encapsulatedKey: String,
            sealedRootKey: String,
            p256PublicKey: String,
            mlDSA65PublicKey: String,
            createdAt: String,
            expiresAt: String
        ) {
            self.version = version
            self.materialType = materialType
            self.derivationSuiteId = derivationSuiteId
            self.transportSuiteId = transportSuiteId
            self.authUserId = authUserId
            self.sourceClientId = sourceClientId
            self.targetClientId = targetClientId
            self.sourceKeyGeneration = sourceKeyGeneration
            self.targetKeyGeneration = targetKeyGeneration
            self.targetKEMPublicKey = targetKEMPublicKey
            self.rootEpoch = rootEpoch
            self.rootKeyId = rootKeyId
            self.challengeId = challengeId
            self.challenge = challenge
            self.challengeSHA256 = challengeSHA256
            self.encapsulatedKey = encapsulatedKey
            self.sealedRootKey = sealedRootKey
            self.p256PublicKey = p256PublicKey
            self.mlDSA65PublicKey = mlDSA65PublicKey
            self.createdAt = createdAt
            self.expiresAt = expiresAt
        }
    }

    private static func userRootEnvelopeBinding(
        authUserId: Int,
        sourceClientId: String,
        targetClientId: String,
        rootEpoch: Int,
        rootKeyId: String,
        challengeId: String,
        challengeHash: String
    ) -> String {
        [
            userRootEnvelopeVersion,
            userRootDerivationSuiteId,
            suiteId,
            String(authUserId),
            sourceClientId,
            targetClientId,
            String(rootEpoch),
            rootKeyId,
            challengeId,
            challengeHash,
        ].joined(separator: "\u{0}")
    }

    private struct UnsignedEnvelope: Codable {
        let version: String
        let kemSuiteId: String
        let sourceClientId: String
        let targetClientId: String
        let sourceKeyGeneration: Int?
        let targetKeyGeneration: Int?
        let targetKEMPublicKey: String
        let keyEpoch: Int
        let challengeSHA256: String
        let encapsulatedKey: String
        let sealedKeyMaterial: String
        let p256PublicKey: String
        let mlDSA65PublicKey: String
        let createdAt: String
        let expiresAt: String

        init(_ envelope: Envelope) {
            version = envelope.version
            kemSuiteId = envelope.kemSuiteId
            sourceClientId = envelope.sourceClientId
            targetClientId = envelope.targetClientId
            sourceKeyGeneration = envelope.sourceKeyGeneration
            targetKeyGeneration = envelope.targetKeyGeneration
            targetKEMPublicKey = envelope.targetKEMPublicKey
            keyEpoch = envelope.keyEpoch
            challengeSHA256 = envelope.challengeSHA256
            encapsulatedKey = envelope.encapsulatedKey
            sealedKeyMaterial = envelope.sealedKeyMaterial
            p256PublicKey = envelope.p256PublicKey
            mlDSA65PublicKey = envelope.mlDSA65PublicKey
            createdAt = envelope.createdAt
            expiresAt = envelope.expiresAt
        }

        init(
            version: String,
            kemSuiteId: String,
            sourceClientId: String,
            targetClientId: String,
            sourceKeyGeneration: Int?,
            targetKeyGeneration: Int?,
            targetKEMPublicKey: String,
            keyEpoch: Int,
            challengeSHA256: String,
            encapsulatedKey: String,
            sealedKeyMaterial: String,
            p256PublicKey: String,
            mlDSA65PublicKey: String,
            createdAt: String,
            expiresAt: String
        ) {
            self.version = version
            self.kemSuiteId = kemSuiteId
            self.sourceClientId = sourceClientId
            self.targetClientId = targetClientId
            self.sourceKeyGeneration = sourceKeyGeneration
            self.targetKeyGeneration = targetKeyGeneration
            self.targetKEMPublicKey = targetKEMPublicKey
            self.keyEpoch = keyEpoch
            self.challengeSHA256 = challengeSHA256
            self.encapsulatedKey = encapsulatedKey
            self.sealedKeyMaterial = sealedKeyMaterial
            self.p256PublicKey = p256PublicKey
            self.mlDSA65PublicKey = mlDSA65PublicKey
            self.createdAt = createdAt
            self.expiresAt = expiresAt
        }
    }

    private static func canonicalData<T: Encodable>(_ value: T) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(value)
    }

    private static func sha256(_ data: Data) -> String {
        Data(SHA256.hash(data: data)).athenaBase64URL()
    }

    static func makeRecoverySecret() -> Data {
        SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
    }

    static func sealRecoveryPackage(
        materials: [KeyMaterial],
        recoverySecret: Data,
        recoveryKeyId: String,
        now: Date = Date()
    ) throws -> RecoveryPackage {
        guard
            recoverySecret.count >= 32,
            !materials.isEmpty,
            materials.allSatisfy({ $0.keyEpoch > 0 }),
            Set(materials.map(\.keyEpoch)).count == materials.count,
            !recoveryKeyId.isEmpty
        else { throw DistributionError.invalidEnvelope }
        let salt = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
        let wrappingKey = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: recoverySecret),
            salt: salt,
            info: Data("athena-vault-recovery-package:v1".utf8),
            outputByteCount: 32
        )
        let payload = try canonicalData(materials.sorted {
            $0.keyEpoch < $1.keyEpoch
        })
        guard let sealed = try AES.GCM.seal(
            payload,
            using: wrappingKey,
            authenticating: Data(recoveryKeyId.utf8)
        ).combined else { throw DistributionError.aeadFailed }
        return RecoveryPackage(
            version: "athena-vault-recovery-package:v1",
            recoveryKeyId: recoveryKeyId,
            highestKeyEpoch: materials.map(\.keyEpoch).max() ?? 0,
            salt: salt.athenaBase64URL(),
            sealedEpochMaterials: sealed.athenaBase64URL(),
            createdAt: timestamp(now)
        )
    }

    static func openRecoveryPackage(
        _ package: RecoveryPackage,
        recoverySecret: Data
    ) throws -> [KeyMaterial] {
        guard
            package.version == "athena-vault-recovery-package:v1",
            recoverySecret.count >= 32,
            let salt = Data(athenaBase64URL: package.salt),
            let combined = Data(athenaBase64URL: package.sealedEpochMaterials)
        else { throw DistributionError.invalidEnvelope }
        let wrappingKey = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: recoverySecret),
            salt: salt,
            info: Data("athena-vault-recovery-package:v1".utf8),
            outputByteCount: 32
        )
        do {
            let plaintext = try AES.GCM.open(
                AES.GCM.SealedBox(combined: combined),
                using: wrappingKey,
                authenticating: Data(package.recoveryKeyId.utf8)
            )
            let materials = try JSONDecoder().decode(
                [KeyMaterial].self,
                from: plaintext
            )
            guard materials.map(\.keyEpoch).max() == package.highestKeyEpoch else {
                throw DistributionError.invalidEnvelope
            }
            return materials
        } catch let error as DistributionError {
            throw error
        } catch {
            throw DistributionError.aeadFailed
        }
    }

    private static func timestamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    private static func date(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value)
    }
}

private extension Data {
    init?(athenaBase64URL value: String) {
        var normalized = value
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let remainder = normalized.count % 4
        if remainder != 0 {
            normalized += String(repeating: "=", count: 4 - remainder)
        }
        self.init(base64Encoded: normalized)
    }

    func athenaBase64URL() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
