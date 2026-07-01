const { parentPort } = require("worker_threads");

async function main() {
  const { runSystemPatrol } = require("../utils/systemPatrol");
  await runSystemPatrol({ mode: "light", trigger: "worker" });
  if (parentPort) {
    parentPort.postMessage({
      name: "system-patrol",
      message: "System patrol completed.",
    });
  }
}

main().catch((error) => {
  console.error("[system-patrol]", error.message, error);
  process.exit(1);
});
