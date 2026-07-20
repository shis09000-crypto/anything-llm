jest.mock("../../utils/security/keyCustody", () => ({
  resolveActiveKey: () => ({ material: Buffer.alloc(32, 7) }),
}));

const {
  irreversibleScope,
  settings,
  subjectFor,
} = require("../../utils/broadcast/transports/natsJetStreamTransport");

describe("NATS JetStream transport metadata", () => {
  const previousAppEnv = process.env.APP_ENV;
  const previousNodeEnv = process.env.NODE_ENV;

  beforeAll(() => {
    process.env.APP_ENV = "development";
    process.env.NODE_ENV = "development";
  });

  afterAll(() => {
    if (previousAppEnv === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = previousAppEnv;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  });

  it("keeps user and workspace identifiers out of subjects", () => {
    const event = {
      namespace: "workspace",
      visibility: "workspace",
      scope: { userId: 123, workspaceId: 456, threadId: 789 },
    };
    const subject = subjectFor(event);
    expect(subject).toMatch(/^athena\.development\.workspace\.[a-f0-9]{32}$/);
    expect(subject).not.toContain("123");
    expect(subject).not.toContain("456");
    expect(subject).not.toContain("789");
    expect(irreversibleScope(event)).toHaveLength(32);
  });

  it("normalizes server lists and consumer identity", () => {
    expect(
      settings({
        ATHENA_NATS_SERVERS: "nats://a:4222, nats://b:4222",
        ATHENA_NATS_CONSUMER_NAME: "gateway/blue",
      })
    ).toMatchObject({
      servers: ["nats://a:4222", "nats://b:4222"],
      consumer: "gateway-blue",
    });
  });
});
