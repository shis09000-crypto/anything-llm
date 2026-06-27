import { USER_PROMPT_INPUT_MAP } from "@/utils/constants";
import { useEffect, useMemo } from "react";
import { useParams } from "react-router-dom";
import debounce from "lodash.debounce";
import { safeJsonParse } from "@/utils/request";
import {
  clearPromptDraft,
  hydratePromptDraft,
  persistPromptDraft,
  promptDraftScope,
} from "@/utils/userStateSync";

/**
 * Synchronizes prompt input value with localStorage, scoped to the current thread.
 *
 * Persists unsent prompt text across page refreshes and navigation. Each thread/workspace maintains
 * its own draft state independently. Storage key is determined by thread slug (if in a thread) or
 * workspace slug (if in default chat).
 *
 * Storage format (stored under USER_PROMPT_INPUT_MAP key):
 * ```json
 * {
 *   "thread-slug": "user's draft message...",
 *   "workspace-slug": "another draft message..."
 * }
 * ```
 *
 * @param {Object} props
 * @param {string} props.promptInput - Current prompt input value to sync
 * @param {Function} props.setPromptInput - State setter function for prompt input
 * @returns {void}
 */
/**
 * Immediately clears the stored draft for a given thread/workspace key.
 * Used before state updates that may remount PromptInput to prevent
 * stale text from being restored.
 * @param {string} storageKey - thread slug or workspace slug
 */
export function clearPromptInputDraft(storageKey, options = {}) {
  try {
    const map = safeJsonParse(localStorage.getItem(USER_PROMPT_INPUT_MAP), {});
    map[storageKey] = "";
    localStorage.setItem(USER_PROMPT_INPUT_MAP, JSON.stringify(map));
    clearPromptDraft(
      promptDraftScope({
        workspaceSlug: options.workspaceSlug || storageKey,
        threadSlug: options.threadSlug || null,
      })
    );
  } catch {}
}

export default function usePromptInputStorage({
  promptInput,
  setPromptInput,
  storageKey = null,
}) {
  const { threadSlug = null, slug: workspaceSlug } = useParams();
  const scopedStorageKey = storageKey || threadSlug || workspaceSlug;
  const syncedDraftScope = promptDraftScope({ workspaceSlug, threadSlug });
  useEffect(() => {
    const serializedPromptInputMap =
      localStorage.getItem(USER_PROMPT_INPUT_MAP) || "{}";

    const promptInputMap = safeJsonParse(serializedPromptInputMap, {});

    const userPromptInputValue = promptInputMap[scopedStorageKey];
    if (userPromptInputValue) {
      setPromptInput(userPromptInputValue);
    }
    void hydratePromptDraft(syncedDraftScope, userPromptInputValue || "").then(
      (remoteValue) => {
        if (!remoteValue || remoteValue === userPromptInputValue) return;
        promptInputMap[scopedStorageKey] = remoteValue;
        localStorage.setItem(
          USER_PROMPT_INPUT_MAP,
          JSON.stringify(promptInputMap)
        );
        setPromptInput(remoteValue);
      }
    );
  }, [scopedStorageKey, setPromptInput, syncedDraftScope]);

  const debouncedWriteToStorage = useMemo(
    () =>
      debounce((value, slug) => {
        const serializedPromptInputMap =
          localStorage.getItem(USER_PROMPT_INPUT_MAP) || "{}";
        const promptInputMap = safeJsonParse(serializedPromptInputMap, {});
        promptInputMap[slug] = value;
        localStorage.setItem(
          USER_PROMPT_INPUT_MAP,
          JSON.stringify(promptInputMap)
        );
        persistPromptDraft(syncedDraftScope, value, {
          workspaceSlug,
          threadSlug,
        });
      }, 500),
    [syncedDraftScope, threadSlug, workspaceSlug]
  );

  useEffect(() => {
    debouncedWriteToStorage(promptInput, scopedStorageKey);

    return () => {
      debouncedWriteToStorage.cancel();
    };
  }, [promptInput, scopedStorageKey, debouncedWriteToStorage]);
}
