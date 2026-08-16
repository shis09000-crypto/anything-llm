const crypto = require("crypto");
const authPrisma = require("../authPrisma");
const {
  getClientContext,
  getClientRecord,
  recoverClientDeviceIdentity,
  registerClient,
} = require("../clientIdentity");
const {
  canonicalPublicKey,
  verifyDeviceSignature,
} = require("../requestSigning");
const {
  PURPOSES,
  SUITE_IDS,
  cryptoSuite,
  verifyWithCryptoSuite,
} = require("../security/cryptoSuiteRegistry");
const { mlDSA65PublicKey } = require("../security/postQuantumKeyEncoding");
const { emitSemanticEvent } = require("../observability/semanticEvents");

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const RECOVERY_TTL_MS = 10 * 60 * 1000;

function hash(value) {
  return crypto
    .createHash("sha256")
    .update(String(value || ""))
    .digest("hex");
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function canonicalProof({ challengeId, challenge, clientId }) {
  return [
    "athena-device-binding-preflight:v1",
    String(challengeId || ""),
    String(challenge || ""),
    String(clientId || ""),
  ].join("\n");
}

async function cleanupExpired() {
  await authPrisma.auth_device_recovery_challenges.deleteMany({
    where: {
      expiresAt: { lt: new Date(Date.now() - 60_000) },
    },
  });
}

async function issueDeviceBindingChallenge(request) {
  const context = getClientContext(request);
  if (context.legacy || !context.clientId) {
    const error = new Error("client_identity_required");
    error.code = "client_identity_required";
    error.httpStatus = 400;
    throw error;
  }
  await cleanupExpired();
  const challenge = randomToken(32);
  const challengeId = `dbr_${crypto.randomUUID()}`;
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
  await authPrisma.auth_device_recovery_challenges.create({
    data: {
      id: challengeId,
      challengeHash: hash(challenge),
      clientId: context.clientId,
      status: "issued",
      expiresAt,
    },
  });
  return {
    challengeId,
    challenge,
    expiresAt: expiresAt.toISOString(),
    proofVersion: "athena-device-binding-preflight:v1",
  };
}

function verifyPostQuantumProof({ publicKey, signature, proof }) {
  const suite = cryptoSuite(SUITE_IDS.REQUEST_DEVICE_MLDSA65_V1, {
    purpose: PURPOSES.REQUEST_SIGNATURE,
  });
  if (!suite || !publicKey || !signature) return false;
  try {
    return verifyWithCryptoSuite({
      suite,
      data: Buffer.from(proof),
      publicKey: mlDSA65PublicKey(publicKey),
      signature,
    });
  } catch {
    return false;
  }
}

async function verifiedAssertion(assertion, expectedClientId) {
  const challengeId = String(assertion?.challengeId || "").slice(0, 160);
  const challenge = String(assertion?.challenge || "").slice(0, 256);
  const record = challengeId
    ? await authPrisma.auth_device_recovery_challenges.findUnique({
        where: { id: challengeId },
      })
    : null;
  if (
    !record ||
    record.clientId !== expectedClientId ||
    record.expiresAt.getTime() <= Date.now() ||
    !["issued", "recovery_required"].includes(record.status) ||
    !crypto.timingSafeEqual(
      Buffer.from(record.challengeHash),
      Buffer.from(hash(challenge))
    )
  ) {
    return { ok: false, reasonCode: "device_binding_challenge_invalid" };
  }

  const p256PublicKey = canonicalPublicKey(assertion?.p256?.publicKey);
  const pqPublicKey = String(assertion?.postQuantum?.publicKey || "");
  const proof = canonicalProof({
    challengeId,
    challenge,
    clientId: record.clientId,
  });
  const p256Verified = verifyDeviceSignature({
    publicKey: p256PublicKey,
    signingString: proof,
    signature: assertion?.p256?.signature,
  });
  const pqVerified = verifyPostQuantumProof({
    publicKey: pqPublicKey,
    signature: assertion?.postQuantum?.signature,
    proof,
  });
  if (!p256Verified || !pqVerified) {
    await authPrisma.auth_device_recovery_challenges.updateMany({
      where: { id: record.id, consumedAt: null },
      data: { failureCount: { increment: 1 }, status: "failed" },
    });
    return {
      ok: false,
      reasonCode: p256Verified
        ? "post_quantum_key_proof_invalid"
        : "device_key_proof_invalid",
    };
  }
  return {
    ok: true,
    record,
    p256PublicKey,
    p256KeyAlgorithm:
      String(assertion?.p256?.keyAlgorithm || "").slice(0, 96) ||
      SUITE_IDS.DEVICE_P256_WEBCRYPTO_V1,
    pqPublicKey,
  };
}

async function bindFirstDevice({ user, context, proof }) {
  await registerClient({
    userId: user.id,
    clientId: context.clientId,
    platform: context.platform,
    appVersion: context.appVersion,
    trustLevel: "medium",
    capabilities: context.capabilities,
    capabilitySource: context.capabilitySource,
    publicKey: proof.p256PublicKey,
    deviceFingerprintVersion: proof.p256KeyAlgorithm,
  });
  await authPrisma.athena_clients.updateMany({
    where: {
      userId: Number(user.id),
      clientId: context.clientId,
      revokedAt: null,
    },
    data: {
      pqPublicKey: proof.pqPublicKey,
      pqKeyAlgorithm: SUITE_IDS.REQUEST_DEVICE_MLDSA65_V1,
      pqPublicKeyParameterSet: "ML-DSA-65",
      pqPublicKeyOrigin: "client-preflight",
      pqPublicKeyHardwareProtection: "client-declared",
      attestationStatus: "unverified",
    },
  });
}

async function evaluateDeviceBindingForLogin({
  request,
  user,
  authUser,
  assertion,
}) {
  const context = getClientContext(request, { user });
  if (context.legacy || !assertion) {
    return { ok: false, reasonCode: "device_binding_preflight_required" };
  }
  const proof = await verifiedAssertion(assertion, context.clientId);
  if (!proof.ok) return proof;
  const client = await getClientRecord({
    userId: user.id,
    clientId: context.clientId,
    includeRevoked: true,
  });
  if (client?.revokedAt) return { ok: false, reasonCode: "client_revoked" };
  if (!client || (!client.publicKey && !client.pqPublicKey)) {
    await bindFirstDevice({ user, context, proof });
    await authPrisma.auth_device_recovery_challenges.update({
      where: { id: proof.record.id },
      data: {
        authUserId: Number(authUser.id),
        shadowUserId: Number(user.id),
        status: "completed",
        consumedAt: new Date(),
      },
    });
    return { ok: true, status: "matched_or_enrolled" };
  }
  const matches =
    client.publicKey === proof.p256PublicKey &&
    client.pqPublicKey === proof.pqPublicKey;
  if (matches) {
    await authPrisma.auth_device_recovery_challenges.update({
      where: { id: proof.record.id },
      data: {
        authUserId: Number(authUser.id),
        shadowUserId: Number(user.id),
        status: "completed",
        consumedAt: new Date(),
      },
    });
    return { ok: true, status: "matched" };
  }
  const recoveryTicket = randomToken(32);
  const expiresAt = new Date(Date.now() + RECOVERY_TTL_MS);
  await authPrisma.auth_device_recovery_challenges.update({
    where: { id: proof.record.id },
    data: {
      authUserId: Number(authUser.id),
      shadowUserId: Number(user.id),
      recoveryTicketHash: hash(recoveryTicket),
      status: "recovery_required",
      expiresAt,
    },
  });
  emitSemanticEvent({
    eventType: "auth.device_binding.recovery_started",
    category: "auth",
    severity: "warning",
    outcome: "recovery_required",
    subject: {
      type: "component",
      component: "identity",
      operation: "device-binding-recovery",
    },
    correlation: { clientId: context.clientId },
    metadata: { method: "passkey" },
    sensitivity: "metadata_only",
  });
  return {
    ok: false,
    recoveryRequired: true,
    recoveryTicket,
    expiresAt: expiresAt.toISOString(),
    reasonCode: "device_key_mismatch",
  };
}

async function completeDeviceBindingRecovery({
  request,
  user,
  authUserId,
  recoveryTicket,
  assertion,
  method,
}) {
  const context = getClientContext(request, { user });
  const ticketHash = hash(recoveryTicket);
  const record = await authPrisma.auth_device_recovery_challenges.findUnique({
    where: { recoveryTicketHash: ticketHash },
  });
  if (
    !record ||
    record.status !== "recovery_required" ||
    record.clientId !== context.clientId ||
    Number(record.authUserId) !== Number(authUserId) ||
    Number(record.shadowUserId) !== Number(user.id) ||
    record.expiresAt.getTime() <= Date.now()
  ) {
    const error = new Error("device_recovery_ticket_invalid");
    error.code = "device_recovery_ticket_invalid";
    error.httpStatus = 401;
    throw error;
  }
  const proof = await verifiedAssertion(assertion, context.clientId);
  if (!proof.ok) {
    const error = new Error(proof.reasonCode);
    error.code = proof.reasonCode;
    error.httpStatus = 401;
    throw error;
  }
  if (proof.record.id === record.id || proof.record.status !== "issued") {
    const error = new Error("fresh_device_binding_proof_required");
    error.code = "fresh_device_binding_proof_required";
    error.httpStatus = 409;
    throw error;
  }

  const now = new Date();
  await authPrisma.$transaction(async (tx) => {
    const claimed = await tx.auth_device_recovery_challenges.updateMany({
      where: {
        id: record.id,
        status: "recovery_required",
        consumedAt: null,
        expiresAt: { gt: now },
      },
      data: { status: "recovery_applying" },
    });
    if (claimed.count !== 1) throw new Error("device_recovery_replayed");
    const proofClaimed = await tx.auth_device_recovery_challenges.updateMany({
      where: {
        id: proof.record.id,
        status: "issued",
        consumedAt: null,
        expiresAt: { gt: now },
      },
      data: { status: "recovery_proof_applying" },
    });
    if (proofClaimed.count !== 1) {
      throw new Error("device_binding_challenge_replayed");
    }
  });

  try {
    const rebound = await recoverClientDeviceIdentity({
      userId: user.id,
      clientId: context.clientId,
      p256PublicKey: proof.p256PublicKey,
      p256KeyAlgorithm: proof.p256KeyAlgorithm,
      pqPublicKey: proof.pqPublicKey,
    });
    if (!rebound) {
      const error = new Error("device_recovery_client_missing");
      error.code = "device_recovery_client_missing";
      throw error;
    }
  } catch (error) {
    await authPrisma.$transaction(async (tx) => {
      await tx.auth_device_recovery_challenges.updateMany({
        where: { id: record.id, status: "recovery_applying" },
        data: { status: "recovery_required" },
      });
      await tx.auth_device_recovery_challenges.updateMany({
        where: { id: proof.record.id, status: "recovery_proof_applying" },
        data: { status: "issued" },
      });
    });
    throw error;
  }

  await authPrisma.$transaction(async (tx) => {
    const completed = await tx.auth_device_recovery_challenges.updateMany({
      where: {
        id: record.id,
        status: "recovery_applying",
        consumedAt: null,
      },
      data: { status: "completed", consumedAt: now },
    });
    if (completed.count !== 1) throw new Error("device_recovery_replayed");
    const proofCompleted = await tx.auth_device_recovery_challenges.updateMany({
      where: {
        id: proof.record.id,
        status: "recovery_proof_applying",
        consumedAt: null,
      },
      data: { status: "completed", consumedAt: now },
    });
    if (proofCompleted.count !== 1) {
      throw new Error("device_binding_challenge_replayed");
    }
    await tx.auth_sessions.updateMany({
      where: {
        authUserId: Number(authUserId),
        clientId: context.clientId,
        revokedAt: null,
      },
      data: { revokedAt: now, revokeReason: "device_identity_recovered" },
    });
  });
  emitSemanticEvent({
    eventType: "auth.device_binding.recovery_completed",
    category: "auth",
    severity: "info",
    outcome: "completed",
    subject: {
      type: "component",
      component: "identity",
      operation: "device-binding-recovery",
    },
    correlation: { clientId: context.clientId },
    metadata: { method: String(method || "unknown").slice(0, 32) },
    sensitivity: "metadata_only",
  });
  return { success: true, recovered: true };
}

module.exports = {
  canonicalProof,
  completeDeviceBindingRecovery,
  evaluateDeviceBindingForLogin,
  issueDeviceBindingChallenge,
  _deviceBindingInternals: { hash, verifiedAssertion },
};
