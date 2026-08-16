const {
  FinalizedTurnPersister,
  HotTurnBuffer,
} = require("../../../utils/chats/hotTurnBuffer");

describe("HotTurnBuffer", () => {
  test("keeps pending turns ordered by thread scope and scrubs on delete", () => {
    const buffer = new HotTurnBuffer({ maxTurns: 2, maxBytes: 1024 });
    const first = buffer.stage({
      workspaceId: 1,
      threadId: 2,
      userId: 3,
      clientTurnId: "turn-1",
      prompt: "hello",
      response: "world",
    });
    buffer.stage({
      workspaceId: 1,
      threadId: 2,
      userId: 3,
      clientTurnId: "turn-2",
      prompt: "again",
      response: "answer",
    });

    expect(
      buffer
        .pendingForScope({ workspaceId: 1, threadId: 2, userId: 3 })
        .map((entry) => entry.clientTurnId)
    ).toEqual(["turn-1", "turn-2"]);
    expect(buffer.delete("turn-1")).toBe(true);
    expect(first.entry.prompt).toBe("");
    expect(first.entry.response).toBe("");
  });

  test("fails closed to the synchronous path at capacity", () => {
    const buffer = new HotTurnBuffer({ maxTurns: 1, maxBytes: 10 });
    expect(
      buffer.stage({
        workspaceId: 1,
        clientTurnId: "turn-1",
        prompt: "1234",
        response: "5678",
      }).accepted
    ).toBe(true);
    expect(
      buffer.stage({
        workspaceId: 1,
        clientTurnId: "turn-2",
        prompt: "a",
        response: "b",
      })
    ).toMatchObject({ accepted: false, reason: "capacity" });
  });

  test("serializes persistence within the same thread", async () => {
    const persister = new FinalizedTurnPersister();
    const order = [];
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const first = persister.enqueue("thread", async () => {
      order.push("first-start");
      await gate;
      order.push("first-end");
    });
    const second = persister.enqueue("thread", async () => {
      order.push("second");
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual(["first-start"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });
});
