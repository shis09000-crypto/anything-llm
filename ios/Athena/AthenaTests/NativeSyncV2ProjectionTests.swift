import Testing
@testable import Athena

struct NativeSyncV2ProjectionTests {
    @Test
    func profileProjectionDecodesAuthoritativePayload() {
        let payload = SyncJSONValue.object([
            "id": .number(42),
            "username": .string("athena"),
            "displayName": .string("Athena User"),
            "email": .string("athena@example.com"),
            "phone": .null,
            "bio": .string("Research partner"),
            "pfpFilename": .string("avatar.png"),
        ])

        let projection = NativeSyncV2ProjectionDecoder.profile(payload)

        #expect(projection?.id == 42)
        #expect(projection?.username == "athena")
        #expect(projection?.displayName == "Athena User")
        #expect(projection?.email == "athena@example.com")
        #expect(projection?.phone == nil)
        #expect(projection?.bio == "Research partner")
        #expect(projection?.pfpFilename == "avatar.png")
    }

    @Test
    func workspaceIndexRejectsPartialRowsInsteadOfPublishingPartialState() {
        let payload = SyncJSONValue.array([
            .object([
                "id": .number(9),
                "slug": .string("research"),
                "name": .string("Research"),
                "chatModel": .string("deepseek-v4-flash"),
                "lastUpdatedAt": .string("2026-07-18T00:00:00.000Z"),
            ]),
            .object([
                "id": .number(10),
                "name": .string("Missing slug"),
            ]),
        ])

        #expect(NativeSyncV2ProjectionDecoder.workspaces(payload) == nil)
    }

    @Test
    func workspaceAndThreadIndexesPreserveStableServerIdentifiers() {
        let workspacePayload = SyncJSONValue.array([
            .object([
                "id": .number(9),
                "slug": .string("research"),
                "name": .string("Research"),
                "chatModel": .string("deepseek-v4-pro"),
                "lastUpdatedAt": .string("2026-07-18T00:00:00.000Z"),
            ]),
        ])
        let threadPayload = SyncJSONValue.array([
            .object([
                "id": .number(101),
                "workspace_id": .number(9),
                "slug": .string("weekly-review"),
                "title": .string("Weekly review"),
                "thread_type": .string("chat"),
                "chatModel": .string("deepseek-v4-flash"),
                "historyRevision": .number(7),
                "lastUpdatedAt": .string("2026-07-18T00:01:00.000Z"),
            ]),
        ])

        let workspaces = NativeSyncV2ProjectionDecoder.workspaces(workspacePayload)
        let threads = NativeSyncV2ProjectionDecoder.threads(
            threadPayload,
            workspaceID: "research"
        )

        #expect(workspaces?.first?.id == "research")
        #expect(workspaces?.first?.serverID == 9)
        #expect(workspaces?.first?.chatModel == .pro)
        #expect(threads?.first?.id == "weekly-review")
        #expect(threads?.first?.serverID == 101)
        #expect(threads?.first?.workspaceID == "research")
        #expect(threads?.first?.historyRevision == 7)
        #expect(threads?.first?.chatModel == .flash)
    }

    @Test
    func drawerPinsDecodeFromPreferenceEnvelope() {
        let payload = SyncJSONValue.object([
            "namespace": .string("ios.drawer.pins"),
            "scope": .string("global"),
            "schemaVersion": .string("1"),
            "value": .object([
                "pins": .array([
                    .object([
                        "kind": .string("workspace"),
                        "workspaceID": .string("research"),
                        "threadID": .null,
                        "pinnedAt": .string("2026-07-18T00:00:00.000Z"),
                    ]),
                    .object([
                        "kind": .string("thread"),
                        "workspaceID": .string("research"),
                        "threadID": .string("weekly-review"),
                        "pinnedAt": .string("2026-07-18T00:02:00.000Z"),
                    ]),
                ]),
            ]),
        ])

        let state = NativeSyncV2ProjectionDecoder.drawerPins(payload)

        #expect(state?.pins.count == 2)
        #expect(state?.pins.first?.kind == .workspace)
        #expect(state?.pins.last?.kind == .thread)
        #expect(state?.pins.last?.threadID == "weekly-review")
    }
}
