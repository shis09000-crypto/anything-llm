import Foundation

extension WorkspaceCenter {
    enum BootstrapRefreshMode: Equatable {
        case cacheFirst
        case authoritative

        var forceRefresh: Bool { self == .authoritative }
    }

    enum Source: Equatable {
        case live
        case preview
    }

    enum LoadState: Equatable {
        case idle
        case loading
        case ready
        case stale(String)
        case failed(String)
    }
}
