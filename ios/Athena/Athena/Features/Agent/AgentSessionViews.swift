import SwiftUI

struct AgentInlineSessionView: View {
    let store: AgentSessionRenderStore
    let agentControlKit: AgentControlKit

    var body: some View {
        AgentSessionContentView(
            session: store.snapshot,
            agentControlKit: agentControlKit,
            showsInvocationID: false
        )
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct AgentSessionContentView: View {
    let session: AgentSessionSnapshot
    let agentControlKit: AgentControlKit
    var showsInvocationID = true

    private var pendingEvents: [AgentTimelineEvent] {
        session.events.filter { event in
            event.kind == .approval || event.kind == .clarification
        }
    }

    private var collapsibleEvents: [AgentTimelineEvent] {
        session.events.filter { event in
            event.kind != .approval && event.kind != .clarification
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: AthenaSpacing.md) {
            AgentSessionHeader(session: session, showsInvocationID: showsInvocationID)

            if !session.assistantText.isEmpty {
                AthenaMarkdownView(
                    session.assistantText,
                    cacheKey: "agent:\(session.invocationID)",
                    isStreaming: !session.phase.isTerminal
                )
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            ForEach(pendingEvents) { event in
                switch event.kind {
                case .approval:
                    AgentApprovalRequestView(
                        event: event,
                        invocationID: session.invocationID,
                        agentControlKit: agentControlKit
                    )
                case .clarification:
                    AgentClarificationRequestView(
                        event: event,
                        invocationID: session.invocationID,
                        agentControlKit: agentControlKit
                    )
                default:
                    EmptyView()
                }
            }

            if !collapsibleEvents.isEmpty {
                AgentTimelineDisclosure(events: collapsibleEvents)
            }

            AgentSessionActions(session: session, agentControlKit: agentControlKit)
        }
    }
}

private struct AgentSessionHeader: View {
    let session: AgentSessionSnapshot
    let showsInvocationID: Bool

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: AthenaSpacing.sm) {
            VStack(alignment: .leading, spacing: 3) {
                Text("Agent")
                    .font(.headline)
                if showsInvocationID {
                    Text(session.invocationID)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            Spacer(minLength: AthenaSpacing.sm)
            Label(session.phase.title, systemImage: session.phase.systemImage)
                .font(.caption.weight(.semibold))
                .foregroundStyle(session.phase.tint)
        }
    }
}

private struct AgentTimelineDisclosure: View {
    let events: [AgentTimelineEvent]
    @State private var expanded = false

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            LazyVStack(alignment: .leading, spacing: AthenaSpacing.md) {
                ForEach(events) { event in
                    AgentTimelineEventRow(event: event)
                }
            }
            .padding(.top, AthenaSpacing.sm)
        } label: {
            Label("思考与工具", systemImage: "brain.head.profile")
                .font(.subheadline.weight(.semibold))
        }
        .accessibilityHint("展开或折叠 Agent 的思考与工具过程")
    }
}

private struct AgentTimelineEventRow: View {
    let event: AgentTimelineEvent

    var body: some View {
        HStack(alignment: .top, spacing: AthenaSpacing.sm) {
            Image(systemName: event.kind.systemImage)
                .foregroundStyle(event.kind.tint)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 4) {
                Text(event.title)
                    .font(.subheadline.weight(.semibold))
                if !event.detail.isEmpty {
                    Text(event.detail)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct AgentApprovalRequestView: View {
    let event: AgentTimelineEvent
    let invocationID: String
    let agentControlKit: AgentControlKit

    @State private var submitting = false
    @State private var errorMessage: String?

    var body: some View {
        VStack(alignment: .leading, spacing: AthenaSpacing.sm) {
            Label(event.title, systemImage: "hand.raised")
                .font(.headline)
            if !event.detail.isEmpty {
                Text(event.detail)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            if let errorMessage {
                Text(errorMessage)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
            HStack(spacing: AthenaSpacing.sm) {
                Button("允许", systemImage: "checkmark") {
                    submit(approved: true)
                }
                .buttonStyle(.glassProminent)

                Button("拒绝", systemImage: "xmark", role: .destructive) {
                    submit(approved: false)
                }
                .buttonStyle(.glass)
            }
            .disabled(submitting || event.requestID == nil)
            if submitting {
                ProgressView("正在提交授权")
                    .controlSize(.small)
            }
        }
        .padding(AthenaSpacing.md)
        .athenaGlass(interactive: false)
    }

    private func submit(approved: Bool) {
        guard let requestID = event.requestID else {
            return
        }
        submitting = true
        errorMessage = nil
        Task {
            do {
                try await agentControlKit.respondToApproval(
                    invocationID: invocationID,
                    requestID: requestID,
                    approved: approved
                )
            } catch {
                errorMessage = error.localizedDescription
                submitting = false
            }
        }
    }
}

private struct AgentClarificationRequestView: View {
    let event: AgentTimelineEvent
    let invocationID: String
    let agentControlKit: AgentControlKit

    @State private var answers: [String: String] = [:]
    @State private var currentQuestionIndex = 0
    @State private var customAnswer = ""
    @State private var submitting = false
    @State private var errorMessage: String?

    var body: some View {
        VStack(alignment: .leading, spacing: AthenaSpacing.sm) {
            HStack(alignment: .firstTextBaseline) {
                Label(event.title, systemImage: "questionmark.bubble")
                    .font(.headline)
                Spacer()
                if event.questions.count > 1 {
                    Text("\(currentQuestionIndex + 1)/\(event.questions.count)")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }

            if let question = currentQuestion {
                Text(question.question)
                    .font(.subheadline.weight(.semibold))

                VStack(spacing: AthenaSpacing.sm) {
                    ForEach(Array(question.options.prefix(3).enumerated()), id: \.offset) { index, option in
                        ClarificationOptionButton(
                            title: option,
                            description: question.optionDescriptions[safe: index],
                            recommended: index == 0
                        ) {
                            choose(option, for: question)
                        }
                    }

                    if question.allowOther {
                        HStack(spacing: AthenaSpacing.sm) {
                            TextField("输入其他答案", text: $customAnswer, axis: .vertical)
                                .textFieldStyle(.roundedBorder)
                            Button("提交", systemImage: "arrow.up") {
                                chooseCustom(for: question)
                            }
                            .labelStyle(.iconOnly)
                            .buttonStyle(.glassProminent)
                            .disabled(customAnswer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            .accessibilityLabel("提交自定义答案")
                        }
                    }
                }
            }
            if let errorMessage {
                Text(errorMessage)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
            HStack(spacing: AthenaSpacing.sm) {
                Button("跳过", systemImage: "forward") {
                    submit(skipped: true)
                }
                .buttonStyle(.glass)
                .disabled(submitting || event.requestID == nil || event.allowSkip == false)

                if submitting {
                    ProgressView()
                        .controlSize(.small)
                }
            }

            if let interval = timeoutInterval {
                ProgressView(timerInterval: interval, countsDown: true)
                    .tint(.secondary)
                    .accessibilityLabel("回答剩余时间")
            }
        }
        .padding(AthenaSpacing.md)
        .athenaGlass(interactive: false)
    }

    private var currentQuestion: AgentClarificationQuestion? {
        guard event.questions.indices.contains(currentQuestionIndex) else { return nil }
        return event.questions[currentQuestionIndex]
    }

    private var timeoutInterval: ClosedRange<Date>? {
        guard let timeoutMs = event.timeoutMs, timeoutMs > 0 else { return nil }
        let start = event.requestedAtMs.map { Date(timeIntervalSince1970: $0 / 1_000) } ?? Date()
        return start...start.addingTimeInterval(Double(timeoutMs) / 1_000)
    }

    private func choose(_ answer: String, for question: AgentClarificationQuestion) {
        answers[question.id] = answer
        advanceOrSubmit()
    }

    private func chooseCustom(for question: AgentClarificationQuestion) {
        let answer = customAnswer.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !answer.isEmpty else { return }
        answers[question.id] = answer
        advanceOrSubmit()
    }

    private func advanceOrSubmit() {
        if currentQuestionIndex < event.questions.count - 1 {
            withAnimation(.smooth) {
                currentQuestionIndex += 1
                customAnswer = ""
            }
        } else {
            submit(skipped: false)
        }
    }

    private func submit(skipped: Bool) {
        guard let requestID = event.requestID else {
            return
        }
        submitting = true
        errorMessage = nil
        let payload = event.questions.map { question in
            AgentClarificationAnswer(
                questionId: question.id,
                answer: answers[question.id, default: ""].trimmingCharacters(in: .whitespacesAndNewlines)
            )
        }
        Task {
            do {
                try await agentControlKit.respondToClarification(
                    invocationID: invocationID,
                    requestID: requestID,
                    answers: payload,
                    skipped: skipped
                )
            } catch {
                errorMessage = error.localizedDescription
                submitting = false
            }
        }
    }
}

private struct ClarificationOptionButton: View {
    let title: String
    let description: String?
    let recommended: Bool
    let action: () -> Void

    var body: some View {
        Group {
            if recommended {
                button.buttonStyle(.glassProminent)
            } else {
                button.buttonStyle(.glass)
            }
        }
    }

    private var button: some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: AthenaSpacing.sm) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .foregroundStyle(.primary)
                    if let description, !description.isEmpty {
                        Text(description)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: AthenaSpacing.sm)
                if recommended {
                    Label("推荐", systemImage: "sparkles")
                        .font(.caption)
                        .labelStyle(.titleAndIcon)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

private extension Collection {
    subscript(safe index: Index) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}

private struct AgentSessionActions: View {
    let session: AgentSessionSnapshot
    let agentControlKit: AgentControlKit

    var body: some View {
        if session.phase == .failed || session.phase == .closed {
            Button("重新连接", systemImage: "arrow.clockwise") {
                Task {
                    await agentControlKit.resume(invocationID: session.invocationID)
                }
            }
            .buttonStyle(.glass)
        } else if !session.phase.isTerminal {
            Button("停止", systemImage: "stop", role: .destructive) {
                Task {
                    await agentControlKit.stop(invocationID: session.invocationID)
                }
            }
            .buttonStyle(.glass)
        }
    }
}

extension AgentSessionPhase {
    var title: String {
        switch self {
        case .idle: "待开始"
        case .connecting: "连接中"
        case .open: "运行中"
        case .reconnecting: "恢复中"
        case .waitingOnInput: "等待操作"
        case .stopping: "停止中"
        case .finalized: "已完成"
        case .closed: "已关闭"
        case .failed: "连接失败"
        }
    }

    var systemImage: String {
        switch self {
        case .idle: "pause"
        case .connecting, .reconnecting: "arrow.trianglehead.2.clockwise.rotate.90"
        case .open: "sparkles"
        case .waitingOnInput: "hand.raised"
        case .stopping: "stop"
        case .finalized: "checkmark.circle"
        case .closed: "xmark.circle"
        case .failed: "exclamationmark.triangle"
        }
    }

    var tint: Color {
        switch self {
        case .open: .green
        case .waitingOnInput: .orange
        case .failed: .red
        case .finalized: .blue
        default: .secondary
        }
    }
}

private extension AgentTimelineEvent.Kind {
    var systemImage: String {
        switch self {
        case .thought: "brain.head.profile"
        case .toolCall: "wrench.and.screwdriver"
        case .toolResult: "checkmark.square"
        case .approval: "hand.raised"
        case .clarification: "questionmark.bubble"
        case .status: "waveform.path.ecg"
        case .error: "exclamationmark.triangle"
        }
    }

    var tint: Color {
        switch self {
        case .toolCall, .toolResult: .blue
        case .error: .red
        case .approval, .clarification: .orange
        default: .secondary
        }
    }
}
