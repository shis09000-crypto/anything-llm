#!/usr/bin/env node
const { bootstrapCliRuntime } = require("./lib/runtimeBootstrap");

const execute = process.argv.includes("--execute");
const command = process.argv.find((value) =>
  ["reconcile", "health", "stats", "verify"].includes(value)
);

async function main() {
  await bootstrapCliRuntime({
    access: execute && command === "reconcile" ? "write" : "read",
    execute,
    requiredTables: ["content_objects"],
  });
  const prisma = require("../utils/prisma");
  const { DataAccessCenter } = require("../utils/dataAccess");
  const {
    contentObjectProvider,
  } = require("../providers/storage/contentObjectProvider");
  try {
    if (command === "health") {
      console.log(
        JSON.stringify(await contentObjectProvider().health(), null, 2)
      );
      return;
    }
    if (command === "reconcile") {
      if (!execute)
        throw new Error("content_object_reconcile_requires_execute");
      const now = Date.now();
      const result = await DataAccessCenter.contentObject.reconcile({
        stagingBefore: new Date(now - 24 * 60 * 60 * 1000),
        deleteBefore: new Date(now),
      });
      console.log(JSON.stringify({ success: true, ...result }, null, 2));
      return;
    }
    if (command === "verify") {
      const result = await DataAccessCenter.contentObject.verify();
      console.log(
        JSON.stringify(
          { success: result.failureCount === 0, ...result },
          null,
          2
        )
      );
      if (result.failureCount > 0) process.exitCode = 1;
      return;
    }
    const rows = await prisma.content_objects.groupBy({
      by: ["provider", "state"],
      _count: { _all: true },
      _sum: { plaintextSize: true, refCount: true },
    });
    console.log(JSON.stringify({ success: true, rows }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify({ success: false, error: error.code || error.message })
  );
  process.exitCode = 1;
});
