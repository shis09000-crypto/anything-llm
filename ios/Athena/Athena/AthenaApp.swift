import SwiftUI

@main
@MainActor
struct AthenaApp: App {
    @UIApplicationDelegateAdaptor(NativeAppDelegate.self) private var appDelegate
    @State private var dependencies: AppDependencies
    @Environment(\.scenePhase) private var scenePhase
    private let usesConversationFixture: Bool
    private let usesSettingsFixture: Bool
    private let usesAuthFixture: Bool
    private let settingsFixtureDestination: NativeSettingsDestination?

    init() {
        #if DEBUG
        let arguments = ProcessInfo.processInfo.arguments
        let usesFixture = arguments.contains("-AthenaConversationFixture")
        let settingsFixture = arguments.contains("-AthenaSettingsFixture")
        let authFixture = arguments.contains("-AthenaAuthFixture")
        usesConversationFixture = usesFixture
        usesSettingsFixture = settingsFixture
        usesAuthFixture = authFixture
        if let index = arguments.firstIndex(of: "-AthenaSettingsDestination"),
           arguments.indices.contains(index + 1) {
            settingsFixtureDestination = NativeSettingsDestination(rawValue: arguments[index + 1])
        } else {
            settingsFixtureDestination = nil
        }
        _dependencies = State(
            initialValue: (usesFixture || settingsFixture || authFixture)
                ? AppDependencies.preview(
                    workspaces: WorkspacePreviewFixtures.conversationSimulatorWorkspaces,
                    selectedThreadID: WorkspacePreviewFixtures.conversationSimulatorThreadID
                )
                : AppDependencies.live()
        )
        #else
        usesConversationFixture = false
        usesSettingsFixture = false
        usesAuthFixture = false
        settingsFixtureDestination = nil
        _dependencies = State(initialValue: AppDependencies.live())
        #endif
    }

    var body: some Scene {
        WindowGroup {
            Group {
                if usesConversationFixture {
                    ConversationHomeView(workspaceCenter: dependencies.workspaceCenter)
                } else if usesSettingsFixture {
                    NavigationStack {
                        if let settingsFixtureDestination {
                            NativeSettingsDetailView(destination: settingsFixtureDestination)
                        } else {
                            SettingsView()
                        }
                    }
                } else if usesAuthFixture {
                    AthenaAuthFlowView(phase: .signedOut(nil))
                } else {
                    AppView()
                }
            }
                .environment(dependencies)
                .preferredColorScheme(dependencies.accountSettingsCenter.preferences.appearance.colorScheme)
                .tint(dependencies.accountSettingsCenter.preferences.accent.color)
                .task {
                    if !usesConversationFixture && !usesSettingsFixture && !usesAuthFixture {
                        NativePushBridge.shared.connect(dependencies)
                    }
                }
        }
        .onChange(of: scenePhase) { _, nextPhase in
            guard !usesConversationFixture && !usesSettingsFixture && !usesAuthFixture else { return }
            Task {
                await dependencies.setApplicationBackgrounded(nextPhase != .active)
            }
        }
    }
}
