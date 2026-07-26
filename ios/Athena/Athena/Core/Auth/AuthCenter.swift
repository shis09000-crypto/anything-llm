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

    func cacheOwnerScope(fallbackClientID: String?) -> String {
        if let user {
            return "user:\(user.stableID)"
        }
        return "single-user:\(fallbackClientID ?? "native")"
    }
}
