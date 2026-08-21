const { parentPort } = require("worker_threads");

async function main() {
  const { runImageAssetMaintenance } = require("../utils/imageAssets/service");
  const result = await runImageAssetMaintenance({ limit: 25 });
  if (parentPort) {
    parentPort.postMessage({
      name: "image-asset-maintenance",
      message: "Image asset P2 maintenance completed.",
      result,
      silent: true,
    });
  }
}

main().catch((error) => {
  console.error("[image-asset-maintenance]", error.message, error);
  process.exit(1);
});
