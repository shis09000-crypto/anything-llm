#!/usr/bin/env node
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const nkeys = require("nkeys.js");

const outputIndex = process.argv.indexOf("--output-dir");
const hostOutputIndex = process.argv.indexOf("--host-output-dir");
const outputDir = path.resolve(
  outputIndex >= 0
    ? process.argv[outputIndex + 1]
    : process.env.ATHENA_PREPRODUCTION_SECRETS_DIR || ""
);
const hostOutputDir = path.resolve(
  hostOutputIndex >= 0 ? process.argv[hostOutputIndex + 1] : outputDir
);
const execute = process.argv.includes("--execute");
const environment = "preproduction";
const physicalRoles = Object.freeze([
  ["api", "anything-llm-api"],
  ["background-worker", "anything-llm-background-worker"],
  ["realtime-gateway", "anything-llm-realtime-gateway"],
  ["reader-worker", "anything-llm-reader-worker"],
  ["scheduler", "anything-llm-scheduler"],
  ["operations-plane", "anything-llm-operations-plane"],
  ["chat-runtime", "anything-llm-chat-runtime"],
  ["agent-runtime", "anything-llm-agent-runtime"],
  ["model-gateway", "anything-llm-model-gateway"],
  ["responses-runtime", "anything-llm-responses-runtime"],
  ["tool-broker", "anything-llm-tool-broker"],
  ["crypto-market", "anything-llm-crypto-market"],
  ["crypto-account", "anything-llm-crypto-account"],
  ["crypto-forecast", "anything-llm-crypto-forecast"],
  ["key-custody", "anything-llm-key-custody"],
  ["collector", "anything-llm-collector"],
  ["edge-web", "anything-llm-edge-probe"],
  ["identity", "anything-llm-identity"],
  ["knowledge-ingest", "anything-llm-knowledge-ingest"],
  ["rag", "anything-llm-rag"],
  ["operations-shadow-agents", "anything-llm-operations-shadow-agents"],
  ["prometheus", "anything-llm-prometheus"],
]);
const infrastructureCertificates = Object.freeze([["minio", "minio"]]);

function privateWrite(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, value, { mode: 0o600, flag: "wx" });
  fs.chmodSync(target, 0o600);
}

function publicWrite(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
  fs.writeFileSync(target, value, { mode: 0o644, flag: "wx" });
  fs.chmodSync(target, 0o644);
}

function command(args) {
  execFileSync("openssl", args, { stdio: "ignore" });
}

function provisionCA(privateDir, mtlsDir) {
  const key = path.join(privateDir, "service-ca.key");
  const cert = path.join(mtlsDir, "ca.pem");
  if (fs.existsSync(key) && fs.existsSync(cert)) return { key, cert };
  if (fs.existsSync(key) || fs.existsSync(cert))
    throw new Error("preproduction_service_ca_pair_incomplete");
  command([
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-nodes",
    "-keyout",
    key,
    "-out",
    cert,
    "-days",
    "90",
    "-subj",
    "/CN=Athena Preproduction Service CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
  ]);
  fs.chmodSync(key, 0o600);
  fs.chmodSync(cert, 0o644);
  return { key, cert };
}

function issueCertificate({ role, dnsNames, ca, privateDir, mtlsDir }) {
  const key = path.join(mtlsDir, `${role}.key`);
  const cert = path.join(mtlsDir, `${role}.pem`);
  if (fs.existsSync(key) && fs.existsSync(cert)) return { key, cert };
  if (fs.existsSync(key) || fs.existsSync(cert))
    throw new Error(`preproduction_certificate_pair_incomplete:${role}`);
  const csr = path.join(privateDir, `${role}.csr`);
  const extension = path.join(privateDir, `${role}.ext`);
  command([
    "req",
    "-new",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-nodes",
    "-keyout",
    key,
    "-out",
    csr,
    "-subj",
    `/CN=${role}`,
  ]);
  publicWrite(
    extension,
    [
      `subjectAltName=URI:spiffe://athena/${environment}/${role},${dnsNames
        .map((name) => `DNS:${name}`)
        .join(",")}`,
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature,keyEncipherment",
      "extendedKeyUsage=clientAuth,serverAuth",
      "",
    ].join("\n")
  );
  command([
    "x509",
    "-req",
    "-in",
    csr,
    "-CA",
    ca.cert,
    "-CAkey",
    ca.key,
    "-CAcreateserial",
    "-out",
    cert,
    "-days",
    "30",
    "-sha256",
    "-extfile",
    extension,
  ]);
  fs.chmodSync(key, 0o600);
  fs.chmodSync(cert, 0o644);
  return { key, cert };
}

function provisionNkeys(natsDir) {
  const users = [];
  for (const [role] of physicalRoles) {
    const seedFile = path.join(natsDir, `${role}.nk`);
    let publicKey;
    if (fs.existsSync(seedFile)) {
      const pair = nkeys.fromSeed(fs.readFileSync(seedFile));
      publicKey = pair.getPublicKey();
    } else {
      const pair = nkeys.createUser();
      privateWrite(seedFile, pair.getSeed());
      publicKey = pair.getPublicKey();
    }
    users.push({ role, publicKey });
  }
  return users;
}

function natsConfig({ users, natsCert, mtlsDir, natsDir }) {
  const target = path.join(natsDir, "nats-server.conf");
  if (fs.existsSync(target)) return target;
  const permission = [
    '"athena.preproduction.>"',
    '"$JS.API.>"',
    '"_INBOX.>"',
  ].join(", ");
  publicWrite(
    target,
    [
      'server_name: "athena-preproduction-nats"',
      "port: 4222",
      "http_port: 8222",
      "jetstream {",
      '  store_dir: "/data/jetstream"',
      "  max_memory_store: 512MB",
      "  max_file_store: 20GB",
      "}",
      "tls {",
      `  cert_file: "/run/secrets/athena-mtls/${path.basename(natsCert.cert)}"`,
      `  key_file: "/run/secrets/athena-mtls/${path.basename(natsCert.key)}"`,
      `  ca_file: "/run/secrets/athena-mtls/${path.basename(
        path.join(mtlsDir, "ca.pem")
      )}"`,
      "  verify: true",
      "  timeout: 2",
      "}",
      "authorization {",
      "  users = [",
      ...users.map(
        ({ role, publicKey }) =>
          `    { nkey: ${publicKey}, permissions: { publish: [${permission}], subscribe: [${permission}] } } # ${role}`
      ),
      "  ]",
      "}",
      "",
    ].join("\n")
  );
  return target;
}

function provisionCapabilityKeys(target) {
  const pairs = [
    ["ed25519", "ed25519"],
    ["mldsa65", "ml-dsa-65"],
  ];
  for (const [name, algorithm] of pairs) {
    const privateKeyFile = path.join(target, `${name}-private.pem`);
    const publicKeyFile = path.join(target, `${name}-public.pem`);
    if (fs.existsSync(privateKeyFile) && fs.existsSync(publicKeyFile)) continue;
    if (fs.existsSync(privateKeyFile) || fs.existsSync(publicKeyFile))
      throw new Error(`preproduction_capability_key_pair_incomplete:${name}`);
    const { privateKey, publicKey } = crypto.generateKeyPairSync(algorithm);
    privateWrite(
      privateKeyFile,
      privateKey.export({ format: "pem", type: "pkcs8" })
    );
    publicWrite(
      publicKeyFile,
      publicKey.export({ format: "pem", type: "spki" })
    );
  }
}

function randomSecret(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function provisionSecret(target, factory = () => randomSecret()) {
  if (!fs.existsSync(target)) privateWrite(target, `${factory()}\n`);
  return fs.readFileSync(target, "utf8").trim();
}

function writeRuntimeEnv(secretsDir, values, mutableKeys = []) {
  const target = path.join(secretsDir, "runtime.env");
  const existing = {};
  if (fs.existsSync(target)) {
    for (const line of fs.readFileSync(target, "utf8").split("\n")) {
      if (!line || line.startsWith("#") || !line.includes("=")) continue;
      const separator = line.indexOf("=");
      existing[line.slice(0, separator)] = line.slice(separator + 1);
    }
  }
  const merged = { ...values, ...existing };
  for (const key of mutableKeys) merged[key] = values[key];
  const serialized = `${Object.entries(merged)
    .map(([key, value]) => {
      if (String(value).includes("\n"))
        throw new Error(`preproduction_runtime_env_value_invalid:${key}`);
      return `${key}=${value}`;
    })
    .join("\n")}\n`;
  if (!fs.existsSync(target)) {
    privateWrite(target, serialized);
  } else {
    const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
    privateWrite(temporary, serialized);
    fs.renameSync(temporary, target);
    fs.chmodSync(target, 0o600);
  }
  return target;
}

function main() {
  if (!outputIndex && !process.env.ATHENA_PREPRODUCTION_SECRETS_DIR)
    throw new Error("--output-dir is required");
  const plan = {
    outputDir,
    environment,
    serviceRoles: physicalRoles.map(([role]) => role),
  };
  if (!execute) {
    console.log(JSON.stringify({ success: true, dryRun: true, plan }, null, 2));
    return;
  }
  if (Number(process.versions.node.split(".")[0]) < 24)
    throw new Error("node24_required_for_preproduction_provisioning");
  if (
    !process.env.ATHENA_PREPROD_PUBLIC_URL ||
    !process.env.ATHENA_PREPROD_PUBLIC_HOST
  )
    throw new Error("preproduction_public_origin_required");

  const privateDir = path.join(outputDir, "bootstrap-private");
  const mtlsDir = path.join(outputDir, "service-mtls");
  const natsDir = path.join(outputDir, "nats");
  const secretDir = path.join(outputDir, "runtime-secrets");
  const capabilityDir = path.join(outputDir, "plugin-capability");
  for (const directory of [
    outputDir,
    privateDir,
    mtlsDir,
    natsDir,
    secretDir,
    capabilityDir,
  ])
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

  const ca = provisionCA(privateDir, mtlsDir);
  for (const [role, dns] of physicalRoles)
    issueCertificate({
      role,
      dnsNames: [
        dns,
        role,
        ...(role === "api" ? ["anything-llm-api-tls"] : []),
      ],
      ca,
      privateDir,
      mtlsDir,
    });
  for (const [role, dns] of infrastructureCertificates)
    issueCertificate({
      role,
      dnsNames: [dns],
      ca,
      privateDir,
      mtlsDir,
    });
  const natsCert = issueCertificate({
    role: "nats",
    dnsNames: ["nats", "nats.internal", "anything-llm-nats"],
    ca,
    privateDir,
    mtlsDir,
  });
  const users = provisionNkeys(natsDir);
  natsConfig({ users, natsCert, mtlsDir, natsDir });
  provisionCapabilityKeys(capabilityDir);

  provisionSecret(path.join(secretDir, "password-pepper"));
  provisionSecret(path.join(secretDir, "master-key"), () =>
    crypto.randomBytes(32).toString("hex")
  );
  provisionSecret(path.join(secretDir, "nats-subject-key"), () =>
    crypto.randomBytes(32).toString("hex")
  );
  provisionSecret(path.join(secretDir, "metrics-token"));
  provisionSecret(path.join(secretDir, "clickhouse-password"));
  const runtimeEnv = writeRuntimeEnv(
    outputDir,
    {
      ATHENA_PREPROD_SECRETS_DIR: hostOutputDir,
      ATHENA_RUNTIME_ENV_FILE: "preproduction.empty.env",
      ATHENA_PASSWORD_PEPPER_HOST_FILE: path.join(
        hostOutputDir,
        "runtime-secrets",
        "password-pepper"
      ),
      ATHENA_MTLS_HOST_DIR: path.join(hostOutputDir, "service-mtls"),
      ATHENA_PLUGIN_CAPABILITY_HOST_DIR: path.join(
        hostOutputDir,
        "plugin-capability"
      ),
      ATHENA_KEY_LEASE_HOST_FILE: path.join(
        hostOutputDir,
        "runtime-secrets",
        "master-key"
      ),
      UID: String(process.getuid?.() ?? 1000),
      GID: String(process.getgid?.() ?? 1000),
      APP_ENV: "preproduction",
      ATHENA_PREPROD_PUBLIC_URL: process.env.ATHENA_PREPROD_PUBLIC_URL,
      ATHENA_PREPROD_PUBLIC_HOST: process.env.ATHENA_PREPROD_PUBLIC_HOST,
      ATHENA_PREPROD_POSTGRES_ADMIN_PASSWORD: randomSecret(),
      ATHENA_PREPROD_POSTGRES_MAIN_PASSWORD: randomSecret(),
      ATHENA_PREPROD_POSTGRES_AUTH_PASSWORD: randomSecret(),
      ATHENA_PREPROD_MINIO_ROOT_USER: `athena_${crypto
        .randomBytes(8)
        .toString("hex")}`,
      ATHENA_PREPROD_MINIO_ROOT_PASSWORD: randomSecret(),
      ATHENA_PREPROD_CLICKHOUSE_PASSWORD: fs
        .readFileSync(path.join(secretDir, "clickhouse-password"), "utf8")
        .trim(),
      ATHENA_PREPROD_GRAFANA_PASSWORD: randomSecret(),
      ATHENA_PREPROD_AUTH_TOKEN: randomSecret(),
      ATHENA_PREPROD_JWT_SECRET: randomSecret(48),
      ATHENA_PREPROD_SIG_KEY: randomSecret(48),
      ATHENA_PREPROD_SIG_SALT: randomSecret(32),
      ATHENA_PREPROD_S3_ACCESS_KEY: randomSecret(18),
      ATHENA_PREPROD_S3_SECRET_KEY: randomSecret(36),
      ATHENA_API_BIND_ADDRESS: "127.0.0.1",
      ATHENA_WEB_BIND_ADDRESS: "127.0.0.1",
    },
    ["ATHENA_PREPROD_PUBLIC_URL", "ATHENA_PREPROD_PUBLIC_HOST"]
  );
  console.log(
    JSON.stringify(
      {
        success: true,
        dryRun: false,
        environment,
        outputDir,
        runtimeEnv,
        serviceCertificateCount:
          physicalRoles.length + infrastructureCertificates.length + 1,
        natsWorkloadIdentityCount: users.length,
        fingerprintsOnly: physicalRoles.map(([role]) => ({
          role,
          certificate: new crypto.X509Certificate(
            fs.readFileSync(path.join(mtlsDir, `${role}.pem`), "utf8")
          ).fingerprint256,
        })),
      },
      null,
      2
    )
  );
}

try {
  main();
} catch (error) {
  console.error(
    JSON.stringify(
      { success: false, error: error.code || error.message },
      null,
      2
    )
  );
  process.exitCode = 1;
}
