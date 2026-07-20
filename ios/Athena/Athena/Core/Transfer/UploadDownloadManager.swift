import Foundation
import Observation

@MainActor
@Observable
final class UploadDownloadManager {
    enum Status: Equatable {
        case idle
        case waitingForBackgroundTransfer
        case active
    }

    var uploadStatus: Status = .waitingForBackgroundTransfer
    var downloadStatus: Status = .waitingForBackgroundTransfer
}
