#!/usr/bin/env node

const {
  OperationsJetStreamTransport,
} = require("../utils/operations/jetStreamTransport");

async function main() {
  const action = process.argv[2] || "state";
  const transport = new OperationsJetStreamTransport(process.env);
  try {
    await transport.connect();
    if (action === "pause") {
      const hours = Math.max(1, Number(process.argv[3] || 2));
      const until = new Date(Date.now() + hours * 60 * 60 * 1_000);
      const result = await transport.pause(until);
      process.stdout.write(
        `${JSON.stringify({ action, until: until.toISOString(), ...result }, null, 2)}\n`
      );
      return;
    }
    if (action === "resume") {
      const result = await transport.resume();
      process.stdout.write(
        `${JSON.stringify({ action, ...result }, null, 2)}\n`
      );
      return;
    }
    if (action !== "state") {
      throw Object.assign(new Error("operations_consumer_action_invalid"), {
        code: "OPERATIONS_CONSUMER_ACTION_INVALID",
      });
    }
    process.stdout.write(
      `${JSON.stringify(await transport.consumerState(), null, 2)}\n`
    );
  } finally {
    await transport.drain();
  }
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({
      success: false,
      error: error?.code || error?.message || String(error),
    })}\n`
  );
  process.exitCode = 1;
});
