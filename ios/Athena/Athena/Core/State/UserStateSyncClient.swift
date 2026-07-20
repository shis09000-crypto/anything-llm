import Foundation
import Observation

private struct RecentNavigationStateEnvelope: Decodable {
    let success: Bool
    let states: [RecentNavigationStateRecord]
}

private struct RecentNavigationStateRecord: Decodable {
    let namespace: String
    let scope: String
    let value: RecentNavigationState
    let version: String?
    let updatedAt: String?
}

private struct UserStatePatchRequest: Encodable {
    let states: [RecentNavigationPatch]
}

private struct RecentNavigationPatch: Encodable {
    let namespace: String
    let scope: String
    let value: RecentNavigationState
    let version: String
}

private struct UserStatePatchResponse: Decodable {
    let success: Bool
}

private struct DrawerPinsStateEnvelope: Decodable {
    let success: Bool
    let states: [DrawerPinsStateRecord]
}

private struct DrawerPinsStateRecord: Decodable {
    let namespace: String
    let scope: String
    let value: IOSDrawerPinsState
}

private struct DrawerPinsPatchRequest: Encodable {
    let states: [DrawerPinsPatch]
}

private struct DrawerPinsPatch: Encodable {
    let namespace: String
    let scope: String
    let value: IOSDrawerPinsState
    let version: String
}

@MainActor
@Observable
final class UserStateSyncClient {
    enum Status: Equatable {
        case disconnected
        case ready
        case failed(String)
    }

    var status: Status = .disconnected
    var userStatePath = "/api/system/user/state"

    func applyBootstrap(_ bootstrap: NativeAppBootstrap?) {
        userStatePath = bootstrap?.endpoints.userStatePath ?? "/api/system/user/state"
    }

    func fetchRecentNavigation(using apiClient: APIClient) async throws -> RecentNavigationState {
        let response = try await apiClient.getJSON(
            RecentNavigationStateEnvelope.self,
            path: userStatePath,
            queryItems: [URLQueryItem(name: "namespaces", value: "recent.navigation")],
            authorization: .required
        )
        guard response.success else {
            status = .failed("Failed to load recent navigation")
            return .empty
        }
        status = .ready
        return response.states.first(where: {
            $0.namespace == "recent.navigation" && $0.scope == "global"
        })?.value ?? .empty
    }

    func saveRecentNavigation(
        _ value: RecentNavigationState,
        using apiClient: APIClient
    ) async throws {
        let response = try await apiClient.requestJSON(
            UserStatePatchResponse.self,
            method: .patch,
            path: userStatePath,
            body: UserStatePatchRequest(
                states: [
                    RecentNavigationPatch(
                        namespace: "recent.navigation",
                        scope: "global",
                        value: value,
                        version: "1"
                    ),
                ]
            ),
            authorization: .required,
            signing: .required
        )
        status = response.success ? .ready : .failed("Failed to save recent navigation")
    }

    func fetchDrawerPins(using apiClient: APIClient) async throws -> IOSDrawerPinsState {
        let response = try await apiClient.getJSON(
            DrawerPinsStateEnvelope.self,
            path: userStatePath,
            queryItems: [URLQueryItem(name: "namespaces", value: IOSDrawerPinsState.namespace)],
            authorization: .required
        )
        guard response.success else {
            status = .failed("Failed to load drawer pins")
            return .empty
        }
        status = .ready
        return response.states.first(where: {
            $0.namespace == IOSDrawerPinsState.namespace && $0.scope == "global"
        })?.value ?? .empty
    }

    func saveDrawerPins(
        _ value: IOSDrawerPinsState,
        using apiClient: APIClient
    ) async throws {
        let response = try await apiClient.requestJSON(
            UserStatePatchResponse.self,
            method: .patch,
            path: userStatePath,
            body: DrawerPinsPatchRequest(
                states: [
                    DrawerPinsPatch(
                        namespace: IOSDrawerPinsState.namespace,
                        scope: "global",
                        value: value,
                        version: "1"
                    ),
                ]
            ),
            authorization: .required,
            signing: .required,
            retryOnConnectionLoss: true
        )
        status = response.success ? .ready : .failed("Failed to save drawer pins")
    }

    func reset() {
        status = .disconnected
    }
}
