jest.mock("../../utils/security/keyCustody", () => ({
  resolveActiveKey: () => ({ material: Buffer.alloc(32, 7) }),
}));

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const {
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
    });
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
    try {
      const files = Object.fromEntries(
        ["nkey", "ca", "cert", "key"].map((name) => [
          name,
          path.join(directory, name),
        ])
      );
      fs.writeFileSync(files.nkey, "test-nkey-seed", { mode: 0o600 });
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          files.key,
          "-out",
          files.cert,
          "-days",
          "1",
          "-subj",
          "/CN=athena-api",
          "-addext",
          "subjectAltName=URI:spiffe://athena/production/api",
        ],
        { stdio: "ignore" }
      );
      fs.copyFileSync(files.cert, files.ca);
      for (const filePath of Object.values(files))
        fs.chmodSync(filePath, 0o600);
      const secureEnvironment = {
        NODE_ENV: "production",
        ATHENA_BROADCAST_TRANSPORT: "nats",
        ATHENA_NATS_SERVERS: "tls://nats.internal:4222",
        ATHENA_NATS_NKEY_SEED_FILE: files.nkey,
        ATHENA_NATS_TLS_CA_FILE: files.ca,
        ATHENA_NATS_TLS_CERT_FILE: files.cert,
        ATHENA_NATS_TLS_KEY_FILE: files.key,
      };
      expect(natsSecurityFindings(secureEnvironment)).toEqual([]);

      execFileSync(
        "openssl",
        ["genpkey", "-algorithm", "RSA", "-out", files.key],
        { stdio: "ignore" }
      );
      fs.chmodSync(files.key, 0o600);
      expect(natsSecurityFindings(secureEnvironment)).toContain(
        "NATS client certificate private key mismatch."
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
