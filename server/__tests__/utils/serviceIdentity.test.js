const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { loadServiceIdentity } = require("../../utils/security/serviceIdentity");

function command(args) {
  execFileSync("openssl", args, { stdio: "ignore" });
}

function issueIdentity(directory, name, serviceId, days = 2) {
  const caKey = path.join(directory, `${name}-ca.key`);
  const caCert = path.join(directory, `${name}-ca.pem`);
  const key = path.join(directory, `${name}.key`);
  const csr = path.join(directory, `${name}.csr`);
  const cert = path.join(directory, `${name}.pem`);
  const extension = path.join(directory, `${name}.ext`);
  command([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    caKey,
    "-out",
    caCert,
    "-days",
    "3",
    "-subj",
    `/CN=${name}-ca`,
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
  ]);
  command([
    "req",
    "-new",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-out",
    csr,
    "-subj",
    `/CN=${name}`,
  ]);
  fs.writeFileSync(
    extension,
    `subjectAltName=URI:${serviceId}\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=clientAuth,serverAuth\n`
  );
  command([
    "x509",
    "-req",
    "-in",
    csr,
    "-CA",
    caCert,
    "-CAkey",
    caKey,
    "-CAcreateserial",
    "-out",
    cert,
    "-days",
    String(days),
    "-extfile",
    extension,
  ]);
  fs.chmodSync(key, 0o600);
  fs.chmodSync(caKey, 0o600);
  return { caCert, caKey, cert, key };
}

describe("service workload identity", () => {
  let directory;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "athena-mtls-"));
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test("accepts only a CA-issued certificate bound to the expected SPIFFE ID", () => {
    const serviceId = "spiffe://athena/production/background-worker";
    const identity = issueIdentity(directory, "worker", serviceId);
    const loaded = loadServiceIdentity("background-worker", {
      required: true,
      env: {
        APP_ENV: "production",
        ATHENA_BACKGROUND_WORKER_MTLS_CA_FILE: identity.caCert,
        ATHENA_BACKGROUND_WORKER_MTLS_CERT_FILE: identity.cert,
        ATHENA_BACKGROUND_WORKER_MTLS_KEY_FILE: identity.key,
      },
    });

    expect(loaded).toMatchObject({
      serviceId,
      certificateSlot: "primary",
    });
  });

  test("rejects a valid-looking certificate from an untrusted CA", () => {
    const serviceId = "spiffe://athena/production/realtime-gateway";
    const identity = issueIdentity(directory, "gateway", serviceId);
    const attacker = issueIdentity(directory, "attacker", serviceId);

    expect(() =>
      loadServiceIdentity("realtime-gateway", {
        required: true,
        env: {
          APP_ENV: "production",
          ATHENA_REALTIME_GATEWAY_MTLS_CA_FILE: attacker.caCert,
          ATHENA_REALTIME_GATEWAY_MTLS_CERT_FILE: identity.cert,
          ATHENA_REALTIME_GATEWAY_MTLS_KEY_FILE: identity.key,
        },
      })
    ).toThrow("service_identity_ca_verification_failed");
  });

  test("fails closed on an incomplete next-certificate rotation pair", () => {
    const serviceId = "spiffe://athena/production/api";
    const identity = issueIdentity(directory, "api", serviceId);

    expect(() =>
      loadServiceIdentity("api", {
        required: true,
        env: {
          APP_ENV: "production",
          ATHENA_API_MTLS_CA_FILE: identity.caCert,
          ATHENA_API_MTLS_CERT_FILE: identity.cert,
          ATHENA_API_MTLS_KEY_FILE: identity.key,
          ATHENA_API_MTLS_NEXT_CERT_FILE: identity.cert,
        },
      })
    ).toThrow("service_identity_next_pair_incomplete");
  });

  test("switches to a prevalidated next certificate inside the rotation window", () => {
    const serviceId = "spiffe://athena/production/api";
    const primary = issueIdentity(directory, "api-primary", serviceId);
    const next = issueIdentity(directory, "api-next", serviceId);
    const caBundle = path.join(directory, "service-ca-bundle.pem");
    fs.writeFileSync(
      caBundle,
      `${fs.readFileSync(primary.caCert, "utf8")}\n${fs.readFileSync(next.caCert, "utf8")}`
    );

    expect(
      loadServiceIdentity("api", {
        required: true,
        env: {
          APP_ENV: "production",
          ATHENA_API_MTLS_CA_FILE: caBundle,
          ATHENA_API_MTLS_CERT_FILE: primary.cert,
          ATHENA_API_MTLS_KEY_FILE: primary.key,
          ATHENA_API_MTLS_NEXT_CERT_FILE: next.cert,
          ATHENA_API_MTLS_NEXT_KEY_FILE: next.key,
          ATHENA_MTLS_ROTATION_SWITCH_MS: String(3 * 24 * 60 * 60 * 1000),
        },
      })
    ).toMatchObject({ certificateSlot: "next" });
  });
});
