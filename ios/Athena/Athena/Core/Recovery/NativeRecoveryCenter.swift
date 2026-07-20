import Foundation
import Observation

enum NativeRecoveryDisposition: Equatable, Sendable {
    case silent
    case reconcile
    case rollback
    case securityRecovery
}

struct NativeRecoveryDirective: Equatable, Sendable {
    let disposition: NativeRecoveryDisposition
    let message: String?
    let mayRetryOnce: Bool
}

struct NativeRecoveryNotice: Identifiable, Equatable, Sendable {
    let id: String
    let title: String
    let message: String
}

@MainActor
@Observable
final class NativeRecoveryCenter {
    var notice: NativeRecoveryNotice?

    func classify(_ error: Error) -> NativeRecoveryDirective {
        if error is CancellationError {
            return NativeRecoveryDirective(disposition: .silent, message: nil, mayRetryOnce: false)
        }
        if let schedulerError = error as? AthenaTaskSchedulerError {
            switch schedulerError {
            case .cancelled, .stale:
                return NativeRecoveryDirective(disposition: .silent, message: nil, mayRetryOnce: false)
            case .pendingBudgetExceeded, .dedupeTypeMismatch:
                return NativeRecoveryDirective(
                    disposition: .reconcile,
                    message: schedulerError.localizedDescription,
                    mayRetryOnce: false
                )
            }
        }
        if error is URLError {
            return NativeRecoveryDirective(
                disposition: .reconcile,
                message: "网络暂时不可用，Athena 正在确认操作结果。",
                mayRetryOnce: false
            )
        }
        if let apiError = error as? APIClientError {
            switch apiError {
            case .authenticationRequired, .clientIdentityRequired, .signingUnavailable:
                return NativeRecoveryDirective(
                    disposition: .securityRecovery,
                    message: "登录或设备安全状态已失效，请重新验证。",
                    mayRetryOnce: false
                )
            case .httpStatus(let status, _, let message):
                if status == 401 {
                    return NativeRecoveryDirective(
                        disposition: .securityRecovery,
                        message: message ?? "登录状态已失效。",
                        mayRetryOnce: false
                    )
                }
                if status == 403 {
                    return NativeRecoveryDirective(
                        disposition: .rollback,
                        message: message ?? "没有执行此操作的权限。",
                        mayRetryOnce: false
                    )
                }
                if status == 400 || status == 409 {
                    return NativeRecoveryDirective(
                        disposition: .rollback,
                        message: message ?? "服务器拒绝了此操作。",
                        mayRetryOnce: false
                    )
                }
                if status >= 500 {
                    return NativeRecoveryDirective(
                        disposition: .reconcile,
                        message: message ?? "服务器暂时不可用，Athena 正在确认操作结果。",
                        mayRetryOnce: true
                    )
                }
                return NativeRecoveryDirective(
                    disposition: .rollback,
                    message: message ?? apiError.localizedDescription,
                    mayRetryOnce: false
                )
            case .superseded:
                return NativeRecoveryDirective(disposition: .silent, message: nil, mayRetryOnce: false)
            case .invalidURL, .invalidResponse:
                return NativeRecoveryDirective(
                    disposition: .reconcile,
                    message: apiError.localizedDescription,
                    mayRetryOnce: false
                )
            }
        }
        return NativeRecoveryDirective(
            disposition: .reconcile,
            message: error.localizedDescription,
            mayRetryOnce: false
        )
    }

    func present(_ directive: NativeRecoveryDirective, title: String = "操作未完成") {
        guard let message = directive.message, directive.disposition != .silent else { return }
        notice = NativeRecoveryNotice(id: UUID().uuidString, title: title, message: message)
    }

    func dismissNotice() {
        notice = nil
    }
}
