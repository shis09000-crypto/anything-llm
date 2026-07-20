import SwiftUI

enum SheetDestination: Identifiable, Hashable {
    case apiBase
    case readerPreview(documentID: String)
    case sensitiveSession(reason: String)

    var id: String {
        switch self {
        case .apiBase:
            "apiBase"
        case .readerPreview(let documentID):
            "readerPreview:\(documentID)"
        case .sensitiveSession(let reason):
            "sensitiveSession:\(reason)"
        }
    }
}

extension View {
    func withSheetDestinations(sheet: Binding<SheetDestination?>) -> some View {
        self.sheet(item: sheet) { destination in
            NavigationStack {
                switch destination {
                case .apiBase:
                    APIBaseSheet()
                case .readerPreview(let documentID):
                    ReaderPreviewSheet(documentID: documentID)
                case .sensitiveSession(let reason):
                    SensitiveSessionSheet(reason: reason)
                }
            }
        }
    }
}
