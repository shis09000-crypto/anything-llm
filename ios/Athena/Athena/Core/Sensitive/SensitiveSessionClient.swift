import Foundation
import Observation

@MainActor
@Observable
final class SensitiveSessionClient {
    enum Status: Equatable {
        case inactive
        case pendingApproval(reason: String)
        case active(expiresAt: Date)
    }

    private(set) var status: Status = .inactive
    private(set) var headerName = "X-Athena-Sensitive-Session"
    private var token: String?
    private var resourceID: String?
    private var expiryTask: Task<Void, Never>?

    func applyBootstrap(_ bootstrap: NativeAppBootstrap?) {
        headerName = bootstrap?.security.sensitiveSessionHeader ?? "X-Athena-Sensitive-Session"
    }

    func request(reason: String) {
        status = .pendingApproval(reason: reason)
    }

    func activate(_ session: NativeSensitiveSession, resourceID: String) {
        end()
        let expiresAt = Self.expiryDate(for: session)
        token = session.token
        self.resourceID = resourceID
        status = .active(expiresAt: expiresAt)
        expiryTask = Task { [weak self] in
            let delay = max(0, expiresAt.timeIntervalSinceNow)
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            await MainActor.run { self?.end() }
        }
    }

    func headers(for resourceID: String) -> [String: String] {
        guard self.resourceID == resourceID else { return [:] }
        guard let token,
              case .active(let expiresAt) = status else {
            return [:]
        }
        guard expiresAt > Date() else {
            end()
            return [:]
        }
        return [headerName: token]
    }

    func end() {
        expiryTask?.cancel()
        expiryTask = nil
        token = nil
        resourceID = nil
        status = .inactive
    }

    private static func expiryDate(for session: NativeSensitiveSession) -> Date {
        if let raw = session.expiresAt {
            let formatter = ISO8601DateFormatter()
            if let date = formatter.date(from: raw) { return date }
        }
        return Date().addingTimeInterval(
            TimeInterval(session.ttlMs ?? 5 * 60 * 1_000) / 1_000
        )
    }
}
