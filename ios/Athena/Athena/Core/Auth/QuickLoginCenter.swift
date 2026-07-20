import CryptoKit
import Foundation
import Observation
import UIKit

struct TrustedLoginDevice: Codable, Equatable, Identifiable, Sendable {
    let id: Int
    let userId: Int?
    let deviceId: String
    let deviceName: String?
    let createdAt: String?
    let lastUsedAt: String?
    let lastChallengeAt: String?
    let lockedUntil: String?
    let revokedAt: String?
}

struct LocalQuickLoginDevice: Codable, Equatable, Identifiable, Sendable {
    let deviceId: String
    let userId: Int
    let username: String
    let deviceName: String
    let createdAt: String
    var lastUsedAt: String?
    var serverRecordID: Int?

    var id: String { deviceId }
}

private struct QuickLoginDevicesResponse: Decodable {
    let success: Bool
    let devices: [TrustedLoginDevice]
    let error: String?
}

private struct QuickLoginReauthResponse: Decodable {
    let success: Bool
    let reauthToken: String?
    let error: String?
}

private struct QuickLoginEnrollmentStartResponse: Decodable {
    let success: Bool
    let registrationResponse: String?
    let error: String?
}

private struct QuickLoginEnrollmentFinishResponse: Decodable {
    let success: Bool
    let device: TrustedLoginDevice?
    let error: String?
}

private struct QuickLoginStartResponse: Decodable {
    let success: Bool
    let loginAttemptId: String?
    let loginResponse: String?
    let error: String?
    let lockedUntil: String?
}

private struct QuickLoginFinishResponse: Decodable {
    let valid: Bool
    let user: AthenaUser?
    let token: String?
    let message: String?
    let resetLocalDevice: Bool?
}

struct QuickLoginAuthenticatedSession: Equatable, Sendable {
    let user: AthenaUser?
    let token: String
}

private struct QuickLoginPasswordReauthBody: Encodable {
    let currentPassword: String
}

private struct QuickLoginEnrollStartBody: Encodable {
    let reauthToken: String
    let deviceId: String
    let deviceName: String
    let deviceSalt: String
    let registrationRequest: String
}

private struct QuickLoginEnrollFinishBody: Encodable {
    let reauthToken: String
    let deviceId: String
    let deviceName: String
    let deviceSalt: String
    let registrationRecord: String
}

private struct QuickLoginStartBody: Encodable {
    let userId: Int
    let deviceId: String
    let startLoginRequest: String
}

private struct QuickLoginFinishBody: Encodable {
    let loginAttemptId: String
    let finishLoginRequest: String
}

@MainActor
@Observable
final class QuickLoginCenter {
    enum Status: Equatable {
        case idle
        case loading
        case enrolling
        case authenticating
        case failed(String)
    }

    private let apiClient: APIClient
    private let secureStore: SecureValueStore
    private let taskScheduler: TaskScheduler
    private let passkeyAuthenticationClient: PasskeyAuthenticationClient
    private let opaqueClient = OpaqueClient()
    private var authenticatedUser: AthenaUser?
    private var expectedServerPublicKey: String?
    private var ownerScope: String?

    private(set) var status: Status = .idle
    private(set) var serverDevices: [TrustedLoginDevice] = []
    private(set) var localDevices: [LocalQuickLoginDevice] = []

    init(
        apiClient: APIClient,
        secureStore: SecureValueStore,
        taskScheduler: TaskScheduler,
        passkeyAuthenticationClient: PasskeyAuthenticationClient
    ) {
        self.apiClient = apiClient
        self.secureStore = secureStore
        self.taskScheduler = taskScheduler
        self.passkeyAuthenticationClient = passkeyAuthenticationClient
        loadLocalDevices()
    }

    var preferredLocalDevice: LocalQuickLoginDevice? {
        localDevices.sorted {
            ($0.lastUsedAt ?? $0.createdAt) > ($1.lastUsedAt ?? $1.createdAt)
        }.first
    }

    func applyBootstrap(_ bootstrap: NativeAppBootstrap?) {
        expectedServerPublicKey = bootstrap?.security.opaque?.serverStaticPublicKey
    }

    func start(ownerScope: String, user: AthenaUser?) async {
        self.ownerScope = ownerScope
        authenticatedUser = user
        loadLocalDevices()
        await refreshDevices()
    }

    func refreshDevices() async {
        guard authenticatedUser != nil else { return }
        status = .loading
        do {
            let response = try await taskScheduler.run(
                securityTask("settings:quick-login-devices", resource: .network)
            ) { [apiClient] context in
                try context.checkCancellation()
                return try await apiClient.getJSON(
                    QuickLoginDevicesResponse.self,
                    path: "/api/auth/zk-login/devices",
                    authorization: .required,
                    signing: .none,
                    retryOnConnectionLoss: true
                )
            }
            guard response.success else {
                throw SettingsCenterError.server(response.error ?? "无法读取可信设备。")
            }
            serverDevices = response.devices
            let validDeviceIDs = Set(response.devices.map(\.deviceId))
            localDevices.removeAll { !validDeviceIDs.contains($0.deviceId) }
            persistLocalDevices()
            status = .idle
        } catch is CancellationError {
            status = .idle
        } catch {
            status = .failed(error.localizedDescription)
        }
    }

    func enrollUsingPassword(_ password: String) async -> Bool {
        status = .enrolling
        do {
            let reauth = try await apiClient.requestJSON(
                QuickLoginReauthResponse.self,
                method: .post,
                path: "/api/auth/zk-login/reauth/password",
                body: QuickLoginPasswordReauthBody(currentPassword: password),
                authorization: .required,
                signing: .required,
                retryOnConnectionLoss: false
            )
            guard reauth.success, let reauthToken = reauth.reauthToken else {
                throw SettingsCenterError.server(reauth.error ?? "无法验证当前密码。")
            }
            return try await enroll(reauthToken: reauthToken)
        } catch is CancellationError {
            status = .idle
            return false
        } catch {
            status = .failed(error.localizedDescription)
            return false
        }
    }

    func enrollUsingPasskey() async -> Bool {
        status = .enrolling
        do {
            let handoff = try await passkeyAuthenticationClient.performNativeHandoff(
                purpose: .quickLoginEnrollment,
                using: apiClient
            )
            guard let reauthToken = handoff.reauthToken?.nonEmpty else {
                throw SettingsCenterError.server("通行密钥未返回快速登录授权。")
            }
            return try await enroll(reauthToken: reauthToken)
        } catch PasskeyAuthenticationError.cancelled {
            status = .idle
            return false
        } catch is CancellationError {
            status = .idle
            return false
        } catch {
            status = .failed(error.localizedDescription)
            return false
        }
    }

    private func enroll(reauthToken: String) async throws -> Bool {
        guard let user = authenticatedUser,
              let userID = user.quickLoginSubjectID else {
            throw SettingsCenterError.server("当前登录账户缺少统一身份信息。")
        }
        let deviceID = Self.randomBase64URL(byteCount: 24)
        let deviceSecret = Self.randomBase64URL(byteCount: 48)
        let deviceSalt = Self.randomBase64URL(byteCount: 24)
        let deviceName = UIDevice.current.name
        let registrationStart = try await taskScheduler.run(
            securityTask("auth:opaque-registration-start", resource: .cpu)
        ) { [opaqueClient] context in
            try context.checkCancellation()
            return try await Task.detached(priority: .userInitiated) {
                try opaqueClient.startRegistration(secret: deviceSecret)
            }.value
        }
        let startResponse = try await apiClient.requestJSON(
            QuickLoginEnrollmentStartResponse.self,
            method: .post,
            path: "/api/auth/zk-login/enroll/start",
            body: QuickLoginEnrollStartBody(
                reauthToken: reauthToken,
                deviceId: deviceID,
                deviceName: deviceName,
                deviceSalt: deviceSalt,
                registrationRequest: registrationStart.registrationRequest
            ),
            authorization: .required,
            signing: .required,
            retryOnConnectionLoss: true
        )
        guard startResponse.success,
              let registrationResponse = startResponse.registrationResponse else {
            throw SettingsCenterError.server(
                startResponse.error ?? "无法启动快速登录注册。"
            )
        }
        let registrationFinish = try await taskScheduler.run(
            securityTask("auth:opaque-registration-finish", resource: .cpu)
        ) { [opaqueClient] context in
            try context.checkCancellation()
            return try await Task.detached(priority: .userInitiated) {
                try opaqueClient.finishRegistration(
                    secret: deviceSecret,
                    state: registrationStart.clientRegistrationState,
                    response: registrationResponse,
                    deviceID: deviceID
                )
            }.value
        }
        try verifyServerPublicKey(registrationFinish.serverStaticPublicKey)
        let finishResponse = try await apiClient.requestJSON(
            QuickLoginEnrollmentFinishResponse.self,
            method: .post,
            path: "/api/auth/zk-login/enroll/finish",
            body: QuickLoginEnrollFinishBody(
                reauthToken: reauthToken,
                deviceId: deviceID,
                deviceName: deviceName,
                deviceSalt: deviceSalt,
                registrationRecord: registrationFinish.registrationRecord
            ),
            authorization: .required,
            signing: .required,
            retryOnConnectionLoss: true
        )
        guard finishResponse.success else {
            throw SettingsCenterError.server(
                finishResponse.error ?? "无法完成快速登录注册。"
            )
        }
        let local = LocalQuickLoginDevice(
            deviceId: deviceID,
            userId: userID,
            username: user.username?.nonEmpty ?? "Athena",
            deviceName: deviceName,
            createdAt: ISO8601DateFormatter().string(from: Date()),
            lastUsedAt: nil,
            serverRecordID: finishResponse.device?.id
        )
        try secureStore.setProtectedData(
            Data(deviceSecret.utf8),
            forKey: secretKey(deviceID: deviceID)
        )
        localDevices.removeAll { $0.deviceId == deviceID }
        localDevices.insert(local, at: 0)
        persistLocalDevices()
        await refreshDevices()
        status = .idle
        return true
    }

    func login(_ device: LocalQuickLoginDevice) async throws -> QuickLoginAuthenticatedSession {
        status = .authenticating
        do {
            guard let data = try secureStore.protectedData(
                forKey: secretKey(deviceID: device.deviceId),
                prompt: "使用快速登录进入 Athena"
            ), let secret = String(data: data, encoding: .utf8) else {
                throw SettingsCenterError.server("本机快速登录凭证不存在。")
            }
            let start = try await taskScheduler.run(
                securityTask("auth:opaque-login-start", resource: .cpu)
            ) { [opaqueClient] context in
                try context.checkCancellation()
                return try await Task.detached(priority: .userInitiated) {
                    try opaqueClient.startLogin(secret: secret)
                }.value
            }
            let startResponse = try await apiClient.requestJSON(
                QuickLoginStartResponse.self,
                method: .post,
                path: "/api/auth/zk-login/login/start",
                body: QuickLoginStartBody(
                    userId: device.userId,
                    deviceId: device.deviceId,
                    startLoginRequest: start.startLoginRequest
                ),
                authorization: .none,
                signing: .none,
                retryOnConnectionLoss: true
            )
            guard startResponse.success,
                  let attemptID = startResponse.loginAttemptId,
                  let loginResponse = startResponse.loginResponse else {
                throw SettingsCenterError.server(
                    startResponse.error ?? "快速登录暂不可用。"
                )
            }
            let finish = try await taskScheduler.run(
                securityTask("auth:opaque-login-finish", resource: .cpu)
            ) { [opaqueClient] context in
                try context.checkCancellation()
                return try await Task.detached(priority: .userInitiated) {
                    try opaqueClient.finishLogin(
                        secret: secret,
                        state: start.clientLoginState,
                        response: loginResponse,
                        deviceID: device.deviceId
                    )
                }.value
            }
            try verifyServerPublicKey(finish.serverStaticPublicKey)
            let response = try await apiClient.requestJSON(
                QuickLoginFinishResponse.self,
                method: .post,
                path: "/api/auth/zk-login/login/finish",
                body: QuickLoginFinishBody(
                    loginAttemptId: attemptID,
                    finishLoginRequest: finish.finishLoginRequest
                ),
                authorization: .none,
                signing: .none,
                retryOnConnectionLoss: true
            )
            if response.resetLocalDevice == true {
                removeLocalDevice(device.deviceId)
            }
            guard response.valid else {
                throw SettingsCenterError.server(
                    response.message ?? "快速登录验证失败。"
                )
            }
            if let index = localDevices.firstIndex(where: { $0.deviceId == device.deviceId }) {
                localDevices[index].lastUsedAt = ISO8601DateFormatter().string(from: Date())
                persistLocalDevices()
            }
            status = .idle
            guard let token = response.token?.nonEmpty else {
                throw AuthCenterError.missingToken
            }
            return QuickLoginAuthenticatedSession(user: response.user, token: token)
        } catch {
            status = .failed(error.localizedDescription)
            throw error
        }
    }

    func revoke(_ device: TrustedLoginDevice) async -> Bool {
        status = .loading
        do {
            let response = try await apiClient.requestJSON(
                SettingsSuccessResponse.self,
                method: .delete,
                path: "/api/auth/zk-login/devices/\(device.id)",
                authorization: .required,
                signing: .required,
                retryOnConnectionLoss: true
            )
            guard response.success else {
                throw SettingsCenterError.server(response.error ?? "无法撤销可信设备。")
            }
            removeLocalDevice(device.deviceId)
            await refreshDevices()
            status = .idle
            return true
        } catch {
            status = .failed(error.localizedDescription)
            return false
        }
    }

    func resetAuthenticatedState() {
        authenticatedUser = nil
        ownerScope = nil
        serverDevices = []
        status = .idle
        loadLocalDevices()
    }

    func clearFailure() {
        if case .failed = status {
            status = .idle
        }
    }

    private func verifyServerPublicKey(_ key: String) throws {
        if let expectedServerPublicKey, expectedServerPublicKey != key {
            throw OpaqueClientError.serverIdentityChanged
        }
        let pinKey = "quickLogin.serverKey.\(apiPartition)"
        if let pinned = try secureStore.data(forKey: pinKey),
           String(data: pinned, encoding: .utf8) != key {
            throw OpaqueClientError.serverIdentityChanged
        }
        if try secureStore.data(forKey: pinKey) == nil {
            try secureStore.setData(Data(key.utf8), forKey: pinKey)
        }
    }

    private func loadLocalDevices() {
        guard let data = try? secureStore.data(forKey: metadataKey),
              let devices = try? JSONDecoder().decode(
                  [LocalQuickLoginDevice].self,
                  from: data
              ) else {
            localDevices = []
            return
        }
        localDevices = devices
    }

    private func persistLocalDevices() {
        guard let data = try? JSONEncoder().encode(localDevices) else { return }
        try? secureStore.setData(data, forKey: metadataKey)
    }

    private func removeLocalDevice(_ deviceID: String) {
        try? secureStore.removeData(forKey: secretKey(deviceID: deviceID))
        localDevices.removeAll { $0.deviceId == deviceID }
        persistLocalDevices()
    }

    private var apiPartition: String {
        let digest = SHA256.hash(
            data: Data(
                apiClient.configuration.normalizedBaseURL.absoluteString.utf8
            )
        )
        return Data(digest).base64EncodedString()
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "=", with: "")
    }

    private var metadataKey: String {
        "quickLogin.devices.\(apiPartition)"
    }

    private func secretKey(deviceID: String) -> String {
        "quickLogin.secret.\(apiPartition).\(deviceID)"
    }

    private func securityTask(
        _ label: String,
        resource: AthenaTaskResource
    ) -> AthenaTaskDescriptor {
        AthenaTaskDescriptor(
            label: label,
            kind: "account-security",
            priority: .p0,
            intentRank: 0,
            executionClass: .security,
            policy: .foreground,
            resource: resource,
            scope: AthenaTaskScope(
                owner: ownerScope,
                route: "auth",
                surface: "quick-login",
                transport: resource == .network ? "http" : nil
            ),
            dedupeKey: label,
            isProtected: true,
            isAbortable: false
        )
    }

    private static func randomBase64URL(byteCount: Int) -> String {
        var bytes = [UInt8](repeating: 0, count: byteCount)
        _ = SecRandomCopyBytes(kSecRandomDefault, byteCount, &bytes)
        return Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
