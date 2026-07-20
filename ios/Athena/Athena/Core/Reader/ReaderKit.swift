import Foundation
import Observation

struct ReaderDocumentSummary: Identifiable, Hashable {
    let id: String
    let title: String
    let kind: String
    let status: String
    let workspaceID: String?
}

@MainActor
@Observable
final class ReaderKit {
    var documents: [ReaderDocumentSummary]
    var maxUploadBytes: Int64 = 500 * 1024 * 1024
    var standaloneBasePath = "/api/reader-documents"
    var workspaceBasePathTemplate = "/api/workspace/:slug/reader-documents"

    init(documents: [ReaderDocumentSummary] = PreviewData.readerDocuments) {
        self.documents = documents
    }

    func applyBootstrap(_ bootstrap: NativeAppBootstrap?) {
        maxUploadBytes = bootstrap?.features.readerMaxUploadBytes ?? 500 * 1024 * 1024
        standaloneBasePath = bootstrap?.endpoints.readerStandaloneBasePath ?? "/api/reader-documents"
        workspaceBasePathTemplate = bootstrap?.endpoints.readerWorkspaceBasePathTemplate ?? "/api/workspace/:slug/reader-documents"
    }
}
