import SwiftUI

struct ReaderView: View {
    @Environment(AppDependencies.self) private var dependencies
    @Environment(RouterPath.self) private var router

    var body: some View {
        AthenaScrollSurface(spacing: AthenaSpacing.lg) {
            ReaderCapabilityPanel()

            VStack(alignment: .leading, spacing: AthenaSpacing.md) {
                SectionHeader("Documents", subtitle: "Preview is native; original access stays gated by Sensitive Session")
                ForEach(dependencies.readerKit.documents) { document in
                    Button {
                        router.navigate(to: .readerDocument(documentID: document.id))
                    } label: {
                        ReaderDocumentRow(document: document)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button {
                    dependencies.uploadDownloadManager.uploadStatus = .active
                } label: {
                    Image(systemName: "square.and.arrow.up")
                }
                .accessibilityLabel("Upload")
                .athenaGlassButton()
            }
        }
    }
}

private struct ReaderCapabilityPanel: View {
    @Environment(AppDependencies.self) private var dependencies

    var body: some View {
        AthenaPanel {
            VStack(alignment: .leading, spacing: AthenaSpacing.md) {
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Reader")
                            .font(.title3.weight(.bold))
                        Text("Upload, postprocess, preview, and original-file access")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    StatusPill(title: uploadStatusTitle, systemImage: "icloud.and.arrow.up", tint: uploadTint)
                }

                AthenaMetricRow(
                    title: "Maximum upload",
                    value: ByteCountFormatter.string(fromByteCount: dependencies.readerKit.maxUploadBytes, countStyle: .file),
                    systemImage: "externaldrive.badge.plus",
                    tint: .blue
                )
            }
        }
    }

    private var uploadStatusTitle: String {
        switch dependencies.uploadDownloadManager.uploadStatus {
        case .idle:
            "Idle"
        case .waitingForBackgroundTransfer:
            "Foreground"
        case .active:
            "Active"
        }
    }

    private var uploadTint: Color {
        switch dependencies.uploadDownloadManager.uploadStatus {
        case .idle:
            .gray
        case .waitingForBackgroundTransfer:
            .orange
        case .active:
            .green
        }
    }
}

private struct ReaderDocumentRow: View {
    let document: ReaderDocumentSummary

    var body: some View {
        AthenaPanel {
            HStack(spacing: AthenaSpacing.md) {
                AthenaIconTile(systemImage: "doc.text", tint: .blue)
                VStack(alignment: .leading, spacing: 4) {
                    Text(document.title)
                        .font(.headline)
                        .foregroundStyle(.primary)
                    HStack {
                        Text(document.kind)
                        Text(document.status)
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
        }
    }
}

struct ReaderDocumentDetailView: View {
    let documentID: String
    @Environment(RouterPath.self) private var router

    var body: some View {
        AthenaScrollSurface(spacing: AthenaSpacing.lg) {
            SectionHeader("Document", subtitle: documentID)

            AthenaPanel {
                VStack(alignment: .leading, spacing: AthenaSpacing.md) {
                    AthenaMetricRow(title: "Preview", value: "Available after postprocess", systemImage: "doc.richtext", tint: .blue)
                    AthenaMetricRow(title: "Original", value: "Requires Sensitive Session", systemImage: "lock.doc", tint: .orange)
                }
            }

            AthenaGlassGroup {
                HStack(spacing: AthenaSpacing.md) {
                    Button {
                        router.present(.readerPreview(documentID: documentID))
                    } label: {
                        Label("Preview", systemImage: "doc.richtext")
                    }
                    .athenaGlassButton()

                    Button {
                        router.present(.sensitiveSession(reason: "reader-original:\(documentID)"))
                    } label: {
                        Label("Original", systemImage: "lock.doc")
                    }
                    .athenaGlassButton(prominent: true)
                }
            }

        }
        .navigationTitle("Reader")
        .navigationBarTitleDisplayMode(.inline)
    }
}

struct ReaderPreviewSheet: View {
    let documentID: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        AthenaScrollSurface(spacing: AthenaSpacing.lg) {
            SectionHeader("Preview", subtitle: documentID)
            RoundedRectangle(cornerRadius: AthenaRadius.lg, style: .continuous)
                .fill(.secondary.opacity(0.12))
                .overlay {
                    Image(systemName: "doc.text.magnifyingglass")
                        .font(.largeTitle)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, minHeight: 260)
        }
        .navigationTitle("Reader Preview")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Done") {
                    dismiss()
                }
            }
        }
    }
}

struct SensitiveSessionSheet: View {
    let reason: String
    @Environment(\.dismiss) private var dismiss
    @Environment(AppDependencies.self) private var dependencies

    var body: some View {
        AthenaScrollSurface(spacing: AthenaSpacing.lg) {
            SectionHeader("Sensitive Session", subtitle: reason)
            AthenaPanel {
                AthenaMetricRow(
                    title: "Session header",
                    value: dependencies.sensitiveSessionClient.headerName,
                    systemImage: "key",
                    tint: .orange
                )
            }
            Button {
                dependencies.sensitiveSessionClient.request(reason: reason)
                dismiss()
            } label: {
                Label("Request Access", systemImage: "lock.open")
                    .frame(maxWidth: .infinity)
            }
            .athenaGlassButton(prominent: true)
        }
        .navigationTitle("Access")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Done") {
                    dismiss()
                }
            }
        }
    }
}

struct ReaderView_Previews: PreviewProvider {
    static var previews: some View {
        NavigationStack {
            ReaderView()
        }
        .environment(RouterPath())
        .environment(AppDependencies.preview())
    }
}
