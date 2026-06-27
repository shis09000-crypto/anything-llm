import { getJson, postJson } from "./apiClient";
import { getClientIdentity } from "./clientIdentity";
import {
  clearSigningSecretCache,
  setSigningSecretCache,
} from "./requestSigningClient";

export async function listClients(options = {}) {
  const { data } = await getJson("/client-identity/clients", options);
  return data?.clients || [];
}

export async function revokeClient(clientId, options = {}) {
  if (!clientId) {
    return { success: false, error: "client_id_required" };
  }

  const { data } = await postJson(
    "/client-identity/revoke",
    { clientId },
    options
  );
  if (data?.success && clientId === getClientIdentity().clientId) {
    clearSigningSecretCache(clientId);
  }
  return data || { success: false, error: "empty_response" };
}

export async function revokeAllOtherClients(options = {}) {
  const { data } = await postJson(
    "/client-identity/revoke-all-others",
    {},
    options
  );
  return data || { success: false, error: "empty_response" };
}

export async function rotateSigningSecret(clientId, options = {}) {
  if (!clientId) {
    return { success: false, error: "client_id_required" };
  }

  const { data } = await postJson(
    "/client-identity/rotate-signing-secret",
    { clientId },
    options
  );
  if (
    data?.success &&
    data?.signingSecret &&
    clientId === getClientIdentity().clientId
  ) {
    setSigningSecretCache(clientId, data.signingSecret);
  }
  return data || { success: false, error: "empty_response" };
}

export async function rotateAllSigningSecrets(options = {}) {
  const { data } = await postJson(
    "/client-identity/rotate-all-signing-secrets",
    {},
    options
  );
  const currentClient = data?.currentClient;
  if (data?.success && currentClient?.signingSecret) {
    setSigningSecretCache(
      currentClient.clientId || getClientIdentity().clientId,
      currentClient.signingSecret
    );
  }
  return data || { success: false, error: "empty_response" };
}
