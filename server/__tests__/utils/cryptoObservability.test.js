const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { registry } = require("../../utils/observability/metrics");
const {
  PURPOSES,
  preferredCryptoSuite,
  signWithCryptoSuite,
  verifyWithCryptoSuite,
} = require("../../utils/security/cryptoSuiteRegistry");
const {
  observeCertificateRemaining,
  observeDeviceEpochConflict,
  observeVerificationFailure,
  refreshRuntimeCapabilities,
  refreshTlsObservations,
} = require("../../utils/security/cryptoObservability");
const {
  recordTlsObservation,
} = require("../../utils/security/cryptoObservationStore");

describe("cryptographic observability", () => {
  const originalExpected = process.env.ATHENA_PQ_RUNTIME_EXPECTED_CAPABILITIES;

  afterAll(() => {
    if (originalExpected === undefined)
      delete process.env.ATHENA_PQ_RUNTIME_EXPECTED_CAPABILITIES;
    else process.env.ATHENA_PQ_RUNTIME_EXPECTED_CAPABILITIES = originalExpected;
  });

  test("records registered suite usage and verification latency without key identifiers", async () => {
    const suite = preferredCryptoSuite(PURPOSES.SECURITY_AUDIT_CHECKPOINT);
    const keys = crypto.generateKeyPairSync("ed25519");
    const payload = Buffer.from("crypto-observability-test");
    const signature = signWithCryptoSuite({
      suite,
      data: payload,
      privateKey: keys.privateKey,
    });

    expect(
      verifyWithCryptoSuite({
        suite,
        data: payload,
        publicKey: keys.publicKey,
        signature,
      })
    ).toBe(true);
    expect(
      verifyWithCryptoSuite({
        suite,
        data: Buffer.from("tampered"),
        publicKey: keys.publicKey,
        signature,
      })
    ).toBe(false);

    observeVerificationFailure("expired_key_id", "classical");
    const output = await registry.metrics();
    expect(output).toContain("athena_crypto_suite_operations_total");
    expect(output).toContain(
      "athena_crypto_signature_verification_duration_seconds_count"
    );
    expect(output).toContain('reason="expired_key_id"');
    expect(output).not.toContain("crypto-observability-test");
  });

  test("imports only bounded TLS outcomes from the sanitized observation file", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "athena-crypto-"));
    const file = path.join(directory, "observations.json");
    try {
      recordTlsObservation({
        file,
        channel: "edge",
        outcome: "hybrid",
        sample: {
          cohort: 1,
          clientClass: "ios26",
          reason: "none",
          negotiatedGroup: "X25519MLKEM768",
          certificateVerified: true,
          handshakeDurationMs: 42,
          ttfbMs: 120,
          cpuUtilization: 0.35,
        },
      });
      recordTlsObservation({
        file,
        channel: "edge",
        outcome: "downgrade_rejected",
      });
      refreshTlsObservations({ ATHENA_CRYPTO_OBSERVATION_FILE: file });
      const output = await registry.metrics();
      expect(output).toContain(
        'athena_crypto_tls_negotiations_total{channel="edge",outcome="hybrid"'
      );
      expect(output).toContain(
        'athena_crypto_tls_negotiations_total{channel="edge",outcome="downgrade_rejected"'
      );
      expect(output).toContain(
        'athena_crypto_tls_client_compatibility_total{client_class="ios26",outcome="hybrid",reason="none"'
      );
      expect(output).toContain(
        'athena_crypto_tls_edge_cpu_utilization_ratio{cohort="1"'
      );
      expect(output).toContain("} 0.35");
      expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(
        expect.objectContaining({
          version: 1,
          tls: {
            edge: expect.objectContaining({
              hybrid: 1,
              downgrade_rejected: 1,
            }),
          },
        })
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("exports certificate, epoch, and runtime drift without identity labels", async () => {
    const sensitiveKeyId = "device-secret-key-id-must-not-appear";
    observeCertificateRemaining({
      role: "api",
      slot: "selected",
      validTo: new Date(Date.now() + 86_400_000).toISOString(),
    });
    observeDeviceEpochConflict("stale");
    process.env.ATHENA_PQ_RUNTIME_EXPECTED_CAPABILITIES =
      "ml_kem_768,ml_dsa_65,encapsulation_api,classical_provider_baseline";
    refreshRuntimeCapabilities({ force: true });
    observeVerificationFailure("invalid_signature", "unknown");

    const output = await registry.metrics();
    expect(output).toContain("athena_crypto_certificate_remaining_seconds");
    expect(output).toContain('kind="stale"');
    expect(output).toContain("athena_crypto_runtime_pq_capability_drift");
    expect(output).not.toContain(sensitiveKeyId);
  });

  test("rejects unbounded labels and unknown runtime baseline names", () => {
    expect(
      observeCertificateRemaining({
        role: "tenant-controlled-role",
        slot: "selected",
        validTo: new Date(Date.now() + 60_000).toISOString(),
      })
    ).toBe(false);
    expect(observeDeviceEpochConflict("tenant-controlled-kind")).toBe(false);
    process.env.ATHENA_PQ_RUNTIME_EXPECTED_CAPABILITIES = "unknown-provider";
    expect(() => refreshRuntimeCapabilities({ force: true })).toThrow(
      "pq_runtime_expected_capability_invalid"
    );
  });
});
