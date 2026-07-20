import Foundation
import Observation

enum RuntimeLoadState: Equatable {
    case idle
    case loading
    case loaded
    case failed(String)

    var title: String {
        switch self {
        case .idle:
            "Idle"
        case .loading:
            "Checking"
        case .loaded:
            "Ready"
        case .failed:
            "Needs Attention"
        }
    }
}

@MainActor
@Observable
final class NativeAppRuntime {
    var bootstrap: NativeAppBootstrap?
    var preflight: NativeAppPreflight?
    var loadState: RuntimeLoadState = .idle

    init(bootstrap: NativeAppBootstrap? = nil, preflight: NativeAppPreflight? = nil) {
        self.bootstrap = bootstrap
        self.preflight = preflight
        if bootstrap != nil || preflight != nil {
            self.loadState = .loaded
        }
    }

    func refresh(using client: NativeBootstrapClient) async {
        loadState = .loading
        do {
            async let nextBootstrap = client.fetchBootstrap()
            async let nextPreflight = client.fetchPreflight()
            bootstrap = try await nextBootstrap
            preflight = try await nextPreflight
            loadState = .loaded
        } catch is CancellationError {
            return
        } catch {
            loadState = .failed(error.localizedDescription)
        }
    }
}
