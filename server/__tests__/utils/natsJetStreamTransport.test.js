jest.mock("../../utils/security/keyCustody", () => ({
  resolveActiveKey: () => ({ material: Buffer.alloc(32, 7) }),
}));

const fs = require("fs");
const os = require("os");
const path = require("path");
const { createUser } = require("nkeys.js");

const {
  connectionSecurityOptions,
  deliverySubject,
  irreversibleScope,
  natsSecurityFindings,
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
      maxBytes: 512 * 1024 * 1024,
    });
  });

  it("assigns a stable delivery subject to push consumers", () => {
    expect(deliverySubject("gateway/blue")).toBe(
      "_INBOX.ATHENA.BROADCAST.gateway-blue"
    );
  });

  it("fails closed on production plaintext or shared credentials", () => {
    const findings = natsSecurityFindings({
      NODE_ENV: "production",
      ATHENA_BROADCAST_TRANSPORT: "nats",
      ATHENA_NATS_SERVERS: "nats://nats.internal:4222",
      ATHENA_NATS_USER: "shared-user",
      ATHENA_NATS_PASSWORD: "shared-password",
    });
    expect(findings).toEqual(
      expect.arrayContaining([
        "Production NATS servers must use tls:// endpoints.",
        "Production NATS requires exactly one credentials or NKey workload identity file.",
        "Production NATS forbids shared token and username/password authentication.",
        "Production NATS requires CA, client certificate, and client key files for mTLS.",
      ])
    );
  });

  it("accepts a production mTLS and NKey workload identity contract", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "athena-nats-"));
    const files = Object.fromEntries(
      ["nkey", "ca", "cert", "key"].map((name) => {
        const filePath = path.join(directory, name);
        fs.writeFileSync(filePath, name, { mode: 0o600 });
        return [name, filePath];
      })
    );
    expect(
      natsSecurityFindings({
        NODE_ENV: "production",
        ATHENA_BROADCAST_TRANSPORT: "nats",
        ATHENA_NATS_SERVERS: "tls://nats.internal:4222",
        ATHENA_NATS_NKEY_SEED_FILE: files.nkey,
        ATHENA_NATS_TLS_CA_FILE: files.ca,
        ATHENA_NATS_TLS_CERT_FILE: files.cert,
        ATHENA_NATS_TLS_KEY_FILE: files.key,
      })
    ).toEqual([]);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("authenticates with a provisioned NKey seed that ends in a newline", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "athena-nkey-"));
    const seedPath = path.join(directory, "nkey");
    const keyPair = createUser();
    fs.writeFileSync(
      seedPath,
      Buffer.concat([Buffer.from(keyPair.getSeed()), Buffer.from("\n")]),
      { mode: 0o600 }
    );

    const { authenticator } = connectionSecurityOptions({
      nkeySeedFile: seedPath,
      tls: {},
    });
    expect(authenticator("production-nonce")).toMatchObject({
      nkey: keyPair.getPublicKey(),
    });

    keyPair.clear();
    fs.rmSync(directory, { recursive: true, force: true });
  });
});
