#!/usr/bin/env node
const { DataAccessCenter } = require("../utils/dataAccess");

const dryRun = process.argv.includes("--dry-run");

async function backfillWorkspaceChatPublicIds() {
  const result = await DataAccessCenter.workspaceChat.backfillMissingPublicIds({
    dryRun,
  });
  console.log(JSON.stringify(result, null, 2));
}

backfillWorkspaceChatPublicIds().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
