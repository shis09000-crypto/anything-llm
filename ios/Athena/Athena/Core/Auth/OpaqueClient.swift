import AthenaOpaqueCore
import Foundation

enum OpaqueClientError: LocalizedError, Equatable {
    case unavailable
    case invalidResponse
    case operationFailed(String)
    case serverIdentityChanged

    var errorDescription: String? {
        switch self {
        case .unavailable:
            "原生快速登录组件不可用。"
        case .invalidResponse:
            "快速登录组件返回了无效数据。"
        case .operationFailed(let message):
            message
        case .serverIdentityChanged:
            "服务器快速登录身份已变化。为保护账户，本次登录已被阻止。"
        }
    }
}

struct OpaqueRegistrationStart: Codable, Equatable, Sendable {
    let clientRegistrationState: String
    let registrationRequest: String
}

struct OpaqueRegistrationFinish: Codable, Equatable, Sendable {
    let registrationRecord: String
    let serverStaticPublicKey: String
}

struct OpaqueLoginStart: Codable, Equatable, Sendable {
    let clientLoginState: String
    let startLoginRequest: String
}

struct OpaqueLoginFinish: Codable, Equatable, Sendable {
    let finishLoginRequest: String
    let serverStaticPublicKey: String
}

private struct OpaqueEnvelope<Value: Decodable>: Decodable {
    let ok: Bool
    let value: Value?
    let error: String?
}

private struct OpaqueRegistrationFinishInput: Encodable {
    let password: String
    let clientRegistrationState: String
    let registrationResponse: String
    let clientIdentifier: String
    let serverIdentifier: String
}

private struct OpaqueLoginFinishInput: Encodable {
    let password: String
    let clientLoginState: String
    let loginResponse: String
    let clientIdentifier: String
    let serverIdentifier: String
}

struct OpaqueClient: Sendable {
    func startRegistration(secret: String) throws -> OpaqueRegistrationStart {
        try invokeString(secret, function: athena_opaque_start_registration)
    }

    func finishRegistration(
        secret: String,
        state: String,
        response: String,
        deviceID: String
    ) throws -> OpaqueRegistrationFinish {
        try invokeJSON(
            OpaqueRegistrationFinishInput(
                password: secret,
                clientRegistrationState: state,
                registrationResponse: response,
                clientIdentifier: deviceID,
                serverIdentifier: "Athena"
            ),
            function: athena_opaque_finish_registration
        )
    }

    func startLogin(secret: String) throws -> OpaqueLoginStart {
        try invokeString(secret, function: athena_opaque_start_login)
    }

    func finishLogin(
        secret: String,
        state: String,
        response: String,
        deviceID: String
    ) throws -> OpaqueLoginFinish {
        try invokeJSON(
            OpaqueLoginFinishInput(
                password: secret,
                clientLoginState: state,
                loginResponse: response,
                clientIdentifier: deviceID,
                serverIdentifier: "Athena"
            ),
            function: athena_opaque_finish_login
        )
    }

    private func invokeString<Value: Decodable>(
        _ value: String,
        function: (UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>?
    ) throws -> Value {
        let pointer = value.withCString { function($0) }
        return try decode(pointer)
    }

    private func invokeJSON<Input: Encodable, Value: Decodable>(
        _ input: Input,
        function: (UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>?
    ) throws -> Value {
        let data = try JSONEncoder().encode(input)
        guard let json = String(data: data, encoding: .utf8) else {
            throw OpaqueClientError.invalidResponse
        }
        let pointer = json.withCString { function($0) }
        return try decode(pointer)
    }

    private func decode<Value: Decodable>(
        _ pointer: UnsafeMutablePointer<CChar>?
    ) throws -> Value {
        guard let pointer else { throw OpaqueClientError.unavailable }
        defer { athena_opaque_string_free(pointer) }
        let data = Data(String(cString: pointer).utf8)
        let envelope = try JSONDecoder().decode(OpaqueEnvelope<Value>.self, from: data)
        guard envelope.ok, let value = envelope.value else {
            throw OpaqueClientError.operationFailed(
                envelope.error ?? "快速登录密码学验证失败。"
            )
        }
        return value
    }
}
