import React, { createContext, useState, useEffect } from "react";
import useUser from "./hooks/useUser";
import System from "./models/system";

export const PfpContext = createContext();

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
      } catch (err) {
        if (!active) return;
        setPfp(null);
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

    async function refreshPfp(event) {
      const detail = event?.detail || {};
      const changedFields = Array.isArray(detail.changedFields)
        ? detail.changedFields
        : [];
      if (!changedFields.includes("pfpFilename")) return;
      if (detail.userId && String(detail.userId) !== String(user.id)) return;

      try {
        const pfpUrl = await System.fetchPfp(user.id);
        if (!active) return;
        setPfp(pfpUrl);
      } catch (err) {
        if (!active) return;
        setPfp(null);
        console.error("Failed to refresh pfp:", err);
      }
    }

    window.addEventListener("athena-user-profile-refresh", refreshPfp);
    return () => {
      active = false;
      window.removeEventListener("athena-user-profile-refresh", refreshPfp);
    };
  }, [user?.id]);

  return (
    <PfpContext.Provider value={{ pfp, setPfp }}>
      {children}
    </PfpContext.Provider>
  );
}
