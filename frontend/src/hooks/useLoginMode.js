import { useEffect, useState } from "react";
import { AUTH_USER } from "@/utils/constants";
import { getAuthToken } from "@/utils/authTokenStorage";

export default function useLoginMode() {
  const [mode, setMode] = useState(null);

  useEffect(() => {
    if (!window) return;
    const user = !!window.localStorage.getItem(AUTH_USER);
    const token = !!getAuthToken();
    let _mode = null;
    if (user && token) _mode = "multi";
    if (!user && token) _mode = "single";
    setMode(_mode);
  }, [window]);

  return mode;
}
