import XCTest
@testable import Athena

private actor SchedulerTestGate {
    private var opened = false
    private var continuations: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        guard !opened else {
            return
        }
        await withCheckedContinuation { continuation in
            continuations.append(continuation)
        }
    }

    func open() {
        opened = true
        let waiting = continuations
        continuations.removeAll()
        waiting.forEach { $0.resume() }
    }
}

private actor SchedulerTestRecorder {
    private(set) var values: [String] = []
    private(set) var count = 0
    private(set) var active = 0
    private(set) var maximumActive = 0

    func append(_ value: String) {
        values.append(value)
    }

    func increment() {
        count += 1
    }

    func begin() {
        active += 1
        maximumActive = max(maximumActive, active)
    }

    func end() {
        active -= 1
    }
}

final class TaskSchedulerTests: XCTestCase {
    func testPriorityAndIntentRankOrderPendingTasks() async throws {
        let scheduler = TaskScheduler(
            configuration: .init(
                foregroundLimit: 1,
                backgroundLimit: 1,
                prefetchLimit: 1,
                networkLimit: 1
            )
        )
        let gate = SchedulerTestGate()
        let recorder = SchedulerTestRecorder()

        let blocker = try await scheduler.schedule(
            AthenaTaskDescriptor(
                label: "blocker",
                priority: .p1,
                isProtected: true,
                isAbortable: false
            )
        ) { _ in
            await recorder.append("blocker")
            await gate.wait()
            return "blocker"
        }
        try await Task.sleep(for: .milliseconds(20))

        let background = try await scheduler.schedule(
            AthenaTaskDescriptor(label: "background", priority: .p2)
        ) { _ in
            await recorder.append("background")
            return "background"
        }
        let laterIntent = try await scheduler.schedule(
            AthenaTaskDescriptor(label: "later", priority: .p0, intentRank: 5)
        ) { _ in
            await recorder.append("later")
            return "later"
        }
        let currentIntent = try await scheduler.schedule(
            AthenaTaskDescriptor(label: "current", priority: .p0, intentRank: 1)
        ) { _ in
            await recorder.append("current")
            return "current"
        }

        await gate.open()
        _ = try await blocker.value
        _ = try await currentIntent.value
        _ = try await laterIntent.value
        _ = try await background.value

        let values = await recorder.values
        XCTAssertEqual(values, ["blocker", "current", "later", "background"])
    }

    func testDedupeReturnsExistingTypedHandle() async throws {
        let scheduler = TaskScheduler()
        let gate = SchedulerTestGate()
        let recorder = SchedulerTestRecorder()
        let descriptor = AthenaTaskDescriptor(
            label: "dedupe",
            priority: .p1,
            dedupeKey: "workspace:list:user-1"
        )

        let first = try await scheduler.schedule(descriptor) { _ in
            await recorder.increment()
            await gate.wait()
            return 42
        }
        let second = try await scheduler.schedule(descriptor) { _ in
            await recorder.increment()
            return 99
        }

        XCTAssertEqual(first.id, second.id)
        await gate.open()
        let firstValue = try await first.value
        let secondValue = try await second.value
        let invocationCount = await recorder.count
        XCTAssertEqual(firstValue, 42)
        XCTAssertEqual(secondValue, 42)
        XCTAssertEqual(invocationCount, 1)
    }

    func testScopeCancellationDropsPendingTask() async throws {
        let scheduler = TaskScheduler(
            configuration: .init(networkLimit: 1)
        )
        let gate = SchedulerTestGate()
        let blocker = try await scheduler.schedule(
            AthenaTaskDescriptor(
                label: "protected",
                priority: .p1,
                isProtected: true,
                isAbortable: false
            )
        ) { _ in
            await gate.wait()
            return true
        }
        let pending = try await scheduler.schedule(
            AthenaTaskDescriptor(
                label: "older-page",
                priority: .p3,
                scope: AthenaTaskScope(owner: "user-1", workspaceID: "alpha", threadID: "old")
            )
        ) { _ in true }

        let cancelled = await scheduler.cancelScope(
            AthenaTaskScope(owner: "user-1", threadID: "old")
        )
        XCTAssertEqual(cancelled, 1)
        do {
            _ = try await pending.value
            XCTFail("Expected cancellation")
        } catch {
            XCTAssertTrue(error is CancellationError || error is AthenaTaskSchedulerError)
        }

        await gate.open()
        _ = try await blocker.value
    }

    func testProtectedTaskIsNotPreemptedByP0() async throws {
        let scheduler = TaskScheduler(
            configuration: .init(foregroundLimit: 1, networkLimit: 1)
        )
        let gate = SchedulerTestGate()
        let protected = try await scheduler.schedule(
            AthenaTaskDescriptor(
                label: "session-validation",
                priority: .p1,
                isProtected: true,
                isAbortable: false
            )
        ) { _ in
            await gate.wait()
            return "validated"
        }
        try await Task.sleep(for: .milliseconds(20))
        let foreground = try await scheduler.schedule(
            AthenaTaskDescriptor(label: "thread-switch", priority: .p0)
        ) { _ in "loaded" }

        let snapshot = await scheduler.snapshot()
        XCTAssertEqual(snapshot.running.map(\.label), ["session-validation"])
        XCTAssertEqual(snapshot.pending.map(\.label), ["thread-switch"])

        await gate.open()
        let protectedValue = try await protected.value
        let foregroundValue = try await foreground.value
        XCTAssertEqual(protectedValue, "validated")
        XCTAssertEqual(foregroundValue, "loaded")
    }

    func testP0PreemptsAbortableLowerPriorityNetworkTask() async throws {
        let scheduler = TaskScheduler(
            configuration: .init(
                foregroundLimit: 1,
                backgroundLimit: 1,
                networkLimit: 1
            )
        )
        let lowPriority = try await scheduler.schedule(
            AthenaTaskDescriptor(label: "background", priority: .p2)
        ) { _ in
            try await Task.sleep(for: .seconds(5))
            return "background"
        }
        try await Task.sleep(for: .milliseconds(20))

        let foreground = try await scheduler.schedule(
            AthenaTaskDescriptor(label: "foreground", priority: .p0)
        ) { _ in "foreground" }

        let foregroundValue = try await foreground.value
        XCTAssertEqual(foregroundValue, "foreground")
        do {
            _ = try await lowPriority.value
            XCTFail("Expected the lower priority task to be preempted")
        } catch {
            XCTAssertTrue(error is CancellationError || error is AthenaTaskSchedulerError)
        }

        let snapshot = await scheduler.snapshot()
        XCTAssertTrue(snapshot.recent.contains {
            $0.label == "background" && $0.status == .aborted
        })
    }

    func testInteractiveMutationUsesReservedNetworkSlot() async throws {
        let scheduler = TaskScheduler(
            configuration: .init(
                foregroundLimit: 3,
                interactiveMutationLimit: 1,
                networkLimit: 4
            )
        )
        let standardGate = SchedulerTestGate()
        let interactiveGate = SchedulerTestGate()

        var standardHandles: [ScheduledTaskHandle<Int>] = []
        for index in 0..<3 {
            let handle = try await scheduler.schedule(
                AthenaTaskDescriptor(
                    label: "history-\(index)",
                    priority: .p0,
                    executionClass: .currentContent
                )
            ) { _ in
                await standardGate.wait()
                return index
            }
            standardHandles.append(handle)
        }
        try await Task.sleep(for: .milliseconds(20))

        let interactive = try await scheduler.schedule(
            AthenaTaskDescriptor(
                label: "thread:create",
                priority: .p0,
                executionClass: .interactiveMutation
            )
        ) { _ in
            await interactiveGate.wait()
            return "created"
        }
        try await Task.sleep(for: .milliseconds(20))

        let snapshot = await scheduler.snapshot()
        XCTAssertEqual(snapshot.running.count, 4)
        XCTAssertTrue(snapshot.running.contains {
            $0.label == "thread:create" && $0.executionClass == .interactiveMutation
        })

        await standardGate.open()
        await interactiveGate.open()
        for handle in standardHandles {
            _ = try await handle.value
        }
        let interactiveValue = try await interactive.value
        XCTAssertEqual(interactiveValue, "created")
    }

    func testInteractiveMutationPreemptsAbortableCurrentContentAtSameP0() async throws {
        let scheduler = TaskScheduler(
            configuration: .init(
                foregroundLimit: 1,
                interactiveMutationLimit: 0,
                networkLimit: 1
            )
        )
        let content = try await scheduler.schedule(
            AthenaTaskDescriptor(
                label: "history:current",
                priority: .p0,
                executionClass: .currentContent
            )
        ) { _ in
            try await Task.sleep(for: .seconds(5))
            return "history"
        }
        try await Task.sleep(for: .milliseconds(20))

        let create = try await scheduler.schedule(
            AthenaTaskDescriptor(
                label: "thread:create",
                priority: .p0,
                executionClass: .interactiveMutation
            )
        ) { _ in "created" }

        let createdValue = try await create.value
        XCTAssertEqual(createdValue, "created")
        do {
            _ = try await content.value
            XCTFail("Expected current content to be preempted")
        } catch {
            XCTAssertTrue(error is CancellationError || error is AthenaTaskSchedulerError)
        }
    }

    func testNetworkResourceBudgetLimitsConcurrentWork() async throws {
        let scheduler = TaskScheduler(
            configuration: .init(
                foregroundLimit: 3,
                interactiveMutationLimit: 0,
                networkLimit: 2
            )
        )
        let gate = SchedulerTestGate()
        let recorder = SchedulerTestRecorder()

        let operation: @Sendable (Int) async -> Int = { value in
            await recorder.begin()
            await gate.wait()
            await recorder.end()
            return value
        }

        let first = try await scheduler.schedule(
            AthenaTaskDescriptor(label: "first", priority: .p1)
        ) { _ in await operation(1) }
        let second = try await scheduler.schedule(
            AthenaTaskDescriptor(label: "second", priority: .p1)
        ) { _ in await operation(2) }
        let third = try await scheduler.schedule(
            AthenaTaskDescriptor(label: "third", priority: .p1)
        ) { _ in await operation(3) }

        try await Task.sleep(for: .milliseconds(30))
        let activeSnapshot = await scheduler.snapshot()
        let maximumActive = await recorder.maximumActive
        XCTAssertEqual(activeSnapshot.running.count, 2)
        XCTAssertEqual(activeSnapshot.pending.count, 1)
        XCTAssertEqual(maximumActive, 2)

        await gate.open()
        _ = try await first.value
        _ = try await second.value
        _ = try await third.value
    }

    func testSnapshotRedactsCredentialLikeText() async throws {
        let scheduler = TaskScheduler()
        let gate = SchedulerTestGate()
        let handle = try await scheduler.schedule(
            AthenaTaskDescriptor(
                label: "request?token=plain-secret Authorization=Bearer abc.def",
                priority: .p1
            )
        ) { _ in
            await gate.wait()
            return true
        }

        let data = try JSONEncoder().encode(await scheduler.snapshot())
        let snapshotText = String(decoding: data, as: UTF8.self)
        XCTAssertFalse(snapshotText.contains("plain-secret"))
        XCTAssertFalse(snapshotText.contains("abc.def"))
        XCTAssertTrue(snapshotText.contains("REDACTED"))

        await gate.open()
        _ = try await handle.value
    }

    func testIndependentPauseReasonsDoNotResumePriorityEarly() async {
        let scheduler = TaskScheduler()

        await scheduler.setPaused(.p3, paused: true, reason: "background")
        await scheduler.setPaused(.p3, paused: true, reason: "scroll")
        await scheduler.setPaused(.p3, paused: false, reason: "scroll")

        let stillPaused = await scheduler.snapshot()
        XCTAssertEqual(stillPaused.pausedPriorities, [.p3])

        await scheduler.setPaused(.p3, paused: false, reason: "background")
        let resumed = await scheduler.snapshot()
        XCTAssertTrue(resumed.pausedPriorities.isEmpty)
    }
}
