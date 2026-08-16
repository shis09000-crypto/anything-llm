const {
  ThreeDSessionMemoryRepository,
} = require("../../utils/chats/threeDSessionMemory/repository");

describe("Athena 3D durable context cursor", () => {
  const repository = new ThreeDSessionMemoryRepository({
    client: {},
    env: { NODE_ENV: "test", ATHENA_3D_CONTEXT_CACHE_TTL_MS: "900000" },
  });
  const session = {
    contextCursorId: "chr_ctx_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    memoryRevision: 4,
    stateRevision: 4,
    checkpointRevision: 2,
    lastCommittedTurnOrdinal: 5,
  };

  test("projects all authoritative revisions into a plain JSON reference", () => {
    expect(repository.contextRef(session, 1_000)).toEqual({
      cursor_id: session.contextCursorId,
      memory_revision: 4,
      state_revision: 4,
      checkpoint_revision: 2,
      last_turn_ordinal: 5,
      expires_at: 901_000,
    });
  });

  test.each([
    [null, "cursor_missing"],
    [{}, "cursor_expired"],
    [
      {
        ...repository.contextRef(session, 1_000),
        checkpoint_revision: 1,
      },
      "checkpoint_advanced",
    ],
    [
      {
        ...repository.contextRef(session, 1_000),
        memory_revision: 3,
      },
      "cursor_stale",
    ],
  ])(
    "classifies rebuild reason without returning a conflict",
    (ref, reason) => {
      const current = repository.contextRef(session, 1_000);
      expect(repository.contextRebuildReason(ref, current, 1_001)).toBe(reason);
    }
  );
});
