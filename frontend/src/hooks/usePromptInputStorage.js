import { USER_PROMPT_INPUT_MAP } from "@/utils/constants";
import { useCallback, useEffect, useMemo, useRef } from "react";
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
  promptInputRef: externalPromptInputRef = null,
  setPromptInput,
  storageKey = null,
}) {
  const { threadSlug = null, slug: workspaceSlug } = useParams();
  const scopedStorageKey = storageKey || threadSlug || workspaceSlug;
  const syncedDraftScope = promptDraftScope({ workspaceSlug, threadSlug });
  const internalPromptInputRef = useRef(promptInput || "");
  const promptInputRef = externalPromptInputRef || internalPromptInputRef;
  const hydrationSequenceRef = useRef(0);

  useEffect(() => {
    if (externalPromptInputRef) return;
    promptInputRef.current = promptInput;
  }, [externalPromptInputRef, promptInput, promptInputRef]);

  useEffect(() => {
    const hydrationSequence = hydrationSequenceRef.current + 1;
    hydrationSequenceRef.current = hydrationSequence;
    const serializedPromptInputMap =
      localStorage.getItem(USER_PROMPT_INPUT_MAP) || "{}";

    const promptInputMap = safeJsonParse(serializedPromptInputMap, {});

    const userPromptInputValue = promptInputMap[scopedStorageKey];
    if (userPromptInputValue) {
      promptInputRef.current = userPromptInputValue;
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
    const hydrationBaseline = promptInputRef.current;
    void hydratePromptDraft(syncedDraftScope, userPromptInputValue || "").then(
      (remoteValue) => {
        if (hydrationSequenceRef.current !== hydrationSequence) return;
        if (!remoteValue || remoteValue === userPromptInputValue) return;
        // A slow hydration must never overwrite text that the user typed or
        // cleared while the request was in flight.
        if (promptInputRef.current !== hydrationBaseline) return;
        promptInputRef.current = remoteValue;
        setPromptInput(remoteValue);
      }
    );
    return () => {
      if (hydrationSequenceRef.current === hydrationSequence) {
        hydrationSequenceRef.current += 1;
      }
    };
  }, [promptInputRef, scopedStorageKey, setPromptInput, syncedDraftScope]);

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

  const schedulePromptInputStorage = useCallback(
    (value) => {
      promptInputRef.current = value;
      debouncedWriteToStorage(value, scopedStorageKey);
    },
    [debouncedWriteToStorage, promptInputRef, scopedStorageKey]
  );

  useEffect(() => {
    if (externalPromptInputRef) return;
    schedulePromptInputStorage(promptInput);
  }, [externalPromptInputRef, promptInput, schedulePromptInputStorage]);

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

  return schedulePromptInputStorage;
}
