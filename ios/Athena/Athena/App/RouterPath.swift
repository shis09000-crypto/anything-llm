import SwiftUI
import Observation

@MainActor
@Observable
final class RouterPath {
    var path: [AppRoute] = []
    var presentedSheet: SheetDestination?

    func navigate(to route: AppRoute) {
        path.append(route)
    }

    func present(_ destination: SheetDestination) {
        presentedSheet = destination
    }

    func reset() {
        path.removeAll()
        presentedSheet = nil
    }
}

@MainActor
@Observable
final class TabRouter {
    private var routers: [AppTab: RouterPath] = [:]

    func router(for tab: AppTab) -> RouterPath {
        if let router = routers[tab] {
            return router
        }
        let router = RouterPath()
        routers[tab] = router
        return router
    }

    func binding(for tab: AppTab) -> Binding<[AppRoute]> {
        let router = router(for: tab)
        return Binding(
            get: { router.path },
            set: { router.path = $0 }
        )
    }
}

extension View {
    func withAppRouter() -> some View {
        navigationDestination(for: AppRoute.self) { route in
            switch route {
            case .thread(let workspaceID, let threadID):
                ChatView(workspaceID: workspaceID, threadID: threadID)
            case .readerDocument(let documentID):
                ReaderDocumentDetailView(documentID: documentID)
            case .agentSession(let sessionID):
                AgentSessionDetailView(sessionID: sessionID)
            case .settings(let section):
                SettingsSectionView(section: section)
            }
        }
    }
}
