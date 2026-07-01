import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";

const clientUrl = new URL("./clientIdentityClient.js", import.meta.url);

async function loadClientIdentityClient() {
  const source = await readFile(clientUrl, "utf8");
  const calls = [];
  globalThis.__clientIdentityClientTestApi = {
    getJson: async (path, options = {}) => {
      calls.push({ method: "GET", path, options });
      return {
        data: {
          success: true,
          clients: [{ clientId: "client_current", platform: "web" }],
        },
      };
    },
    postJson: async (path, body, options = {}) => {
      calls.push({ method: "POST", path, body, options });
      if (path.endsWith("rotate-signing-secret")) {
        return {
          data: {
            success: true,
            clientId: body?.clientId || null,
            signingSecret:
              body?.clientId === "client_current" ? "rotated_secret" : null,
            signingSecretVersion: "sec_rotated",
          },
        };
      }
      if (path.endsWith("rotate-all-signing-secrets")) {
        return {
          data: {
            success: true,
            rotatedCount: 2,
            currentClient: {
              clientId: "client_current",
              signingSecret: "rotated_all_secret",
              signingSecretVersion: "sec_rotated_all",
            },
          },
        };
      }
      return {
        data: {
          success: true,
          clientId: body?.clientId || null,
          revokedCount: path.endsWith("revoke-all-others") ? 2 : undefined,
        },
      };
    },
  };
  globalThis.__clientIdentityClientTestIdentity = {
    getClientIdentity: () => ({ clientId: "client_current" }),
    resetCalls: [],
    async resetClientIdentity(options = {}) {
      globalThis.__clientIdentityClientTestIdentity.resetCalls.push(options);
    },
  };
  globalThis.__clientIdentityClientTestSigning = {
    cleared: [],
    set: [],
    clearSigningSecretCache(clientId) {
      globalThis.__clientIdentityClientTestSigning.cleared.push(
        clientId || null
      );
    },
    setSigningSecretCache(clientId, secret) {
      globalThis.__clientIdentityClientTestSigning.set.push({
        clientId,
        secret,
      });
    },
  };
  globalThis.__clientIdentityClientTestSensitiveState = {
    cleared: [],
    clearSensitiveClientSession(options = {}) {
      globalThis.__clientIdentityClientTestSensitiveState.cleared.push(options);
    },
  };

  const transformed = source
    .replace(
      'import { getJson, postJson } from "./apiClient";',
      "const { getJson, postJson } = globalThis.__clientIdentityClientTestApi;"
    )
    .replace(
      'import { getClientIdentity, resetClientIdentity } from "./clientIdentity";',
      "const { getClientIdentity, resetClientIdentity } = globalThis.__clientIdentityClientTestIdentity;"
    )
    .replace(
      /import\s+\{[\s\S]*?\}\s+from\s+"\.\/requestSigningClient";/,
      "const { clearSigningSecretCache, setSigningSecretCache } = globalThis.__clientIdentityClientTestSigning;"
    )
    .replace(
      'import { clearSensitiveClientSession } from "@/utils/security/clearSensitiveClientState";',
      "const { clearSensitiveClientSession } = globalThis.__clientIdentityClientTestSensitiveState;"
    );

  const mod = await import(
    `data:text/javascript;base64,${Buffer.from(transformed).toString("base64")}#${Date.now()}-${Math.random()}`
  );
  return { mod, calls };
}

test("client identity client lists clients and revokes through JSON client", async () => {
  const { mod, calls } = await loadClientIdentityClient();

  const clients = await mod.listClients();
  assert.deepEqual(clients, [{ clientId: "client_current", platform: "web" }]);

  const revoke = await mod.revokeClient("client_other");
  assert.equal(revoke.success, true);
  assert.equal(revoke.clientId, "client_other");

  const revokeAll = await mod.revokeAllOtherClients();
  assert.equal(revokeAll.revokedCount, 2);

  assert.deepEqual(
    calls.map((call) => [call.method, call.path]),
    [
      ["GET", "/client-identity/clients"],
      ["POST", "/client-identity/revoke"],
      ["POST", "/client-identity/revoke-all-others"],
    ]
  );
});

test("self revoke clears the current signing secret and local device session", async () => {
  const { mod } = await loadClientIdentityClient();
  await mod.revokeClient("client_current");
  assert.deepEqual(globalThis.__clientIdentityClientTestSigning.cleared, [
    "client_current",
  ]);
  assert.deepEqual(globalThis.__clientIdentityClientTestIdentity.resetCalls, [
    { rotateDeviceKey: true },
  ]);
  assert.deepEqual(
    globalThis.__clientIdentityClientTestSensitiveState.cleared,
    [
      {
        reason: "current_client_revoked",
        includeDurableCaches: false,
      },
    ]
  );
});

test("rotation updates only the current signing secret cache", async () => {
  const { mod } = await loadClientIdentityClient();
  const other = await mod.rotateSigningSecret("client_other");
  assert.equal(other.success, true);
  assert.deepEqual(globalThis.__clientIdentityClientTestSigning.set, []);

  const current = await mod.rotateSigningSecret("client_current");
  assert.equal(current.signingSecretVersion, "sec_rotated");
  assert.deepEqual(globalThis.__clientIdentityClientTestSigning.set, [
    { clientId: "client_current", secret: "rotated_secret" },
  ]);

  const all = await mod.rotateAllSigningSecrets();
  assert.equal(all.rotatedCount, 2);
  assert.deepEqual(globalThis.__clientIdentityClientTestSigning.set.at(-1), {
    clientId: "client_current",
    secret: "rotated_all_secret",
  });
});
