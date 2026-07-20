import { USER_PROMPT_INPUT_MAP } from "@/utils/constants";
import { useEffect, useMemo } from "react";
import { useParams } from "react-router-dom";
import debounce from "lodash.debounce";
import { safeJsonParse } from "@/utils/request";
import {
  clearPromptDraft,
  flushPromptDraft,
  hydratePromptDraft,
  persistPromptDraft,
  promptDraftScope,
} from "@/utils/userStateSync";

/**
 * Synchronizes prompt input value with encrypted user-state storage, scoped to the current thread.
 *
 * Legacy localStorage drafts are read once for migration and then removed so new drafts do not
 * keep long-lived plaintext in browser storage.
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
    delete map[storageKey];
    if (Object.keys(map).length) {
      localStorage.setItem(USER_PROMPT_INPUT_MAP, JSON.stringify(map));
    } else {
      localStorage.removeItem(USER_PROMPT_INPUT_MAP);
    }
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
      delete promptInputMap[scopedStorageKey];
      if (Object.keys(promptInputMap).length) {
        localStorage.setItem(
          USER_PROMPT_INPUT_MAP,
          JSON.stringify(promptInputMap)
        );
      } else {
        localStorage.removeItem(USER_PROMPT_INPUT_MAP);
      }
    }
    void hydratePromptDraft(syncedDraftScope, userPromptInputValue || "").then(
      (remoteValue) => {
        if (!remoteValue || remoteValue === userPromptInputValue) return;
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
        delete promptInputMap[slug];
        if (Object.keys(promptInputMap).length) {
          localStorage.setItem(
            USER_PROMPT_INPUT_MAP,
            JSON.stringify(promptInputMap)
          );
        } else {
          localStorage.removeItem(USER_PROMPT_INPUT_MAP);
        }
        if (!String(value || "").trim()) {
          clearPromptDraft(syncedDraftScope);
          return;
        }
        persistPromptDraft(syncedDraftScope, value, {
          workspaceSlug,
          threadSlug,
        });
      }, 500),
    [syncedDraftScope, threadSlug, workspaceSlug]
  );

  useEffect(() => {
    debouncedWriteToStorage(promptInput, scopedStorageKey);
  }, [promptInput, scopedStorageKey, debouncedWriteToStorage]);

  useEffect(
    () => () => {
      // Do not discard the last keystrokes when navigation unmounts the
      // composer before the debounce expires. Flush both debounce layers;
      // per-node request serialization preserves save/delete ordering.
      debouncedWriteToStorage.flush();
      void flushPromptDraft(syncedDraftScope);
    },
    [debouncedWriteToStorage, syncedDraftScope]
  );
}
