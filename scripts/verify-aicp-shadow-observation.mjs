import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.ATHENA_AICP_SHADOW_OBSERVATION_ENABLED = "true";
process.env.ATHENA_AICP_SHADOW_SAMPLE_RATE = "1";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { AicpShadowObserver, aicpShadowObserver } = require(
  path.join(root, "server/utils/modulePlatform/aicp/shadowObserver")
);
const { emitSemanticEvent, registerSemanticEventSink } = require(
  path.join(root, "server/utils/observability/semanticEvents")
);
const { runWithOperationContext } = require(
  path.join(root, "server/utils/observability/operationContext")
);
const { requestInternalService } = require(
  path.join(root, "server/utils/microModules/internalClient")
);
const { MicroModuleServiceHost } = require(
  path.join(root, "server/utils/microModules/serviceHost")
);

async function main() {
  aicpShadowObserver.reset();
  const operationsObserver = new AicpShadowObserver({
    env: {
      ATHENA_AICP_SHADOW_OBSERVATION_ENABLED: "true",
      ATHENA_AICP_SHADOW_SAMPLE_RATE: "1",
    },
  });
  const unregister = registerSemanticEventSink((event) =>
    operationsObserver.observeSemanticEvent(event)
  );
  const host = new MicroModuleServiceHost({
    manifestId: "operations-plane",
    role: "operations-plane",
    port: 0,
    env: {
      NODE_ENV: "test",
      APP_ENV: "test",
      ATHENA_RUNTIME_TOPOLOGY: "local",
    },
    registerRoutes: (app) => {
      app.get("/internal/v1/operations/shadow-evidence", (_request, response) =>
        response.json({ success: true, marker: "response-preserved" })
      );
    },
  });

  const traceId = "33333333333333333333333333333333";
  try {
    await host.start();
    const response = await runWithOperationContext(
      { traceId, operationId: "operation-aicp-shadow-evidence" },
      () =>
        requestInternalService({
          callerRole: "api",
          url: `http://127.0.0.1:${host.port}/internal/v1/operations/shadow-evidence`,
          method: "GET",
          env: {
            NODE_ENV: "test",
            ATHENA_RUNTIME_TOPOLOGY: "local",
            ATHENA_AICP_SHADOW_SAMPLE_RATE: "1",
          },
        })
    );
    runWithOperationContext(
      { traceId, operationId: "operation-aicp-shadow-evidence" },
      () =>
        emitSemanticEvent({
          eventId: "aicp-shadow-business-event",
          eventType: "crypto.account.read.completed",
          category: "crypto-account-access",
          outcome: "success",
          subject: {
            type: "tool",
            component: "crypto-account-access",
            operation: "shadow-evidence",
          },
          sensitivity: "metadata_only",
        })
    );
    await new Promise((resolve) => setImmediate(resolve));

    const localTrace = aicpShadowObserver.trace(traceId);
    const operationsTrace = operationsObserver.trace(traceId);
    const topology = operationsObserver.topology();
    const success =
      response?.marker === "response-preserved" &&
      localTrace.found &&
      operationsTrace.found &&
      operationsTrace.entries.some((entry) => entry.kind === "rpc") &&
      operationsTrace.entries.some((entry) => entry.kind === "event") &&
      topology.summary.runtimeLinks >= 2 &&
      topology.summary.observedLinks >= 2;
    const result = {
      success,
      mode: "shadow-read-only",
      businessResponsePreserved: response?.marker === "response-preserved",
      localTraceObserved: localTrace.found,
      operationsTraceObserved: operationsTrace.found,
      topology: topology.summary,
      shadow: operationsObserver.health(),
    };
    console.log(JSON.stringify(result, null, 2));
    if (!success) process.exitCode = 1;
  } finally {
    unregister();
    await host.stop();
    aicpShadowObserver.reset();
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      success: false,
      error: String(error?.code || "aicp_shadow_verification_failed").slice(
        0,
        128
      ),
    })
  );
  process.exitCode = 1;
});
