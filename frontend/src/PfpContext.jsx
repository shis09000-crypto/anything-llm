import React, { createContext, useState, useEffect } from "react";
import useUser from "./hooks/useUser";
import System from "./models/system";
import {
  CHAT_SECONDARY_PRELOAD_EVENT,
  chatSecondaryTask,
} from "./utils/chat/chatSecondaryPreload";

export const PfpContext = createContext();

function markAccountAvatarVisible() {
  if (typeof performance === "undefined") return;
  performance.mark?.("athena:account_avatar_visible");
}

export function PfpProvider({ children }) {
  const [pfp, setPfp] = useState(null);
  const { user } = useUser();

  useEffect(() => {
    let active = true;
    async function fetchPfp() {
      if (!user?.id) {
        setPfp(null);
        return;
      }
      try {
        const pfpUrl = await System.fetchPfp(user.id);
        if (!active) return;
        setPfp(pfpUrl);
        markAccountAvatarVisible();
      } catch (err) {
        if (!active) return;
        console.error("Failed to fetch pfp:", err);
      }
    }
    fetchPfp();
    return () => {
      active = false;
    };
  }, [user?.id]);

  useEffect(() => {
    if (!user?.id) return;
    let active = true;

    async function loadPfp(options = {}) {
      try {
        const pfpUrl = await System.fetchPfp(user.id, options);
        if (!active) return;
        setPfp(pfpUrl);
        markAccountAvatarVisible();
      } catch (err) {
        if (!active) return;
        console.error("Failed to refresh pfp:", err);
      }
    }

    function refreshPfp(event) {
      const detail = event?.detail || {};
      const changedFields = Array.isArray(detail.changedFields)
        ? detail.changedFields
        : [];
      if (!changedFields.includes("pfpFilename")) return;
      if (detail.userId && String(detail.userId) !== String(user.id)) return;

      void loadPfp({
        force: true,
        communicationScene: "account-avatar-profile-refresh",
        task: chatSecondaryTask("account:avatar:profile-refresh", {
          surface: "account-avatar",
          userId: user.id,
        }),
      });
    }

    function preloadAfterChatReady(event) {
      const detail = event?.detail || {};
      if (detail.userId && String(detail.userId) !== String(user.id)) return;
      void loadPfp({
        force: true,
        communicationScene: "account-avatar-after-chat-ready",
        task: chatSecondaryTask("account:avatar:after-chat-ready", {
          surface: "account-avatar",
          workspaceSlug: detail.workspaceSlug || undefined,
          threadSlug: detail.threadSlug || undefined,
          userId: user.id,
        }),
      });
    }

    window.addEventListener("athena-user-profile-refresh", refreshPfp);
    window.addEventListener(
      CHAT_SECONDARY_PRELOAD_EVENT,
      preloadAfterChatReady
    );
    return () => {
      active = false;
      window.removeEventListener("athena-user-profile-refresh", refreshPfp);
      window.removeEventListener(
        CHAT_SECONDARY_PRELOAD_EVENT,
        preloadAfterChatReady
      );
    };
  }, [user?.id]);

  return (
    <PfpContext.Provider value={{ pfp, setPfp }}>
      {children}
    </PfpContext.Provider>
  );
}
