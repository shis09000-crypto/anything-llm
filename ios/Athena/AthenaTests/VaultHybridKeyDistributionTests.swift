import Foundation
import CryptoKit
import Testing
@testable import Athena

@Suite("Vault hybrid key distribution")
struct VaultHybridKeyDistributionTests {
    @Test
    @available(iOS 26.0, *)
    func persistsDeviceSigningAndKEMKeysAsOneProtectedBundle() throws {
        guard SecureEnclave.isAvailable else { return }
        let store = InMemorySecureValueStore()
        let first = try VaultHybridKeyDistribution.DeviceKeys.loadOrCreate(
            secureStore: store
        )
        let second = try VaultHybridKeyDistribution.DeviceKeys.loadOrCreate(
            secureStore: store
        )
        #expect(
            first.registration(clientId: "device-1") ==
                second.registration(clientId: "device-1")
        )
    }

    @Test
    @available(iOS 26.0, *)
    func distributesUMKAndVMKWithHybridKEMAndDualSignatures() throws {
        guard SecureEnclave.isAvailable else { return }
        let source = try VaultHybridKeyDistribution.DeviceKeys()
        let target = try VaultHybridKeyDistribution.DeviceKeys()
        let sourceIdentity = source.registration(clientId: "source-device").signingIdentity
        let challenge = Data("vault-enrollment-challenge".utf8)
        let material = VaultHybridKeyDistribution.KeyMaterial(
            umk: Data(repeating: 7, count: 32),
            vmk: Data(repeating: 9, count: 32),
            keyEpoch: 3
        )
        let envelope = try VaultHybridKeyDistribution.seal(
            umk: material.umk,
            vmk: material.vmk,
            keyEpoch: material.keyEpoch,
            challenge: challenge,
            sourceClientId: "source-device",
            sourceKeys: source,
            target: target.registration(clientId: "target-device")
        )
        #expect(
            try VaultHybridKeyDistribution.open(
                envelope,
                challenge: challenge,
                targetKeys: target,
                trustedSource: sourceIdentity
            ) == material
        )
        var tampered = envelope
        tampered = .init(
            version: tampered.version,
            kemSuiteId: tampered.kemSuiteId,
            sourceClientId: tampered.sourceClientId,
            targetClientId: tampered.targetClientId,
            sourceKeyGeneration: tampered.sourceKeyGeneration,
            targetKeyGeneration: tampered.targetKeyGeneration,
            targetKEMPublicKey: tampered.targetKEMPublicKey,
            keyEpoch: tampered.keyEpoch + 1,
            challengeSHA256: tampered.challengeSHA256,
            encapsulatedKey: tampered.encapsulatedKey,
            sealedKeyMaterial: tampered.sealedKeyMaterial,
            p256PublicKey: tampered.p256PublicKey,
            p256Signature: tampered.p256Signature,
            mlDSA65PublicKey: tampered.mlDSA65PublicKey,
            mlDSA65Signature: tampered.mlDSA65Signature,
            createdAt: tampered.createdAt,
            expiresAt: tampered.expiresAt
        )
        #expect(throws: Error.self) {
            try VaultHybridKeyDistribution.open(
                tampered,
                challenge: challenge,
                targetKeys: target,
                trustedSource: sourceIdentity
            )
        }

        let untrustedSource = try VaultHybridKeyDistribution.DeviceKeys()
            .registration(clientId: "source-device")
            .signingIdentity
        #expect(throws: Error.self) {
            try VaultHybridKeyDistribution.open(
                envelope,
                challenge: challenge,
                targetKeys: target,
                trustedSource: untrustedSource
            )
        }
        #expect(throws: Error.self) {
            try VaultHybridKeyDistribution.open(
                envelope,
                challenge: challenge,
                targetKeys: target,
                trustedSource: sourceIdentity,
                minimumKeyEpoch: material.keyEpoch
            )
        }
    }

    @Test
    @available(iOS 26.0, *)
    func retainsHistoricalDeviceGenerationUntilReferencesAreGone() throws {
        guard SecureEnclave.isAvailable else { return }
        let store = InMemorySecureValueStore()
        let ring = try VaultHybridKeyDistribution.DeviceKeyRing.loadOrCreate(
            secureStore: store
        )
        let first = try ring.current()
        let second = try ring.rotate()
        #expect(first.keyGeneration == 1)
        #expect(second.keyGeneration == 2)
        #expect(try ring.keys(for: 1).keyGeneration == 1)
        #expect(throws: Error.self) {
            try ring.retire(
                generation: 1,
                referencedEnvelopeGenerations: [1],
                minimumRetainedGenerations: 1
            )
        }
        try ring.retire(
            generation: 1,
            referencedEnvelopeGenerations: [],
            minimumRetainedGenerations: 1
        )
        #expect(throws: Error.self) {
            _ = try ring.keys(for: 1)
        }
    }

    @Test
    @available(iOS 26.0, *)
    func recoveryPackageRestoresHistoricalEpochMaterials() throws {
        let materials = [
            VaultHybridKeyDistribution.KeyMaterial(
                umk: Data(repeating: 1, count: 32),
                vmk: Data(repeating: 2, count: 32),
                keyEpoch: 1
            ),
            VaultHybridKeyDistribution.KeyMaterial(
                umk: Data(repeating: 3, count: 32),
                vmk: Data(repeating: 4, count: 32),
                keyEpoch: 2
            ),
        ]
        let secret = VaultHybridKeyDistribution.makeRecoverySecret()
        let package = try VaultHybridKeyDistribution.sealRecoveryPackage(
            materials: materials,
            recoverySecret: secret,
            recoveryKeyId: "recovery_device_1234"
        )
        #expect(
            try VaultHybridKeyDistribution.openRecoveryPackage(
                package,
                recoverySecret: secret
            ) == materials
        )
        #expect(throws: Error.self) {
            try VaultHybridKeyDistribution.openRecoveryPackage(
                package,
                recoverySecret: VaultHybridKeyDistribution.makeRecoverySecret()
            )
        }
    }

    @Test
    @available(iOS 26.0, *)
    func epochKeyRingRefusesUnsafeRetirement() throws {
        let store = InMemorySecureValueStore()
        let ring = try VaultHybridKeyDistribution.EpochKeyRing(
            secureStore: store
        )
        for epoch in 1 ... 3 {
            try ring.store(
                .init(
                    umk: Data(repeating: UInt8(epoch), count: 32),
                    vmk: Data(repeating: UInt8(epoch + 1), count: 32),
                    keyEpoch: epoch
                )
            )
        }
        try ring.markRetiring(epoch: 1)
        #expect(throws: Error.self) {
            try ring.retire(
                epoch: 1,
                referencedItemEpochs: [1],
                recoveryEpochs: [3]
            )
        }
        try ring.retire(
            epoch: 1,
            referencedItemEpochs: [],
            recoveryEpochs: [3]
        )
        #expect(ring.material(for: 1) == nil)
        #expect(ring.material(for: 3) != nil)
    }

    @Test
    @available(iOS 26.0, *)
    func derivesStableSeparatedUserRootKeysMatchingServerVectors() throws {
        let root = Data((0 ..< 32).map(UInt8.init))
        let material = try VaultHybridKeyDistribution.UserRootKeyMaterial(
            userRootKey: root,
            authUserId: 42,
            rootEpoch: 1
        )
        let expected = [
            VaultHybridKeyDistribution.UserKeyDomain.data:
                "a37aa15acd25339110eb8dd09571496c74c06a2e5336b734edea849ed1f5e6b3",
            .file:
                "efc5f7f4c136583c325d98a5393bd2f05ed4156ea851ec3b502050d76fab21f6",
            .agent:
                "2095afef9c2decfc7e1f42a4000255fab23b4d6e6e2996152a0576d415219d50",
            .vault:
                "7e076f276abf1639564e6ab088177476f5c63b0d4f539562eb6550b6bd6281e5",
        ]

        for (domain, vector) in expected {
            let key = try VaultHybridKeyDistribution.deriveUserKey(
                material,
                domain: domain
            )
            #expect(key.map { String(format: "%02x", $0) }.joined() == vector)
        }
    }

    @Test
    @available(iOS 26.0, *)
    func persistsAndDistributesUserRootWithXWingEnvelope() throws {
        guard SecureEnclave.isAvailable else { return }
        let store = InMemorySecureValueStore()
        let rootRing = try VaultHybridKeyDistribution.UserRootKeyRing(
            secureStore: store
        )
        let material = try rootRing.createInitial(authUserId: 42)
        let reloaded = try VaultHybridKeyDistribution.UserRootKeyRing(
            secureStore: store
        )
        #expect(reloaded.material(authUserId: 42) == material)

        let source = try VaultHybridKeyDistribution.DeviceKeys()
        let target = try VaultHybridKeyDistribution.DeviceKeys()
        let challenge = Data(repeating: 0x5A, count: 32)
        let envelope = try VaultHybridKeyDistribution.sealUserRoot(
            material,
            challengeId: "urkchallenge_test_1",
            challenge: challenge,
            sourceClientId: "source-device",
            sourceKeys: source,
            target: target.registration(clientId: "target-device")
        )
        let opened = try VaultHybridKeyDistribution.openUserRoot(
            envelope,
            targetKeys: target,
            trustedSource: source.registration(
                clientId: "source-device"
            ).signingIdentity,
            expectedAuthUserId: 42
        )
        #expect(opened == material)
        #expect(throws: Error.self) {
            try VaultHybridKeyDistribution.openUserRoot(
                envelope,
                targetKeys: target,
                trustedSource: source.registration(
                    clientId: "source-device"
                ).signingIdentity,
                expectedAuthUserId: 43
            )
        }
    }

    @Test
    @available(iOS 26.0, *)
    func wrapsConversationKeyWithRootDerivedDomainKey() throws {
        let root = try VaultHybridKeyDistribution.UserRootKeyMaterial(
            userRootKey: Data(repeating: 0x31, count: 32),
            authUserId: 42,
            rootEpoch: 3
        )
        let conversationKey = Data(repeating: 0xA7, count: 32)
        let envelope = try VaultHybridKeyDistribution.wrapUserDomainKey(
            conversationKey,
            root: root,
            domain: .data,
            resourceType: "chat-conversation-key",
            resourceId: "chat-key-123"
        )
        #expect(envelope.rootKeyId == root.rootKeyId)
        #expect(envelope.domainKeyVersion == 1)
        #expect(
            try VaultHybridKeyDistribution.unwrapUserDomainKey(
                envelope,
                root: root
            ) == conversationKey
        )

        let wrongRoot = try VaultHybridKeyDistribution.UserRootKeyMaterial(
            userRootKey: Data(repeating: 0x32, count: 32),
            authUserId: 42,
            rootEpoch: 3
        )
        #expect(throws: Error.self) {
            try VaultHybridKeyDistribution.unwrapUserDomainKey(
                envelope,
                root: wrongRoot
            )
        }
    }

    @Test
    func deviceMigrationAcceptsEveryUserRootEnvelopeResourceType() {
        #expect(
            UserRootKeyCenter.deviceMigratableResourceTypes == [
                "chat-conversation-key",
                "content-object",
                "vault-master-key",
                "direct-field-dek",
            ]
        )
    }
}
