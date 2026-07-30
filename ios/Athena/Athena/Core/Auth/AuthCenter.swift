import Foundation
import Observation

struct AthenaUser: Codable, Equatable, Identifiable, Sendable {
    let id: Int?
    let authUserId: Int?
    let username: String?
    let role: String?
    let email: String?
    let phone: String?
    let displayName: String?
    let pfpFilename: String?
    let bio: String?

    init(
        id: Int?,
        authUserId: Int? = nil,
        username: String?,
        role: String?,
        email: String?,
        phone: String?,
        displayName: String?,
        pfpFilename: String?,
        bio: String? = nil
    ) {
        self.id = id
        self.authUserId = authUserId
        self.username = username
        self.role = role
        self.email = email
        self.phone = phone
        self.displayName = displayName
        self.pfpFilename = pfpFilename
        self.bio = bio
    }

    var stableID: String {
        id.map(String.init) ?? username ?? "single-user"
    }

    var authenticationID: Int? {
        authUserId ?? id
    }

    var quickLoginSubjectID: Int? {
        id
    }
}

struct RecoveryCodeBundle: Identifiable, Equatable {
    let id = UUID()
    let codes: [String]
}

enum AuthCenterError: LocalizedError, Equatable {
    case invalidCredentials(String)
    case invalidSession
    case missingToken

    var errorDescription: String? {
        switch self {
        case .invalidCredentials(let message):
            message
        case .invalidSession:
            "登录状态已失效，请重新登录。"
        case .missingToken:
            "服务器没有返回登录凭证。"
        }
    }
}

enum SessionRecoveryResult: Equatable {
    case recovered
    case unavailable(reason: String, transient: Bool, terminal: Bool)
}

private struct LoginRequest: Encodable {
    let identifier: String
    let password: String
}

private struct LoginResponse: Decodable {
    let valid: Bool
    let user: AthenaUser?
    let token: String?
    let message: String?
    let recoveryCodes: [String]?
}

private struct TokenCheckResponse: Decodable {
    let valid: Bool?
    let token: String?
    let legacyTokenUpgraded: Bool?
}

private struct RefreshUserResponse: Decodable {
    let success: Bool
    let user: AthenaUser?
    let message: String?
}

private struct MultiUserModeResponse: Decodable {
    let multiUserMode: Bool
}

private struct SessionRecoveryEnrollResponse: Decodable {
    let success: Bool
    let recoveryHandle: String
    let expiresAt: String?
}

private struct SessionRecoveryStartRequest: Encodable {
    let recoveryHandle: String
    let source: String
}

private struct SessionRecoveryStartResponse: Decodable {
    let success: Bool
    let recoveryTicket: String
}

private struct SessionRecoveryFinishRequest: Encodable {
    let recoveryTicket: String
}

private struct SessionRecoveryFinishResponse: Decodable {
    let success: Bool
    let valid: Bool
    let user: AthenaUser?
    let token: String?
}

@MainActor
@Observable
final class AuthCenter {
    enum AuthState: Equatable {
        case signedOut
        case tokenStored
        case authenticated
    }

    private enum Keys {
        static let accessToken = "auth.accessToken"
        static let recoveryHandle = "auth.sessionRecovery.handle"
        static let recoveryClientID = "auth.sessionRecovery.clientID"
        static let recoveryExpiresAt = "auth.sessionRecovery.expiresAt"
    }

    private let secureStore: SecureValueStore
    private(set) var accessToken: String?
    private(set) var user: AthenaUser?

    var state: AuthState = .signedOut
    var loginPath = "/api/request-token"
    var checkTokenPath = "/api/system/check-token"
    var passkeyAvailable = false
    var nativePasskey: NativePasskeyInfo?
    var pendingRecoveryCodes: RecoveryCodeBundle?
    var requiresIdentifier = true

    init(secureStore: SecureValueStore) {
        self.secureStore = secureStore
    }

    func applyBootstrap(_ bootstrap: NativeAppBootstrap?) {
        loginPath = bootstrap?.auth.passwordLoginPath ?? "/api/request-token"
        checkTokenPath = bootstrap?.auth.checkTokenPath ?? "/api/system/check-token"
        passkeyAvailable = bootstrap?.auth.passkeyAvailable == true
        nativePasskey = bootstrap?.auth.nativePasskey
    }

    func restore() throws {
        guard
            let data = try secureStore.data(forKey: Keys.accessToken),
            let token = String(data: data, encoding: .utf8),
            !token.isEmpty
        else {
            accessToken = nil
            user = nil
            state = .signedOut
            return
        }
        accessToken = token
        state = .tokenStored
    }

    func login(identifier: String, password: String, using apiClient: APIClient) async throws {
        let response = try await apiClient.requestJSON(
            LoginResponse.self,
            method: .post,
            path: loginPath,
            body: LoginRequest(identifier: identifier, password: password),
            authorization: .none,
            signing: .none,
            retryOnConnectionLoss: true
        )
        guard response.valid else {
            throw AuthCenterError.invalidCredentials(response.message ?? "用户名或密码不正确。")
        }
        guard let token = response.token, !token.isEmpty else {
            throw AuthCenterError.missingToken
        }

        try storeToken(token)
        user = response.user
        state = .authenticated
        if let codes = response.recoveryCodes, !codes.isEmpty {
            pendingRecoveryCodes = RecoveryCodeBundle(codes: codes)
        }
    }

    func loginWithPasskey(
        using apiClient: APIClient,
        authenticator: PasskeyAuthenticationClient
    ) async throws {
        guard passkeyAvailable,
              let nativePasskey,
              nativePasskey.serverAvailable else {
            throw PasskeyAuthenticationError.unavailable
        }

        let result = try await authenticator.performNativeHandoff(
            purpose: .login,
            using: apiClient
        )
        guard let token = result.token, !token.isEmpty else {
            throw AuthCenterError.missingToken
        }
        try storeToken(token)
        user = result.user
        state = .authenticated
    }

    func acceptAuthenticatedSession(token: String, user: AthenaUser?) throws {
        guard !token.isEmpty else { throw AuthCenterError.missingToken }
        try storeToken(token)
        self.user = user
        state = .authenticated
    }

    func refreshLoginMode(using apiClient: APIClient) async throws {
        let response = try await apiClient.getJSON(
            MultiUserModeResponse.self,
            path: "/api/system/multi-user-mode",
            authorization: .none,
            retryOnConnectionLoss: true
        )
        requiresIdentifier = response.multiUserMode
    }

    func validateStoredSession(using apiClient: APIClient) async throws {
        guard accessToken != nil else {
            throw AuthCenterError.invalidSession
        }

        let data = try await apiClient.requestData(
            method: .get,
            path: checkTokenPath,
            authorization: .required
        )
        if !data.isEmpty {
            let response = try JSONDecoder().decode(TokenCheckResponse.self, from: data)
            guard response.valid != false else {
                throw AuthCenterError.invalidSession
            }
            if let upgradedToken = response.token, !upgradedToken.isEmpty {
                try storeToken(upgradedToken)
            }
        }

        let refresh = try await apiClient.getJSON(
            RefreshUserResponse.self,
            path: "/api/system/refresh-user",
            authorization: .required
        )
        guard refresh.success else {
            throw AuthCenterError.invalidCredentials(refresh.message ?? "无法恢复登录状态。")
        }
        user = refresh.user
        state = .authenticated
    }

    func hasSessionRecoveryBinding(for clientID: String? = nil) -> Bool {
        guard
            let handle = try? secureStore.data(forKey: Keys.recoveryHandle),
            !handle.isEmpty,
            let storedClientData = try? secureStore.data(
                forKey: Keys.recoveryClientID
            ),
            let storedClientID = String(data: storedClientData, encoding: .utf8),
            !storedClientID.isEmpty
        else {
            return false
        }
        return clientID == nil || clientID == storedClientID
    }

    func enrollSessionRecovery(
        clientID: String,
        using apiClient: APIClient
    ) async throws {
        guard accessToken != nil, !clientID.isEmpty else {
            throw AuthCenterError.invalidSession
        }
        let response = try await apiClient.requestJSON(
            SessionRecoveryEnrollResponse.self,
            method: .post,
            path: "/api/auth/session/recovery/enroll",
            body: [String: String](),
            authorization: .required,
            signing: .required,
            retryOnConnectionLoss: true
        )
        guard response.success, !response.recoveryHandle.isEmpty else {
            throw AuthCenterError.invalidSession
        }
        try secureStore.setData(
            Data(response.recoveryHandle.utf8),
            forKey: Keys.recoveryHandle
        )
        try secureStore.setData(
            Data(clientID.utf8),
            forKey: Keys.recoveryClientID
        )
        if let expiresAt = response.expiresAt {
            try secureStore.setData(
                Data(expiresAt.utf8),
                forKey: Keys.recoveryExpiresAt
            )
        } else {
            try secureStore.removeData(forKey: Keys.recoveryExpiresAt)
        }
    }

    func recoverStoredSession(
        clientID: String,
        source: String,
        using apiClient: APIClient
    ) async -> SessionRecoveryResult {
        guard
            !clientID.isEmpty,
            let handleData = try? secureStore.data(forKey: Keys.recoveryHandle),
            let handle = String(data: handleData, encoding: .utf8),
            !handle.isEmpty,
            let storedClientData = try? secureStore.data(
                forKey: Keys.recoveryClientID
            ),
            let storedClientID = String(data: storedClientData, encoding: .utf8),
            storedClientID == clientID
        else {
            try? clearSessionRecoveryBinding()
            return .unavailable(
                reason: "recovery_binding_missing",
                transient: false,
                terminal: true
            )
        }

        do {
            let started = try await apiClient.requestJSON(
                SessionRecoveryStartResponse.self,
                method: .post,
                path: "/api/auth/session/recovery/start",
                body: SessionRecoveryStartRequest(
                    recoveryHandle: handle,
                    source: source
                ),
                authorization: .none,
                signing: .none,
                retryOnConnectionLoss: true
            )
            guard started.success, !started.recoveryTicket.isEmpty else {
                throw AuthCenterError.invalidSession
            }
            let finished = try await apiClient.requestJSON(
                SessionRecoveryFinishResponse.self,
                method: .post,
                path: "/api/auth/session/recovery/finish",
                body: SessionRecoveryFinishRequest(
                    recoveryTicket: started.recoveryTicket
                ),
                authorization: .none,
                signing: .required,
                retryOnConnectionLoss: true
            )
            guard
                finished.success,
                finished.valid,
                let token = finished.token,
                !token.isEmpty
            else {
                throw AuthCenterError.invalidSession
            }
            try acceptAuthenticatedSession(token: token, user: finished.user)
            return .recovered
        } catch {
            let failure = Self.sessionRecoveryFailure(for: error)
            if failure.terminal {
                try? clearSessionRecoveryBinding()
            }
            return .unavailable(
                reason: failure.reason,
                transient: failure.transient,
                terminal: failure.terminal
            )
        }
    }

    func storeToken(_ token: String) throws {
        try secureStore.setData(Data(token.utf8), forKey: Keys.accessToken)
        accessToken = token
        state = .tokenStored
    }

    func clearToken() throws {
        try secureStore.removeData(forKey: Keys.accessToken)
        accessToken = nil
        user = nil
        pendingRecoveryCodes = nil
        state = .signedOut
    }

    func clearSessionRecoveryBinding() throws {
        try secureStore.removeData(forKey: Keys.recoveryHandle)
        try secureStore.removeData(forKey: Keys.recoveryClientID)
        try secureStore.removeData(forKey: Keys.recoveryExpiresAt)
    }

    func cacheOwnerScope(fallbackClientID: String?) -> String {
        if let user {
            return "user:\(user.stableID)"
        }
        return "single-user:\(fallbackClientID ?? "native")"
    }

    private static func sessionRecoveryFailure(
        for error: Error
    ) -> (reason: String, transient: Bool, terminal: Bool) {
        if let urlError = error as? URLError {
            return (
                String(urlError.code.rawValue),
                true,
                false
            )
        }
        if let apiError = error as? APIClientError,
           case .httpStatus(let status, let code, _) = apiError
        {
            let reason = code?.lowercased() ?? "session_recovery_unavailable"
            let transient = status == 429 || status >= 500
            let terminalReasons: Set<String> = [
                "account_unavailable",
                "challenge_invalid_or_consumed",
                "client_revoked",
                "device_key_mismatch",
                "device_key_missing",
                "post_quantum_device_key_mismatch",
                "post_quantum_signature_required",
                "recovery_binding_missing",
                "session_absolute_expired",
                "session_client_mismatch",
                "session_idle_expired",
                "session_revoked",
                "shadow_user_unavailable",
            ]
            return (
                reason,
                transient,
                !transient || terminalReasons.contains(reason)
            )
        }
        if error is APIClientError {
            return ("session_recovery_unavailable", true, false)
        }
        return ("session_recovery_unavailable", true, false)
    }
}
