const {
  THREAD_HISTORY_FINGERPRINT_VERSION,
  threadHistoryFingerprint,
} = require("../../../utils/chats/threadHistoryFingerprint");

describe("thread history fingerprint", () => {
  const base = {
    threadId: 9,
    historyRevision: 4,
    latestChatId: 22,
    latestChatAt: "2026-07-11T00:00:00.000Z",
  };

  it("is deterministic and does not require chat text", () => {
    expect(THREAD_HISTORY_FINGERPRINT_VERSION).toBe(
      "athena-thread-history:v1"
    );
    expect(threadHistoryFingerprint(base)).toBe(
      threadHistoryFingerprint({ ...base })
    );
    expect(threadHistoryFingerprint(base)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("changes for revision, latest id, or latest update changes", () => {
    const fingerprint = threadHistoryFingerprint(base);
    expect(
      threadHistoryFingerprint({ ...base, historyRevision: 5 })
    ).not.toBe(fingerprint);
    expect(threadHistoryFingerprint({ ...base, latestChatId: 23 })).not.toBe(
      fingerprint
    );
    expect(
      threadHistoryFingerprint({
        ...base,
        latestChatAt: "2026-07-11T00:00:01.000Z",
      })
    ).not.toBe(fingerprint);
  });

  it("rejects missing thread identity", () => {
    expect(threadHistoryFingerprint({ historyRevision: 1 })).toBeNull();
  });
});
