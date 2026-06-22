import { getJson, postJson } from "./apiClient";

export function fetchWebPushPublicKey(options = {}) {
  return getJson("/web-push/pubkey", options);
}

export function subscribeWebPush(subscription, options = {}) {
  return postJson("/web-push/subscribe", subscription, options);
}
