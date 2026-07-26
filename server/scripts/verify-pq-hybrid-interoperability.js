#!/usr/bin/env node
const crypto = require("crypto");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  PURPOSES,
  SUITE_IDS,
  cryptoSuite,
} = require("../utils/security/cryptoSuiteRegistry");
const {
  signHybridEnvelope,
  verifyHybridEnvelope,
} = require("../utils/security/hybridSignature");
const {
  EVIDENCE_FORMAT,
  PROFILE_POLICIES,
  signReleaseEvidence,
  verifyReleaseEvidence,
} = require("../utils/security/releaseEvidence");
const {
  signAgentManifest,
  verifyAgentManifest,
} = require("../utils/security/agentManifestSignature");
const {
  mlDSA65PublicKey,
} = require("../utils/security/postQuantumKeyEncoding");

function publicRecord(suite, keyId, publicKey) {
  return {
    suiteId: suite.suiteId,
    keyId,
    publicKey: publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64"),
  };
}

function verifyAgentRegistrySignature(keys) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "athena-agent-mldsa65-")
  );
  try {
    const privateKeyFile = path.join(directory, "agent-private.pem");
    const publicKeyFile = path.join(directory, "agent-public.pem");
    fs.writeFileSync(
      privateKeyFile,
      keys.privateKey.export({ format: "pem", type: "pkcs8" }),
      { mode: 0o600 }
    );
    fs.writeFileSync(
      publicKeyFile,
      keys.publicKey.export({ format: "pem", type: "spki" }),
      { mode: 0o600 }
    );
    const env = {
      NODE_ENV: "production",
      ATHENA_AGENT_MLDSA65_KEY_ID: "agent-test",
      ATHENA_AGENT_MLDSA65_PRIVATE_KEY_FILE: privateKeyFile,
      ATHENA_AGENT_MLDSA65_PUBLIC_KEY_FILE: publicKeyFile,
    };
    const manifest = {
      version: 1,
      tools: ["weather"],
      networkDomains: ["weather.example"],
      isolation: "container",
    };
    const signature = signAgentManifest(manifest, { env });
    assert.equal(
      verifyAgentManifest(manifest, signature, { env }).valid,
      true,
      "agent manifest ML-DSA signature was rejected"
    );
    assert.equal(
      verifyAgentManifest({ ...manifest, tools: ["shell"] }, signature, { env })
        .valid,
      false,
      "tampered agent manifest was accepted"
    );
    return true;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function verifyEvidenceSignerCLI(ed, pq) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "athena-evidence-signer-")
  );
  try {
    const files = {};
    for (const [name, pair] of [
      ["ed", ed],
      ["pq", pq],
    ]) {
      files[`${name}Private`] = path.join(directory, `${name}-private.pem`);
      files[`${name}Public`] = path.join(directory, `${name}-public.pem`);
      fs.writeFileSync(
        files[`${name}Private`],
        pair.privateKey.export({ format: "pem", type: "pkcs8" }),
        { mode: 0o600 }
      );
      fs.writeFileSync(
        files[`${name}Public`],
        pair.publicKey.export({ format: "pem", type: "spki" }),
        { mode: 0o600 }
      );
    }
    const now = Date.now();
    const input = path.join(directory, "dr-unsigned.json");
    const output = path.join(directory, "dr-signed.json");
    fs.writeFileSync(
      input,
      JSON.stringify({
        profile: "disasterRecovery",
        environment: "production",
        issuedAt: new Date(now - 1_000).toISOString(),
        expiresAt: new Date(now + 86_400_000).toISOString(),
        controls: Object.fromEntries(
          PROFILE_POLICIES.disasterRecovery.requiredControls.map((control) => [
            control,
            { status: "verified" },
          ])
        ),
        metrics: { observedRpoMinutes: 5, observedRtoMinutes: 20 },
      })
    );
    const script = path.join(__dirname, "sign-enterprise-security-evidence.js");
    const args = [
      script,
      "--profile",
      "disasterRecovery",
      "--input",
      input,
      "--output",
      output,
      "--ed25519-key-id",
      "dr-ed-test",
      "--ed25519-private-key",
      files.edPrivate,
      "--ed25519-public-key",
      files.edPublic,
      "--mldsa65-key-id",
      "dr-pq-test",
      "--mldsa65-private-key",
      files.pqPrivate,
      "--mldsa65-public-key",
      files.pqPublic,
    ];
    assert.notEqual(
      spawnSync(process.execPath, args, { encoding: "utf8" }).status,
      0,
      "evidence signer accepted a write without --execute"
    );
    assert.equal(
      spawnSync(process.execPath, [...args, "--execute"], {
        encoding: "utf8",
      }).status,
      0,
      "evidence signer failed to create dual-signed evidence"
    );
    assert.notEqual(
      spawnSync(process.execPath, [...args, "--execute"], {
        encoding: "utf8",
      }).status,
      0,
      "evidence signer overwrote an existing artifact"
    );
    const signed = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.equal(signed.signatureEnvelope.policy.threshold, 2);
    assert.equal(signed.signatureEnvelope.signatures.length, 2);
    return true;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function run() {
  assert(Number(process.versions.node.split(".")[0]) >= 24, "node24_required");
  const edSuite = cryptoSuite(SUITE_IDS.RELEASE_EVIDENCE_ED25519_V1, {
    purpose: PURPOSES.RELEASE_EVIDENCE,
  });
  const pqSuite = cryptoSuite(SUITE_IDS.RELEASE_EVIDENCE_MLDSA65_V1, {
    purpose: PURPOSES.RELEASE_EVIDENCE,
  });
  const ed = crypto.generateKeyPairSync("ed25519");
  const pq = crypto.generateKeyPairSync("ml-dsa-65");
  const data = Buffer.from("athena-hybrid-interoperability-v1");
  const signers = [
    {
      suite: edSuite,
      keyId: "ed-test",
      ...ed,
      keyOrigin: "ci-ephemeral",
      hardwareProtection: "software-test",
    },
    {
      suite: pqSuite,
      keyId: "pq-test",
      ...pq,
      keyOrigin: "ci-ephemeral",
      hardwareProtection: "software-test",
    },
  ];
  const requiredPolicy = {
    threshold: 2,
    classicalRequired: true,
    pqRequired: true,
  };
  const envelope = signHybridEnvelope({
    data,
    policy: requiredPolicy,
    signers,
  });
  const trustedKeys = [
    publicRecord(edSuite, "ed-test", ed.publicKey),
    publicRecord(pqSuite, "pq-test", pq.publicKey),
  ];
  assert.equal(
    verifyHybridEnvelope({
      data,
      envelope,
      purpose: PURPOSES.RELEASE_EVIDENCE,
      trustedKeys,
      requirePolicy: requiredPolicy,
    }).valid,
    true,
    "valid hybrid envelope was rejected"
  );

  const downgraded = structuredClone(envelope);
  downgraded.policy = {
    threshold: 1,
    classicalRequired: true,
    pqRequired: false,
  };
  downgraded.signatures = downgraded.signatures.filter(
    (signature) => signature.family === "classical"
  );
  const downgradeResult = verifyHybridEnvelope({
    data,
    envelope: downgraded,
    purpose: PURPOSES.RELEASE_EVIDENCE,
    trustedKeys,
    requirePolicy: requiredPolicy,
  });
  assert.equal(downgradeResult.valid, false, "downgrade was accepted");
  assert(
    downgradeResult.findings.includes("hybrid_policy_downgrade_detected"),
    `downgrade marker missing:${downgradeResult.findings.join(",")}`
  );

  const corrupted = structuredClone(envelope);
  corrupted.signatures[1].signature = Buffer.alloc(3309, 7).toString("base64");
  assert.equal(
    verifyHybridEnvelope({
      data,
      envelope: corrupted,
      purpose: PURPOSES.RELEASE_EVIDENCE,
      trustedKeys,
      requirePolicy: requiredPolicy,
    }).valid,
    false,
    "corrupted ML-DSA signature was accepted"
  );

  const corruptedKey = structuredClone(envelope);
  corruptedKey.signatures[1].publicKey = "bm90LWEtZGVyLXNwa2k=";
  const corruptedKeyTrust = structuredClone(trustedKeys);
  corruptedKeyTrust[1].publicKey = corruptedKey.signatures[1].publicKey;
  assert.equal(
    verifyHybridEnvelope({
      data,
      envelope: corruptedKey,
      purpose: PURPOSES.RELEASE_EVIDENCE,
      trustedKeys: corruptedKeyTrust,
      requirePolicy: requiredPolicy,
    }).valid,
    false,
    "corrupted ML-DSA public key was accepted"
  );

  for (const profile of ["edge", "disasterRecovery"]) {
    const evidence = {
      format: EVIDENCE_FORMAT,
      profile,
      environment: "production",
      issuedAt: new Date(Date.now() - 1_000).toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      controls: Object.fromEntries(
        PROFILE_POLICIES[profile].requiredControls.map((control) => [
          control,
          { status: "verified" },
        ])
      ),
      ...(profile === "disasterRecovery"
        ? { metrics: { observedRpoMinutes: 5, observedRtoMinutes: 20 } }
        : {}),
    };
    const signedEvidence = signReleaseEvidence({ evidence, signers });
    const evidenceResult = verifyReleaseEvidence({
      evidence: signedEvidence,
      trustedKeys,
      profile,
      environment: "production",
    });
    assert.equal(
      evidenceResult.valid,
      true,
      `dual-signed ${profile} evidence was rejected:${evidenceResult.findings.join(",")}`
    );
  }

  const kem = crypto.generateKeyPairSync("ml-kem-768");
  const encapsulated = crypto.encapsulate(kem.publicKey);
  const recovered = crypto.decapsulate(kem.privateKey, encapsulated.ciphertext);
  assert(crypto.timingSafeEqual(encapsulated.sharedKey, recovered));

  const devicePQ = crypto.generateKeyPairSync("ml-dsa-65");
  const deviceSPKI = devicePQ.publicKey.export({ format: "der", type: "spki" });
  const rawDevicePublicKey = deviceSPKI.subarray(deviceSPKI.length - 1952);
  const importedDevicePublicKey = mlDSA65PublicKey(
    rawDevicePublicKey.toString("base64url")
  );
  const requestPayload = Buffer.from(
    "ATHENA-DEVICE-SIGN-V1\nPOST\n/vault/items"
  );
  const requestSignature = crypto.sign(
    null,
    requestPayload,
    devicePQ.privateKey
  );
  assert(
    crypto.verify(
      null,
      requestPayload,
      importedDevicePublicKey,
      requestSignature
    ),
    "iOS raw ML-DSA-65 public-key interoperability failed"
  );
  assert.equal(verifyAgentRegistrySignature(pq), true);
  assert.equal(verifyEvidenceSignerCLI(ed, pq), true);

  console.log(
    JSON.stringify(
      {
        success: true,
        node: process.version,
        openssl: process.versions.openssl,
        checks: {
          hybridComposition: true,
          downgradeRejected: true,
          corruptedSignatureRejected: true,
          corruptedPublicKeyRejected: true,
          releaseEvidenceDualSignature: true,
          disasterRecoveryEvidenceDualSignature: true,
          evidenceSignerCliFailClosed: true,
          agentRegistryMLDSA65: true,
          mlKEM768RoundTrip: true,
          iosRawMLDSA65Interoperability: true,
        },
      },
      null,
      2
    )
  );
}

try {
  run();
} catch (error) {
  console.error(
    JSON.stringify({ success: false, error: error.message }, null, 2)
  );
  process.exitCode = 1;
}
