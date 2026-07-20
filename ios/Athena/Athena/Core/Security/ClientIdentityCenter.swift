import Foundation
import Observation

@MainActor
@Observable
final class ClientIdentityCenter {
    enum Status: Equatable {
        case notRegistered
        case restored(clientID: String)
        case registered(clientID: String)

        var displayTitle: String {
            switch self {
            case .notRegistered:
                "Not Registered"
            case .restored:
                "Restored"
            case .registered:
                "Registered"
            }
        }
    }

    private enum Keys {
        static let clientID = "clientIdentity.clientID"
    }

    private let secureStore: SecureValueStore
    var status: Status = .notRegistered
    var requiredHeaders: [String: String] = [:]

    var clientID: String? {
        switch status {
        case .notRegistered:
            nil
        case .restored(let clientID), .registered(let clientID):
            clientID
        }
    }

    init(secureStore: SecureValueStore) {
        self.secureStore = secureStore
    }

    func applyBootstrap(_ bootstrap: NativeAppBootstrap?) {
        requiredHeaders = bootstrap?.security.clientIdentityHeaders ?? [:]
    }

    @discardableResult
    func prepare() throws -> String {
        if let restored = try restoreClientID() {
            status = .restored(clientID: restored)
            return restored
        }

        let generated = "ios_\(UUID().uuidString.lowercased())"
        try secureStore.setData(Data(generated.utf8), forKey: Keys.clientID)
        status = .registered(clientID: generated)
        return generated
    }

    func restore() {
        guard let restored = try? restoreClientID() else {
            status = .notRegistered
            return
        }
        status = .restored(clientID: restored)
    }

    func reset() throws {
        try secureStore.removeData(forKey: Keys.clientID)
        status = .notRegistered
    }

    func headers(
        requestID: String,
        configuration: APIClientConfiguration
    ) -> [String: String]? {
        guard let clientID else {
            return nil
        }

        return [
            headerName(for: "clientId", fallback: "X-Athena-Client-Id"): clientID,
            headerName(for: "platform", fallback: "X-Athena-Platform"): configuration.platform,
            headerName(for: "appVersion", fallback: "X-Athena-App-Version"): configuration.appVersion,
            headerName(for: "requestId", fallback: "X-Athena-Request-Id"): requestID,
            headerName(for: "capabilitySource", fallback: "X-Athena-Capability-Source"): "declared",
        ]
    }

    private func restoreClientID() throws -> String? {
        guard
            let data = try secureStore.data(forKey: Keys.clientID),
            let clientID = String(data: data, encoding: .utf8),
            !clientID.isEmpty
        else {
            return nil
        }
        return clientID
    }

    private func headerName(for key: String, fallback: String) -> String {
        requiredHeaders[key] ?? fallback
    }
}
