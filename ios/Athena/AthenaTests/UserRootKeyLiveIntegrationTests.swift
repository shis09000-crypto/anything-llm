import CryptoKit
import Foundation
import Testing
@testable import Athena

@Suite("User Root live integration")
struct UserRootKeyLiveIntegrationTests {
    @MainActor
    private struct Harness {
        let store: InMemorySecureValueStore
        let apiClient: APIClient
        let authCenter: AuthCenter
        let clientIdentityCenter: ClientIdentityCenter
        let requestSigningCenter: RequestSigningCenter
        let rootCenter: UserRootKeyCenter
        let clientId: String
    }

    private struct LiveConfiguration {
        let baseURL: URL
        let username: String
        let password: String
    }

    @Test
    @MainActor
    // The assertions intentionally keep the two-device protocol in one trace.
    // swiftlint:disable:next function_body_length
    func initializesAndTransfersRootAcrossTwoRealDevices() async throws {
        guard let configuration = liveConfiguration() else { return }
        guard SecureEnclave.isAvailable else {
            throw VaultHybridKeyDistribution.DistributionError
                .secureEnclaveUnavailable
        }

        let source = try await harness(
            baseURL: configuration.baseURL,
            username: configuration.username,
            password: configuration.password
        )
        let target = try await harness(
            baseURL: configuration.baseURL,
            username: configuration.username,
            password: configuration.password
        )
        let authUserId = try #require(source.authCenter.user?.authenticationID)
        #expect(target.authCenter.user?.authenticationID == authUserId)

        let sourceMaterial = try await source.rootCenter.initialize(
            authUserId: authUserId,
            clientId: source.clientId,
            currentPassword: configuration.password,
            using: source.apiClient
        )
        let initialized = try await VaultHybridKeyDistribution.userRootStatus(
            using: source.apiClient
        )
        #expect(initialized.initialized)
        #expect(initialized.rootKeyId == sourceMaterial.rootKeyId)
        #expect(initialized.pendingEnvelopes == 0)

        let targetKeys =
            try VaultHybridKeyDistribution.DeviceKeys.loadOrCreate(
                secureStore: target.store
            )
        let targetRegistration = targetKeys.registration(
            clientId: target.clientId
        )
        try await VaultHybridKeyDistribution.register(
            targetRegistration,
            using: target.apiClient
        )
        _ = try await source.rootCenter.authorize(
            target: targetRegistration,
            authUserId: authUserId,
            sourceClientId: source.clientId,
            currentPassword: configuration.password,
            using: source.apiClient
        )

        let targetBeforeReceive = try await target.rootCenter.refresh(
            authUserId: authUserId,
            clientId: target.clientId,
            using: target.apiClient
        )
        guard case .authorizationRequired = targetBeforeReceive else {
            Issue.record("Target device did not enter authorization-required state")
            return
        }
        #expect(
            try await target.rootCenter.receivePending(
                authUserId: authUserId,
                clientId: target.clientId,
                using: target.apiClient
            )
        )

        let sourceDataKey = try source.rootCenter.domainKey(
            .data,
            authUserId: authUserId
        )
        let targetDataKey = try target.rootCenter.domainKey(
            .data,
            authUserId: authUserId
        )
        let sourceFileKey = try source.rootCenter.domainKey(
            .file,
            authUserId: authUserId
        )
        #expect(keyData(sourceDataKey) == keyData(targetDataKey))
        #expect(keyData(sourceDataKey) != keyData(sourceFileKey))

        let targetAfterReceive =
            try await VaultHybridKeyDistribution.userRootStatus(
                using: target.apiClient
            )
        #expect(targetAfterReceive.pendingEnvelopes == 0)
        #expect(
            target.rootCenter.status == .ready(
                rootEpoch: sourceMaterial.rootEpoch,
                rootKeyId: sourceMaterial.rootKeyId
            )
        )
    }

    @MainActor
    private func harness(
        baseURL: URL,
        username: String,
        password: String
    ) async throws -> Harness {
        let store = InMemorySecureValueStore()
        let apiClient = APIClient(
            configuration: APIClientConfiguration(
                baseURL: baseURL,
                appVersion: "2.1.4-e2e",
                osVersion: "26.5",
                platform: "ios"
            )
        )
        let authCenter = AuthCenter(secureStore: store)
        let clientIdentityCenter = ClientIdentityCenter(secureStore: store)
        let requestSigningCenter = RequestSigningCenter(secureStore: store)
        let rootCenter = UserRootKeyCenter(secureStore: store)
        apiClient.configureSecurity(
            authCenter: authCenter,
            clientIdentityCenter: clientIdentityCenter,
            requestSigningCenter: requestSigningCenter
        )
        let bootstrap = try await NativeBootstrapClient(
            apiClient: apiClient
        ).fetchBootstrap()
        authCenter.applyBootstrap(bootstrap)
        clientIdentityCenter.applyBootstrap(bootstrap)
        requestSigningCenter.applyBootstrap(bootstrap)
        let clientId = try clientIdentityCenter.prepare()
        try requestSigningCenter.prepareDeviceKey()
        try await authCenter.login(
            identifier: username,
            password: password,
            using: apiClient
        )
        try await requestSigningCenter.refreshSigningSecret(using: apiClient)
        return Harness(
            store: store,
            apiClient: apiClient,
            authCenter: authCenter,
            clientIdentityCenter: clientIdentityCenter,
            requestSigningCenter: requestSigningCenter,
            rootCenter: rootCenter,
            clientId: clientId
        )
    }

    private func keyData(_ key: SymmetricKey) -> Data {
        key.withUnsafeBytes { Data($0) }
    }

    private func liveEnvironmentValue(
        _ name: String,
        in environment: [String: String]
    ) -> String? {
        environment[name] ?? environment["TEST_RUNNER_\(name)"]
    }

    private func liveConfiguration() -> LiveConfiguration? {
        let environment = ProcessInfo.processInfo.environment
        guard
            let rawURL = liveEnvironmentValue(
                "ATHENA_USER_ROOT_E2E_URL",
                in: environment
            ),
            let baseURL = URL(string: rawURL),
            let username = liveEnvironmentValue(
                "ATHENA_USER_ROOT_E2E_USERNAME",
                in: environment
            ),
            let password = liveEnvironmentValue(
                "ATHENA_USER_ROOT_E2E_PASSWORD",
                in: environment
            )
        else { return nil }
        return LiveConfiguration(
            baseURL: baseURL,
            username: username,
            password: password
        )
    }
}
