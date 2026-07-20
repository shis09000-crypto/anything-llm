import BackgroundTasks
import UIKit

@MainActor
final class NativePushBridge {
    static let shared = NativePushBridge()

    private weak var dependencies: AppDependencies?
    private var pendingDeviceToken: Data?

    func connect(_ dependencies: AppDependencies) {
        self.dependencies = dependencies
        if let pendingDeviceToken {
            self.pendingDeviceToken = nil
            Task {
                await dependencies.nativeSyncCenter.receiveDeviceToken(pendingDeviceToken)
            }
        }
    }

    func receiveDeviceToken(_ token: Data) {
        guard let dependencies else {
            pendingDeviceToken = token
            return
        }
        Task {
            await dependencies.nativeSyncCenter.receiveDeviceToken(token)
        }
    }

    func performBackgroundSync() async -> Bool {
        await dependencies?.nativeSyncCenter.handleBackgroundPush() ?? false
    }
}

@MainActor
final class NativeAppDelegate: NSObject, UIApplicationDelegate {
    static let refreshIdentifier = "com.athena.native.sync.refresh"

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        BGTaskScheduler.shared.register(
            forTaskWithIdentifier: Self.refreshIdentifier,
            using: nil
        ) { task in
            guard let refreshTask = task as? BGAppRefreshTask else {
                task.setTaskCompleted(success: false)
                return
            }
            let operation = Task { @MainActor in
                let success = await NativePushBridge.shared.performBackgroundSync()
                refreshTask.setTaskCompleted(success: success)
            }
            refreshTask.expirationHandler = {
                operation.cancel()
            }
        }
        return true
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        NativePushBridge.shared.receiveDeviceToken(deviceToken)
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {}

    func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        Task { @MainActor in
            let success = await NativePushBridge.shared.performBackgroundSync()
            completionHandler(success ? .newData : .failed)
        }
    }

    static func scheduleRefresh() {
        let request = BGAppRefreshTaskRequest(identifier: refreshIdentifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }
}
