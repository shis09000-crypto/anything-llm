ARG BASE_IMAGE=anythingllm-v2-anythingllm:v2.5.50-responses-key-r7
FROM ${BASE_IMAGE}

USER root

# Every server runtime in this release receives the same manifest catalog and
# AICP implementation so fingerprints cannot drift between module images.
COPY --chown=1000:1000 server/module-manifests/ /app/server/module-manifests/
COPY --chown=1000:1000 server/utils/modulePlatform/aicp/ /app/server/utils/modulePlatform/aicp/
COPY --chown=1000:1000 server/utils/modulePlatform/index.js /app/server/utils/modulePlatform/index.js
COPY --chown=1000:1000 server/utils/modulePlatform/manifestRegistry.js /app/server/utils/modulePlatform/manifestRegistry.js
COPY --chown=1000:1000 server/utils/microModules/internalClient.js /app/server/utils/microModules/internalClient.js
COPY --chown=1000:1000 server/utils/microModules/lifecycle.js /app/server/utils/microModules/lifecycle.js
COPY --chown=1000:1000 server/utils/microModules/serviceHost.js /app/server/utils/microModules/serviceHost.js
COPY --chown=1000:1000 server/utils/observability/semanticEvents.js /app/server/utils/observability/semanticEvents.js

# Cross-module clients must negotiate against the same catalog as providers.
COPY --chown=1000:1000 server/utils/authz/identityOperationsClient.js /app/server/utils/authz/identityOperationsClient.js
COPY --chown=1000:1000 server/utils/browserPlane/planeClient.js /app/server/utils/browserPlane/planeClient.js
COPY --chown=1000:1000 server/utils/browserPlane/workerClient.js /app/server/utils/browserPlane/workerClient.js
COPY --chown=1000:1000 server/utils/chats/threadMemoryRemoteClient.js /app/server/utils/chats/threadMemoryRemoteClient.js
COPY --chown=1000:1000 server/utils/coordination/remoteLifecycleForwarder.js /app/server/utils/coordination/remoteLifecycleForwarder.js
COPY --chown=1000:1000 server/utils/modelGateway/remoteProvider.js /app/server/utils/modelGateway/remoteProvider.js
COPY --chown=1000:1000 server/utils/operations/remoteEventForwarder.js /app/server/utils/operations/remoteEventForwarder.js
COPY --chown=1000:1000 server/utils/security/keyCustody/remoteClient.js /app/server/utils/security/keyCustody/remoteClient.js

# Sync V2 owns durable event persistence. Producers call this capability and
# no longer write the Sync schema through their observer/database roles.
COPY --chown=1000:1000 server/realtime-gateway.js /app/server/realtime-gateway.js
COPY --chown=1000:1000 server/utils/broadcast/index.js /app/server/utils/broadcast/index.js
COPY --chown=1000:1000 server/utils/syncV2/syncEventClient.js /app/server/utils/syncV2/syncEventClient.js

# Open the public SSE stream only after the durable run has been claimed, so a
# provider-link failure remains a real HTTP error instead of a phantom run.
COPY --chown=1000:1000 server/endpoints/chat.js /app/server/endpoints/chat.js

RUN cd /app/server \
  && node -e 'for (const file of require("fs").readdirSync("module-manifests").filter((name) => name.endsWith(".json"))) JSON.parse(require("fs").readFileSync(`module-manifests/${file}`, "utf8"))' \
  && node -c realtime-gateway.js \
  && node -c endpoints/chat.js \
  && node -c utils/syncV2/syncEventClient.js

LABEL athena.release.id="runtime-link-recovery-v2.5.51" \
      athena.release.scope="aicp-v1.1-responses-chat-agent-sync-event-capability" \
      athena.release.contract="athena-aicp-manifest-v1.1"

USER 1000:1000
