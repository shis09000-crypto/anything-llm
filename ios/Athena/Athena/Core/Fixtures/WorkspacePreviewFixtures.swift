import Foundation

enum WorkspacePreviewFixtures {
    static let workspaces: [AthenaWorkspace] = [
        workspace(
            "red-capital",
            "红色资本",
            threads: [
                thread(
                    "red-capital-macro",
                    workspace: "red-capital",
                    title: "宏观与政策笔记",
                    messages: [
                        user("red-capital-macro-u1", "今天先把政策变化和市场情绪放在一起看。"),
                        assistant("red-capital-macro-a1", "我会先看流动性、产业政策和风险资产定价三个层次。"),
                    ]
                ),
                thread("red-capital-valuation", workspace: "red-capital", title: "估值框架"),
                thread("red-capital-followup", workspace: "red-capital", title: "会议后续行动计划"),
            ]
        ),
        workspace(
            "western-philosophy",
            "西方哲学史",
            threads: [
                thread("western-philosophy-plato", workspace: "western-philosophy", title: "柏拉图阅读"),
                thread("western-philosophy-kant", workspace: "western-philosophy", title: "康德专题"),
            ]
        ),
        workspace(
            "coupon-design",
            "五折券设计",
            threads: [
                thread("coupon-design-main", workspace: "coupon-design", title: "主线方案"),
                thread("coupon-design-branch", workspace: "coupon-design", title: "分支 · 五折券设计"),
            ]
        ),
        workspace(
            "market-brief",
            "市场与项目简报",
            threads: [
                thread("market-brief-world-cup", workspace: "market-brief", title: "2026 世界杯淘汰赛简报"),
                thread("market-brief-growth", workspace: "market-brief", title: "增长假设"),
            ]
        ),
        workspace(
            "jlpt-evening",
            "JLPT 晚间练习",
            threads: [
                thread("jlpt-evening-grammar", workspace: "jlpt-evening", title: "N2 语法复盘"),
                thread("jlpt-evening-listening", workspace: "jlpt-evening", title: "听力错题"),
            ]
        ),
    ]

    static let selectedThreadID = "red-capital-macro"

    #if DEBUG
    static let conversationSimulatorWorkspaces: [AthenaWorkspace] = [
        workspace(
            "conversation-layout-fixture",
            "会话布局验证",
            threads: [
                thread(
                    conversationSimulatorThreadID,
                    workspace: "conversation-layout-fixture",
                    title: "键盘与滚动稳定性",
                    messages: (1...60).flatMap { index in
                        [
                            user(
                                "layout-u-\(index)",
                                "第 \(index) 轮用户消息，用于验证快速滚动、历史阅读位置和键盘聚焦。"
                            ),
                            assistant(
                                "layout-a-\(index)",
                                "这是第 \(index) 轮模型回复。内容保持多行，便于观察上下边缘羽化以及滚动停止后是否发生二次定位。\n\n继续阅读时，当前消息锚点应保持稳定。"
                            ),
                        ]
                    }
                ),
            ]
        ),
    ]
    static let conversationSimulatorThreadID = "conversation-layout-keyboard"
    #endif

    private static func workspace(
        _ id: String,
        _ title: String,
        threads: [AthenaThread]
    ) -> AthenaWorkspace {
        AthenaWorkspace(id: id, title: title, threads: threads)
    }

    private static func thread(
        _ id: String,
        workspace: String,
        title: String,
        messages: [AthenaChatMessage] = []
    ) -> AthenaThread {
        AthenaThread(id: id, workspaceID: workspace, title: title, messages: messages)
    }

    private static func user(_ id: String, _ text: String) -> AthenaChatMessage {
        AthenaChatMessage(id: id, role: .user, text: text)
    }

    private static func assistant(_ id: String, _ text: String) -> AthenaChatMessage {
        AthenaChatMessage(id: id, role: .assistant, text: text)
    }
}
