import { useEffect, useState } from "react";
import { getAuthToken } from "@/utils/authTokenStorage";
import { hasStoredAuthUser } from "@/utils/authUserStorage";

export default function useLoginMode() {
  const [mode, setMode] = useState(null);

  useEffect(() => {
    if (!window) return;
    const user = hasStoredAuthUser();
    const token = !!getAuthToken();
    let _mode = null;
    if (user && token) _mode = "multi";
    if (!user && token) _mode = "single";
    setMode(_mode);
  }, [window]);

  return mode;
}
