jest.mock("../../utils/security/keyCustody/remoteClient", () => ({
  wrapMaterial: jest.fn(async (value) => `wrapped:${value}`),
  unwrapMaterial: jest.fn(async (value) => String(value).slice(8)),
}));

const {
  CIPHERTEXT_V1,
  CIPHERTEXT_V2,
  CheckpointLru,
  EVENT_BATCH_V1,
  ResponsesRepository,
  protect,
  unprotect,
} = require("../../utils/responsesRuntime/repository");
const {
  DurableEventBatcher,
} = require("../../utils/responsesRuntime/eventBatcher");
const { ResponsesRuntime } = require("../../utils/responsesRuntime/runtime");
const {
  wrapMaterial,
} = require("../../utils/security/keyCustody/remoteClient");

describe("Responses Runtime durable persistence", () => {
  test("writes compressed v2 ciphertext and still reads v1", async () => {
    const large = { text: "repeatable-state-".repeat(2_000) };
    const protectedValue = await protect(large, "large-state");
    expect(JSON.parse(protectedValue)).toMatchObject({
      format: CIPHERTEXT_V2,
      encoding: "gzip",
    });
    await expect(unprotect(protectedValue, "large-state")).resolves.toEqual(
      large
    );

    const raw = Buffer.from(JSON.stringify({ legacy: true })).toString(
      "base64"
    );
    const legacy = JSON.stringify({
      format: CIPHERTEXT_V1,
      chunks: [`wrapped:${raw}`],
    });
    await expect(unprotect(legacy, "legacy-state")).resolves.toEqual({
      legacy: true,
    });
  });

  test("never exceeds four concurrent Key Custody calls", async () => {
    let active = 0;
    let peak = 0;
    wrapMaterial.mockImplementation(async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return `wrapped:${value}`;
    });
    const value = {
      text: Array.from({ length: 24_000 }, (_, index) =>
        index.toString(36).padStart(8, "0")
      ).join(":"),
    };
    await protect(value, "bounded-custody", {
      ATHENA_RESPONSES_KEY_CUSTODY_CONCURRENCY: "100",
    });
    expect(peak).toBeLessThanOrEqual(4);
    wrapMaterial.mockImplementation(async (input) => `wrapped:${input}`);
  });

  test("shares the four-call Key Custody limit across parallel envelopes", async () => {
    let active = 0;
    let peak = 0;
    wrapMaterial.mockImplementation(async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return `wrapped:${value}`;
    });
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        protect({ index, text: "small" }, `parallel-${index}`)
      )
    );
    expect(peak).toBeLessThanOrEqual(4);
    wrapMaterial.mockImplementation(async (input) => `wrapped:${input}`);
  });

  test("stores one batch row and expands exact monotonic events on resume", async () => {
    const rows = [];
    const client = {
      response_events: {
        upsert: jest.fn(async ({ create, update, where }) => {
          const existing = rows.find(
            (row) =>
              row.responseId === where.responseId_sequence.responseId &&
              row.sequence === where.responseId_sequence.sequence
          );
          if (existing) {
            Object.assign(existing, update);
            return existing;
          }
          rows.push(create);
          return create;
        }),
        findMany: jest.fn(async ({ where }) =>
          rows.filter((row) => row.sequence > where.sequence.gt)
        ),
      },
    };
    const repository = new ResponsesRepository({ client });
    const events = [2, 3, 4].map((sequence) => ({
      type: "response.output_text.delta",
      sequence_number: sequence,
      delta: String(sequence),
    }));
    await repository.appendEventBatch({ responseId: "ath_resp_1", events });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sequence: 4, eventType: EVENT_BATCH_V1 });
    const resumed = await repository.listEvents("ath_resp_1", 2);
    expect(resumed.map((event) => event.sequence)).toEqual([3, 4]);
    expect(resumed.map((event) => event.payload.delta)).toEqual(["3", "4"]);
  });

  test("forwards append work without waiting and flushes terminal state", async () => {
    let release;
    const blocked = new Promise((resolve) => (release = resolve));
    const persist = jest.fn(async () => blocked);
    const batcher = new DurableEventBatcher({
      responseId: "ath_resp_2",
      persist,
      env: { ATHENA_RESPONSES_EVENT_BATCH_MAX_EVENTS: "2" },
    });
    batcher.append({ type: "delta", sequence_number: 2, delta: "a" });
    batcher.append({ type: "delta", sequence_number: 3, delta: "b" });
    expect(persist).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(persist).toHaveBeenCalledTimes(1);
    const draining = batcher.drain();
    let drained = false;
    draining.then(() => (drained = true));
    await Promise.resolve();
    expect(drained).toBe(false);
    release();
    await draining;
  });

  test("turns background persistence failures into a terminal error", async () => {
    const batcher = new DurableEventBatcher({
      responseId: "ath_resp_3",
      persist: jest.fn().mockRejectedValue(new Error("custody down")),
      env: { ATHENA_RESPONSES_EVENT_BATCH_MAX_EVENTS: "1" },
    });
    batcher.append({ type: "delta", sequence_number: 2, delta: "a" });
    await expect(batcher.drain()).rejects.toMatchObject({
      code: "response_event_persist_failed",
    });
  });

  test("bounds and invalidates the checkpoint LRU", () => {
    const cache = new CheckpointLru({ maxEntries: 2, maxBytes: 10 });
    cache.set("one", 1, 4);
    cache.set("two", 2, 4);
    expect(cache.get("one")).toBe(1);
    cache.set("three", 3, 4);
    expect(cache.get("two")).toBeNull();
    cache.delete("one");
    expect(cache.get("one")).toBeNull();
    cache.clear();
    expect(cache.get("three")).toBeNull();
  });

  test("filters provider lifecycle duplicates and batches a 300-delta stream", async () => {
    const initialEvents = [];
    const batches = [];
    let checkpointState = null;
    const repository = {
      findResponseByIdempotencyKey: jest.fn().mockResolvedValue(null),
      ensureConversation: jest.fn().mockResolvedValue({
        id: "ath_conv_1",
        scopeKey: "thread:1:2",
        currentHeadResponseId: null,
      }),
      createResponse: jest.fn().mockResolvedValue({}),
      appendItem: jest.fn().mockResolvedValue({}),
      writeCheckpoint: jest.fn(async (_id, state) => {
        checkpointState = state;
      }),
      readCheckpoint: jest.fn(async () => ({ state: checkpointState })),
      appendEvent: jest.fn(async ({ sequence, eventType, payload }) => {
        initialEvents.push({ sequence, eventType, payload });
      }),
      appendEventBatch: jest.fn(async ({ events }) => batches.push(events)),
      listEvents: jest.fn(async () =>
        initialEvents.map((event) => ({ ...event, payload: event.payload }))
      ),
      updateResponse: jest.fn().mockResolvedValue({}),
      advanceConversationHead: jest.fn().mockResolvedValue(true),
      snapshot: jest.fn(() => ({ keyCustodyWrapCalls: 0 })),
    };
    const modelClient = {
      stream: jest.fn().mockResolvedValue({}),
      events: async function* () {
        yield { type: "response.created" };
        yield { type: "response.in_progress" };
        for (let index = 0; index < 300; index += 1)
          yield {
            type: "response.output_text.delta",
            delta: String(index % 10),
          };
        yield {
          type: "response.completed",
          response: { status: "completed", usage: {} },
        };
      },
    };
    const runtime = new ResponsesRuntime({ repository, modelClient });
    const events = [];
    for await (const event of runtime.stream({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      input: [{ role: "user", content: "count" }],
      store: true,
      athena: { workspaceId: 1, threadId: 2, userId: 3 },
    }))
      events.push(event);

    expect(
      events.filter((event) => event.type === "response.created")
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.type === "response.in_progress")
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.type === "response.output_text.delta")
    ).toHaveLength(300);
    expect(events.at(-1).type).toBe("response.completed");
    expect(batches.flat()).toHaveLength(300);
    expect(batches.length).toBeLessThanOrEqual(2);
    expect(repository.appendEvent).toHaveBeenCalledTimes(3);
  });

  test("emits the foreground terminal event before encrypted persistence", async () => {
    let releasePersistence;
    const persistenceGate = new Promise(
      (resolve) => (releasePersistence = resolve)
    );
    const persistedItems = [];
    const persistedCheckpoints = [];
    const repository = {
      findResponseByIdempotencyKey: jest.fn().mockResolvedValue(null),
      ensureConversation: jest.fn().mockResolvedValue({
        id: "ath_conv_deferred",
        scopeKey: "thread:1:2",
        currentHeadResponseId: null,
      }),
      createResponse: jest.fn().mockResolvedValue({}),
      appendItem: jest.fn(async (item) => {
        persistedItems.push(item);
        return persistenceGate;
      }),
      writeCheckpoint: jest.fn(async (_id, checkpoint) => {
        persistedCheckpoints.push(checkpoint);
        return persistenceGate;
      }),
      appendEvent: jest.fn(async () => persistenceGate),
      appendEventBatch: jest.fn(async () => persistenceGate),
      updateResponse: jest.fn().mockResolvedValue({}),
      advanceConversationHead: jest.fn().mockResolvedValue(true),
      snapshot: jest.fn(() => ({ keyCustodyWrapCalls: 0 })),
    };
    const modelClient = {
      stream: jest.fn().mockResolvedValue({}),
      events: async function* () {
        yield { type: "response.output_text.delta", delta: "hello" };
        yield {
          type: "response.completed",
          response: { status: "completed", usage: {} },
        };
      },
    };
    const runtime = new ResponsesRuntime({ repository, modelClient });
    const events = [];
    for await (const event of runtime.stream({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      input: [
        {
          type: "message",
          role: "user",
          content:
            "hello\n\n<current_datetime>\nCurrent date: 2026-08-10\n</current_datetime>",
        },
      ],
      store: true,
      persistence_mode: "foreground_deferred",
      athena: { workspaceId: 1, threadId: 2, userId: 3 },
    }))
      events.push(event);

    expect(events.at(-1)).toMatchObject({
      type: "response.completed",
      response: { athena: { persistenceStatus: "pending" } },
    });
    expect(repository.appendItem).not.toHaveBeenCalled();
    expect(repository.writeCheckpoint).not.toHaveBeenCalled();
    expect(repository.appendEventBatch).not.toHaveBeenCalled();

    await Promise.resolve();
    expect(repository.appendItem).toHaveBeenCalled();
    expect(modelClient.stream).toHaveBeenCalledWith(
      expect.objectContaining({
        input: [
          expect.objectContaining({
            content: expect.stringContaining("<current_datetime>"),
          }),
        ],
      })
    );
    expect(persistedItems[0].payload.content).toBe("hello");
    expect(persistedCheckpoints[0].input[0].content).toBe("hello");
    expect(runtime.snapshot().hotResponses).toBe(1);
    releasePersistence();
    await Promise.allSettled([...runtime.persistenceChains.values()]);
    expect(runtime.snapshot().hotResponses).toBe(0);
  });
});
