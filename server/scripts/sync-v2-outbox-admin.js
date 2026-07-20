#!/usr/bin/env node
const { bootstrapCliRuntime } = require("./lib/runtimeBootstrap");

function argument(name) {
  const prefix = `--${name}=`;
  return process.argv
    .find((entry) => entry.startsWith(prefix))
    ?.slice(prefix.length);
}

function parseSeqs(value) {
  if (!value) return [];
  return [
    ...new Set(String(value).split(",").map(Number).filter(Number.isInteger)),
  ];
}

async function main() {
  const requeue = argument("requeue");
  const execute = process.argv.includes("--execute");
  await bootstrapCliRuntime({
    access: requeue && execute ? "write" : "read",
    execute: requeue && execute,
    requiredTables: ["sync_outbox"],
  });
  const prisma = require("../utils/prisma");
  try {
    const rows = await prisma.sync_outbox.findMany({
      where: { status: "dead_letter" },
      orderBy: { seq: "asc" },
      take: 200,
      select: {
        seq: true,
        eventId: true,
        nodeKey: true,
        attemptCount: true,
        lastErrorCode: true,
        deadLetteredAt: true,
        requestId: true,
        traceId: true,
      },
    });
    if (!requeue) {
      console.log(
        JSON.stringify({ mode: "list", count: rows.length, rows }, null, 2)
      );
      return;
    }
    const seqs =
      requeue === "all" ? rows.map((row) => row.seq) : parseSeqs(requeue);
    if (!execute) {
      console.log(
        JSON.stringify(
          {
            mode: "dry-run",
            action: "requeue",
            seqs,
            instruction:
              "Repeat with --execute after reviewing the selected events.",
          },
          null,
          2
        )
      );
      return;
    }
    const result = await prisma.sync_outbox.updateMany({
      where: { seq: { in: seqs }, status: "dead_letter" },
      data: {
        status: "retry",
        attemptCount: 0,
        nextAttemptAt: new Date(),
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: null,
        lastErrorDetail: null,
        deadLetteredAt: null,
      },
    });
    console.log(
      JSON.stringify({ mode: "execute", requeued: result.count, seqs }, null, 2)
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      success: false,
      error: error?.code || error?.message || "outbox_admin_failed",
    })
  );
  process.exitCode = 1;
});
