import { AUTH_SESSION_CLEARED_EVENT } from "@/utils/authTokenStorage";
import { deleteJson, getJson, postJson } from "./apiClient";

export const VAULT_GRANT_HEADER = "X-Athena-Vault-Grant";

let vaultAccessGrant = null;

function now() {
  return Date.now();
}

function normalizeGrant(record = null) {
  if (!record?.vaultGrant) return null;
  const expiresAtMs = Date.parse(record.expiresAt || "");
  return {
    token: record.vaultGrant,
    expiresAt: Number.isFinite(expiresAtMs) ? expiresAtMs : null,
  };
}

function activeVaultGrant() {
  if (!vaultAccessGrant?.token) return null;
  if (vaultAccessGrant.expiresAt && vaultAccessGrant.expiresAt <= now()) {
    clearVaultAccessGrant();
    return null;
  }
  return vaultAccessGrant;
}

function vaultGrantHeaders(vaultGrant = null) {
  const grant =
    typeof vaultGrant === "string"
      ? { token: vaultGrant }
      : vaultGrant || activeVaultGrant();
  return grant?.token ? { [VAULT_GRANT_HEADER]: grant.token } : {};
}

export function setVaultAccessGrant(record = null) {
  vaultAccessGrant = normalizeGrant(record);
  return vaultAccessGrant;
}

export function clearVaultAccessGrant() {
  vaultAccessGrant = null;
}

export function getCachedVaultAccessGrant() {
  return activeVaultGrant();
}

export async function requestVaultAccessGrantWithPassword({
  currentPassword,
  signal,
} = {}) {
  const { data } = await postJson(
    "/vault/reauth/password",
    { currentPassword },
    { signal, signing: "required" }
  );
  if (data?.success && data?.vaultGrant) setVaultAccessGrant(data);
  return data || { success: false, error: "empty_response" };
}

export async function requestVaultAccessGrantWithReauthToken({
  reauthToken,
  signal,
} = {}) {
  const { data } = await postJson(
    "/vault/access-grants",
    { reauthToken },
    { signal, signing: "required" }
  );
  if (data?.success && data?.vaultGrant) setVaultAccessGrant(data);
  return data || { success: false, error: "empty_response" };
}

export async function lockRemoteVault({ signal } = {}) {
  clearVaultAccessGrant();
  const { data } = await postJson(
    "/vault/lock",
    {},
    { signal, signing: "required" }
  );
  return data || { success: false, error: "empty_response" };
}

if (
  typeof window !== "undefined" &&
  typeof window.addEventListener === "function"
) {
  window.addEventListener(AUTH_SESSION_CLEARED_EVENT, () => {
    clearVaultAccessGrant();
  });
}

export async function listVaultItems({ type = null, signal } = {}) {
  const query = type ? `?type=${encodeURIComponent(type)}` : "";
  const { data } = await getJson(`/vault/items${query}`, { signal });
  return data?.items || [];
}

export async function getVaultItem(itemId, { signal, vaultGrant = null } = {}) {
  if (!itemId) return null;
  const { data } = await getJson(`/vault/items/${encodeURIComponent(itemId)}`, {
    signal,
    headers: vaultGrantHeaders(vaultGrant),
    signing: "required",
  });
  return data?.item || null;
}

export async function saveEncryptedVaultItem(payload = {}, options = {}) {
  const { data } = await postJson("/vault/items", payload, options);
  return data || { success: false, error: "empty_response" };
}

export async function deleteVaultItem(itemId, options = {}) {
  if (!itemId) return { success: false, error: "vault_item_id_required" };
  const { vaultGrant = null, headers = {}, ...rest } = options;
  const { data } = await deleteJson(
    `/vault/items/${encodeURIComponent(itemId)}`,
    {
      ...rest,
      headers: {
        ...headers,
        ...vaultGrantHeaders(vaultGrant),
      },
      signing: "required",
    }
  );
  return data || { success: false, error: "empty_response" };
}
