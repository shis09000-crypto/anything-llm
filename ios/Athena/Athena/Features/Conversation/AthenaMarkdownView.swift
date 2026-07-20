import Markdown
import SwiftUI

struct AthenaMarkdownView: View {
    private let source: String
    private let cacheKey: String
    private let isStreaming: Bool
    @State private var renderedSource: String?
    @State private var renderedBlocks: [AthenaMarkdownBlock]?

    init(
        _ source: String,
        cacheKey: String? = nil,
        isStreaming: Bool = false
    ) {
        self.source = source
        self.cacheKey = cacheKey ?? "markdown:\(source.hashValue)"
        self.isStreaming = isStreaming
        let cached = isStreaming
            ? nil
            : MarkdownRenderCache.shared.cachedBlocks(
                for: self.cacheKey,
                source: source
            )
        _renderedSource = State(initialValue: cached == nil ? nil : source)
        _renderedBlocks = State(initialValue: cached)
    }

    var body: some View {
        Group {
            if isStreaming {
                Text(source)
                    .font(.body)
                    .lineSpacing(5)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else if renderedSource == source, let renderedBlocks {
                AthenaMarkdownBlocksView(blocks: renderedBlocks, spacing: 10)
            } else {
                Text(source)
                    .font(.body)
                    .lineSpacing(5)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .task(id: MarkdownRenderIdentity(key: cacheKey, source: source, isStreaming: isStreaming)) {
            guard !isStreaming else { return }
            guard renderedSource != source || renderedBlocks == nil else {
                return
            }
            if let cached = MarkdownRenderCache.shared.cachedBlocks(
                for: cacheKey,
                source: source
            ) {
                renderedSource = source
                renderedBlocks = cached
                return
            }
            let blocks = await MarkdownRenderCache.shared.blocks(
                for: cacheKey,
                source: source
            )
            guard !Task.isCancelled else { return }
            renderedSource = source
            renderedBlocks = blocks
        }
    }
}

private struct MarkdownRenderIdentity: Hashable {
    let key: String
    let source: String
    let isStreaming: Bool
}

struct AthenaMarkdownBlock: Identifiable, Sendable {
    enum Kind: Sendable {
        case heading(level: Int, text: AttributedString)
        case paragraph(AttributedString)
        case code(language: String?, content: String)
        case unorderedList([AthenaMarkdownListEntry])
        case orderedList(start: Int, items: [AthenaMarkdownListEntry])
        case quote([AthenaMarkdownBlock])
        case table(header: [AttributedString], rows: [[AttributedString]])
        case separator
        case group([AthenaMarkdownBlock])
    }

    let id: Int
    let kind: Kind
}

struct AthenaMarkdownListEntry: Identifiable, Sendable {
    let id: Int
    let blocks: [AthenaMarkdownBlock]
}

enum AthenaMarkdownDocumentParser {
    static func parse(_ source: String) -> [AthenaMarkdownBlock] {
        let document = Document(
            parsing: source,
            options: [.parseBlockDirectives, .disableSmartOpts]
        )
        var nextID = 0
        let blocks = childBlocks(of: document, nextID: &nextID)
        if blocks.isEmpty, !source.isEmpty {
            return [
                AthenaMarkdownBlock(
                    id: nextID,
                    kind: .paragraph(AttributedString(source))
                ),
            ]
        }
        return blocks
    }

    private static func childBlocks(
        of markup: Markup,
        nextID: inout Int
    ) -> [AthenaMarkdownBlock] {
        markup.children.compactMap { child in
            block(from: child, nextID: &nextID)
        }
    }

    private static func block(
        from markup: Markup,
        nextID: inout Int
    ) -> AthenaMarkdownBlock? {
        let id = nextID
        nextID += 1

        switch markup {
        case let heading as Heading:
            return AthenaMarkdownBlock(
                id: id,
                kind: .heading(
                    level: heading.level,
                    text: attributedText(from: heading)
                )
            )
        case let paragraph as Paragraph:
            return AthenaMarkdownBlock(
                id: id,
                kind: .paragraph(attributedText(from: paragraph))
            )
        case let codeBlock as CodeBlock:
            return AthenaMarkdownBlock(
                id: id,
                kind: .code(
                    language: codeBlock.language,
                    content: codeBlock.code
                )
            )
        case let unorderedList as UnorderedList:
            var items: [AthenaMarkdownListEntry] = []
            for item in unorderedList.listItems {
                items.append(listEntry(from: item, nextID: &nextID))
            }
            return AthenaMarkdownBlock(id: id, kind: .unorderedList(items))
        case let orderedList as OrderedList:
            var items: [AthenaMarkdownListEntry] = []
            for item in orderedList.listItems {
                items.append(listEntry(from: item, nextID: &nextID))
            }
            return AthenaMarkdownBlock(
                id: id,
                kind: .orderedList(
                    start: Int(orderedList.startIndex),
                    items: items
                )
            )
        case let quote as BlockQuote:
            return AthenaMarkdownBlock(
                id: id,
                kind: .quote(childBlocks(of: quote, nextID: &nextID))
            )
        case let table as Markdown.Table:
            let header = Array(table.head.cells.map(attributedText(from:)))
            let rows = Array(table.body.rows.map { row in
                Array(row.cells.map(attributedText(from:)))
            })
            return AthenaMarkdownBlock(
                id: id,
                kind: .table(header: header, rows: rows)
            )
        case is ThematicBreak:
            return AthenaMarkdownBlock(id: id, kind: .separator)
        case is HTMLBlock:
            return nil
        default:
            let children = childBlocks(of: markup, nextID: &nextID)
            if !children.isEmpty {
                return AthenaMarkdownBlock(id: id, kind: .group(children))
            }
            let text = attributedText(from: markup)
            return text.characters.isEmpty
                ? nil
                : AthenaMarkdownBlock(id: id, kind: .paragraph(text))
        }
    }

    private static func listEntry(
        from item: ListItem,
        nextID: inout Int
    ) -> AthenaMarkdownListEntry {
        let id = nextID
        nextID += 1
        return AthenaMarkdownListEntry(
            id: id,
            blocks: childBlocks(of: item, nextID: &nextID)
        )
    }

    private static func attributedText(from markup: Markup) -> AttributedString {
        let source = markup.format().trimmingCharacters(in: .whitespacesAndNewlines)
        return attributedText(fromSource: source)
    }

    private static func attributedText(
        from cell: Markdown.Table.Cell
    ) -> AttributedString {
        let source = cell.inlineChildren
            .map { $0.format() }
            .joined()
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return attributedText(fromSource: source)
    }

    private static func attributedText(fromSource source: String) -> AttributedString {
        guard !source.isEmpty else {
            return AttributedString()
        }
        return (try? AttributedString(markdown: source)) ?? AttributedString(source)
    }
}

private struct AthenaMarkdownBlocksView: View {
    let blocks: [AthenaMarkdownBlock]
    let spacing: CGFloat

    var body: some View {
        VStack(alignment: .leading, spacing: spacing) {
            ForEach(blocks) { block in
                AthenaMarkdownBlockView(block: block)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct AthenaMarkdownBlockView: View {
    let block: AthenaMarkdownBlock

    @ViewBuilder
    var body: some View {
        switch block.kind {
        case .heading(let level, let text):
            Text(text)
                .font(headingFont(level: level))
                .frame(maxWidth: .infinity, alignment: .leading)
        case .paragraph(let text):
            Text(text)
                .font(.body)
                .lineSpacing(5)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .code(let language, let content):
            codeBlock(language: language, content: content)
        case .unorderedList(let items):
            list(items: items, start: nil)
        case .orderedList(let start, let items):
            list(items: items, start: start)
        case .quote(let children):
            HStack(alignment: .top, spacing: 10) {
                Capsule()
                    .fill(.secondary.opacity(0.35))
                    .frame(width: 3)
                AthenaMarkdownBlocksView(blocks: children, spacing: 6)
                    .foregroundStyle(.secondary)
            }
        case .table(let header, let rows):
            table(header: header, rows: rows)
        case .separator:
            Divider()
        case .group(let children):
            AthenaMarkdownBlocksView(blocks: children, spacing: 8)
        }
    }

    private func headingFont(level: Int) -> Font {
        switch level {
        case 1:
            .title2.weight(.semibold)
        case 2:
            .title3.weight(.semibold)
        case 3:
            .headline
        default:
            .body.weight(.semibold)
        }
    }

    private func codeBlock(language: String?, content: String) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if let language, !language.isEmpty {
                Text(language)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 12)
                    .padding(.top, 10)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                Text(content)
                    .font(.system(.callout, design: .monospaced))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            .secondary.opacity(0.08),
            in: RoundedRectangle(cornerRadius: 8, style: .continuous)
        )
    }

    private func list(
        items: [AthenaMarkdownListEntry],
        start: Int?
    ) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            ForEach(Array(items.enumerated()), id: \.element.id) { offset, item in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(start.map { "\($0 + offset)." } ?? "•")
                        .foregroundStyle(.secondary)
                        .frame(minWidth: 18, alignment: .trailing)
                    AthenaMarkdownBlocksView(blocks: item.blocks, spacing: 5)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func table(
        header: [AttributedString],
        rows: [[AttributedString]]
    ) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
                GridRow {
                    ForEach(header.indices, id: \.self) { index in
                        tableCell(
                            header[index],
                            emphasized: true,
                            showsTrailingDivider: index < header.index(before: header.endIndex)
                        )
                    }
                }
                Divider()
                    .gridCellUnsizedAxes(.horizontal)
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    GridRow {
                        ForEach(row.indices, id: \.self) { index in
                            tableCell(
                                row[index],
                                emphasized: false,
                                showsTrailingDivider: index < row.index(before: row.endIndex)
                            )
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func tableCell(
        _ text: AttributedString,
        emphasized: Bool,
        showsTrailingDivider: Bool
    ) -> some View {
        Text(text)
            .font(emphasized ? .subheadline.weight(.semibold) : .subheadline)
            .lineLimit(nil)
            .multilineTextAlignment(.leading)
            .fixedSize(horizontal: false, vertical: true)
            .frame(
                minWidth: 120,
                idealWidth: 180,
                maxWidth: 260,
                alignment: .topLeading
            )
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .overlay(alignment: .trailing) {
                if showsTrailingDivider {
                    Rectangle()
                        .fill(Color(uiColor: .separator).opacity(0.28))
                        .frame(width: 0.5)
                }
            }
    }
}
