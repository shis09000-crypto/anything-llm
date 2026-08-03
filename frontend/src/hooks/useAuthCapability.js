import { useEffect, useState } from "react";
import {
  AUTH_CAPABILITY_STATUS,
  detectAuthCapabilityAsync,
} from "@/utils/authCapability";
import { getAuthToken } from "@/utils/authTokenStorage";
import { recordClientUiObservation } from "@/lib/communication/clientUiObservability";

export default function useAuthCapability(serverPasskey = {}) {
  const [capability, setCapability] = useState({
    status: AUTH_CAPABILITY_STATUS.CHECKING,
    showPasskey: false,
  });

  useEffect(() => {
    let cancelled = false;
    setCapability({
      status: AUTH_CAPABILITY_STATUS.CHECKING,
      showPasskey: false,
    });
    detectAuthCapabilityAsync(serverPasskey).then((result) => {
      if (!cancelled) {
        setCapability(result);
        recordCapability(result);
      }
    });
    const recheck = () => {
      detectAuthCapabilityAsync(serverPasskey).then((result) => {
        if (!cancelled) {
          setCapability(result);
          recordCapability(result);
        }
      });
    };
    window.addEventListener("athena-passkey-capability-changed", recheck);
    return () => {
      cancelled = true;
      window.removeEventListener("athena-passkey-capability-changed", recheck);
    };
  }, [
    serverPasskey?.enabled,
    serverPasskey?.crossDeviceAllowed,
    serverPasskey?.rpIdValid,
  ]);

  return capability;
}

function recordCapability(capability) {
  if (!getAuthToken()) return;
  const eventByStatus = {
    [AUTH_CAPABILITY_STATUS.LOCAL_READY]: "passkey_local_ready",
    [AUTH_CAPABILITY_STATUS.CROSS_DEVICE_ONLY]: "passkey_cross_device_only",
    [AUTH_CAPABILITY_STATUS.UNAVAILABLE]: "passkey_unavailable",
  };
  const event = eventByStatus[capability?.status];
  if (!event) return;
  recordClientUiObservation({
    event,
    surface: "passkey_capability",
    outcome:
      capability.status === AUTH_CAPABILITY_STATUS.UNAVAILABLE
        ? "failed"
        : "observed",
    reason: capability.reasonCode || "none",
    onceKey: `passkey:${capability.status}:${capability.reasonCode || "none"}`,
  });
}
