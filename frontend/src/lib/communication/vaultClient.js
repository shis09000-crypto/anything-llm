import { deleteJson, getJson, postJson } from "./apiClient";

export async function listVaultItems({ type = null, signal } = {}) {
  const query = type ? `?type=${encodeURIComponent(type)}` : "";
  const { data } = await getJson(`/vault/items${query}`, { signal });
  return data?.items || [];
}

export async function getVaultItem(itemId, { signal } = {}) {
  if (!itemId) return null;
  const { data } = await getJson(`/vault/items/${encodeURIComponent(itemId)}`, {
    signal,
  });
  return data?.item || null;
}

export async function saveEncryptedVaultItem(payload = {}, options = {}) {
  const { data } = await postJson("/vault/items", payload, options);
  return data || { success: false, error: "empty_response" };
}

export async function deleteVaultItem(itemId, options = {}) {
  if (!itemId) return { success: false, error: "vault_item_id_required" };
  const { data } = await deleteJson(
    `/vault/items/${encodeURIComponent(itemId)}`,
    options
  );
  return data || { success: false, error: "empty_response" };
}
