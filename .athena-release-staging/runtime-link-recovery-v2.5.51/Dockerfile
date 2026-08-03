ARG BASE_IMAGE=anythingllm-v2-anythingllm:v2.5.50-responses-key-r7
FROM ${BASE_IMAGE}

USER root

# Runtime role dispatch is part of the module contract. Never inherit a stale
# entrypoint that can route an unknown role back into the monolith process.
COPY --chown=1000:1000 --chmod=0755 docker/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

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

# Responses execution is a single versioned contract across Chat, Agent,
# Responses Runtime, and Model Gateway. Copy the providers and consumers with
# the manifest catalog so a base-image route cannot drift behind its contract.
COPY --chown=1000:1000 server/chat-runtime.js /app/server/chat-runtime.js
COPY --chown=1000:1000 server/agent-runtime.js /app/server/agent-runtime.js
COPY --chown=1000:1000 server/model-gateway.js /app/server/model-gateway.js
COPY --chown=1000:1000 server/responses-runtime.js /app/server/responses-runtime.js
COPY --chown=1000:1000 server/utils/modelGateway/ /app/server/utils/modelGateway/
COPY --chown=1000:1000 server/utils/responsesRuntime/ /app/server/utils/responsesRuntime/

# Responses persistence and its generated Prisma client are one runtime
# contract. Shipping only the migration/schema leaves prisma.responses
# undefined even when the database tables already exist.
COPY --chown=1000:1000 server/prisma/schema.prisma /app/server/prisma/schema.prisma
COPY --chown=1000:1000 server/prisma/migrations/20260803090000_add_responses_runtime/ /app/server/prisma/migrations/20260803090000_add_responses_runtime/
COPY --chown=1000:1000 server/prisma/postgresql/schema.prisma /app/server/prisma/postgresql/schema.prisma
COPY --chown=1000:1000 server/prisma/postgresql/migrations/20260803090000_add_responses_runtime/ /app/server/prisma/postgresql/migrations/20260803090000_add_responses_runtime/

# Sync V2 owns durable event persistence. Producers call this capability and
# no longer write the Sync schema through their observer/database roles.
COPY --chown=1000:1000 server/realtime-gateway.js /app/server/realtime-gateway.js
COPY --chown=1000:1000 server/utils/broadcast/index.js /app/server/utils/broadcast/index.js
COPY --chown=1000:1000 server/utils/syncV2/syncEventClient.js /app/server/utils/syncV2/syncEventClient.js

# Open the public SSE stream only after the durable run has been claimed, so a
# provider-link failure remains a real HTTP error instead of a phantom run.
COPY --chown=1000:1000 server/endpoints/chat.js /app/server/endpoints/chat.js

RUN cd /app/server \
  && find module-manifests utils/modulePlatform/aicp -name '._*' -delete \
  && bash -n /usr/local/bin/docker-entrypoint.sh \
  && DATABASE_URL=postgresql://athena_build:athena_build@127.0.0.1:5432/athena_build npx prisma generate --schema=prisma/postgresql/schema.prisma \
  && node -e 'const { PrismaClient } = require("./generated/postgresql-main"); const client = new PrismaClient(); if (!client.responses || !client.responses_conversations) throw new Error("responses_prisma_delegate_missing"); client.$disconnect()' \
  && node -e 'for (const file of require("fs").readdirSync("module-manifests").filter((name) => !name.startsWith("._") && name.endsWith(".json"))) JSON.parse(require("fs").readFileSync(`module-manifests/${file}`, "utf8"))' \
  && node -c realtime-gateway.js \
  && node -c chat-runtime.js \
  && node -c agent-runtime.js \
  && node -c model-gateway.js \
  && node -c responses-runtime.js \
  && node -c endpoints/chat.js \
  && node -c utils/syncV2/syncEventClient.js

LABEL athena.release.id="runtime-link-recovery-v2.5.54" \
      athena.release.scope="aicp-v1.1-responses-chat-agent-sync-event-capability" \
      athena.release.contract="athena-aicp-manifest-v1.1"

USER 1000:1000
