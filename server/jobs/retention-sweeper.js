const { parentPort } = require("worker_threads");

async function main() {
  const { runRetentionSweep } = require("../utils/retention/sweeper");
  const result = await runRetentionSweep();
  if (parentPort) {
    parentPort.postMessage({
      name: "retention-sweeper",
      message: result.skipped
        ? "Retention sweep skipped."
        : "Retention sweep completed.",
      silent: true,
    });
  }
}

main().catch((error) => {
  console.error("[retention-sweeper]", error.message, error);
  process.exit(1);
});
