import Foundation

@MainActor
final class NativeBootstrapClient {
    private let apiClient: APIClient
    private let fixtureBootstrap: NativeAppBootstrap?
    private let fixturePreflight: NativeAppPreflight?
    private let compatibilityBootstrap: NativeAppBootstrap?
    private let compatibilityPreflight: NativeAppPreflight?

    init(
        apiClient: APIClient,
        fixtureBootstrap: NativeAppBootstrap? = nil,
        fixturePreflight: NativeAppPreflight? = nil,
        compatibilityBootstrap: NativeAppBootstrap? = nil,
        compatibilityPreflight: NativeAppPreflight? = nil
    ) {
        self.apiClient = apiClient
        self.fixtureBootstrap = fixtureBootstrap
        self.fixturePreflight = fixturePreflight
        self.compatibilityBootstrap = compatibilityBootstrap
        self.compatibilityPreflight = compatibilityPreflight
    }

    func fetchBootstrap() async throws -> NativeAppBootstrap {
        if let fixtureBootstrap {
            return fixtureBootstrap
        }
        do {
            return try await apiClient.getJSON(
                NativeAppBootstrap.self,
                path: "/api/native-app/bootstrap",
                authorization: .none,
                retryOnConnectionLoss: true
            )
        } catch {
            guard shouldUseCompatibilityContract(for: error), let compatibilityBootstrap else {
                throw error
            }
            return compatibilityBootstrap
        }
    }

    func fetchPreflight() async throws -> NativeAppPreflight {
        if let fixturePreflight {
            return fixturePreflight
        }
        do {
            return try await apiClient.getJSON(
                NativeAppPreflight.self,
                path: "/api/native-app/preflight",
                queryItems: [
                    URLQueryItem(name: "platform", value: apiClient.configuration.platform),
                    URLQueryItem(name: "appVersion", value: apiClient.configuration.appVersion),
                    URLQueryItem(name: "osVersion", value: apiClient.configuration.osVersion),
                ],
                authorization: .none,
                retryOnConnectionLoss: true
            )
        } catch {
            guard shouldUseCompatibilityContract(for: error), let compatibilityPreflight else {
                throw error
            }
            return compatibilityPreflight
        }
    }

    private func shouldUseCompatibilityContract(for error: Error) -> Bool {
        if error is DecodingError {
            return true
        }
        if case APIClientError.httpStatus(let status, _, _) = error {
            return status == 404
        }
        return false
    }
}
