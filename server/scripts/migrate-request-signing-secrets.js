#!/usr/bin/env node
process.env.NODE_ENV ||= "development";

const prisma = require("../utils/prisma");
const { EncryptionManager } = require("../utils/EncryptionManager");
const { isSecretEncrypted, saveSecret } = require("../utils/security");

const legacyEncryption = new EncryptionManager();

function decryptLegacySigningSecret(value) {
  if (!value) return null;
  if (isSecretEncrypted(value)) return null;
  try {
    const decrypted = legacyEncryption.decrypt(value);
    if (decrypted && decrypted !== value) return decrypted;
  } catch {}
  if (String(value).startsWith("enc:")) return String(value).slice(4);
  return String(value);
}

async function main() {
  const apply = process.argv.includes("--apply");
  const clients = await prisma.athena_clients.findMany({
    where: {
      signingSecretEncrypted: { not: null },
    },
    select: {
      id: true,
      clientId: true,
      userId: true,
      signingSecretEncrypted: true,
    },
  });

  const candidates = clients.filter(
    (client) => !isSecretEncrypted(client.signingSecretEncrypted)
  );
  const failures = [];
  let updated = 0;

  for (const client of candidates) {
    try {
      const secret = decryptLegacySigningSecret(client.signingSecretEncrypted);
      if (!secret) throw new Error("unable_to_decrypt_legacy_signing_secret");
      if (apply) {
        await prisma.athena_clients.update({
          where: { id: client.id },
          data: { signingSecretEncrypted: saveSecret(secret) },
        });
        updated += 1;
      }
    } catch (error) {
      failures.push({
        id: client.id,
        clientId: client.clientId,
        userId: client.userId,
        error: error?.message || String(error),
      });
    }
  }

  const report = {
    success: failures.length === 0,
    mode: apply ? "apply" : "dry-run",
    scanned: clients.length,
    alreadyEncrypted: clients.length - candidates.length,
    candidates: candidates.length,
    updated,
    failures,
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.success ? 0 : 1);
}

main()
  .catch((error) => {
    console.error(
      JSON.stringify(
        { success: false, error: error?.message || String(error) },
        null,
        2
      )
    );
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect?.().catch(() => null);
  });
