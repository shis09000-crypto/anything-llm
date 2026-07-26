const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const {
  collectorServerIdentity,
} = require("../../../collector/utils/serviceIdentity");

function openssl(args) {
  execFileSync("openssl", args, { stdio: "ignore" });
}

function issue(directory, name, serviceId) {
  const caKey = path.join(directory, `${name}-ca.key`);
  const caCert = path.join(directory, `${name}-ca.pem`);
  const key = path.join(directory, `${name}.key`);
  const csr = path.join(directory, `${name}.csr`);
  const cert = path.join(directory, `${name}.pem`);
  const extension = path.join(directory, `${name}.ext`);
  openssl([
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
  openssl([
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
  openssl([
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
    "2",
    "-extfile",
    extension,
  ]);
  fs.chmodSync(key, 0o600);
  fs.chmodSync(caKey, 0o600);
  return { caCert, cert, key };
}

describe("collector workload identity", () => {
  const originalEnv = { ...process.env };
  let directory;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "athena-collector-pki-"));
    process.env.APP_ENV = "production";
    process.env.ATHENA_SERVICE_MTLS_REQUIRED = "true";
  });

  afterEach(() => {
    for (const name of Object.keys(process.env)) {
      if (!(name in originalEnv)) delete process.env[name];
    }
    Object.assign(process.env, originalEnv);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test("accepts only CA-issued collector identities", () => {
    const identity = issue(
      directory,
      "collector",
      "spiffe://athena/production/collector"
    );
    process.env.COLLECTOR_MTLS_CA_FILE = identity.caCert;
    process.env.COLLECTOR_MTLS_CERT_FILE = identity.cert;
    process.env.COLLECTOR_MTLS_KEY_FILE = identity.key;

    expect(collectorServerIdentity()).toMatchObject({
      serviceId: "spiffe://athena/production/collector",
      certificateSlot: "primary",
    });
  });

  test("rejects a collector certificate issued by another CA", () => {
    const identity = issue(
      directory,
      "collector",
      "spiffe://athena/production/collector"
    );
    const attacker = issue(
      directory,
      "attacker",
      "spiffe://athena/production/collector"
    );
    process.env.COLLECTOR_MTLS_CA_FILE = attacker.caCert;
    process.env.COLLECTOR_MTLS_CERT_FILE = identity.cert;
    process.env.COLLECTOR_MTLS_KEY_FILE = identity.key;

    expect(() => collectorServerIdentity()).toThrow(
      "collector_mtls_ca_verification_failed"
    );
  });
});
