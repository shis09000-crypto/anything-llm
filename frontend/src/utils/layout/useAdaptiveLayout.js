import { useEffect, useState } from "react";
import { getClientCapabilityProfile } from "@/lib/communication/clientCapabilityProfile";
import {
  createAdaptiveLayoutObserver,
  deriveAdaptiveLayout,
} from "./adaptiveLayout";

function readAdaptiveLayout() {
  return deriveAdaptiveLayout(getClientCapabilityProfile());
}

export function useAdaptiveLayout() {
  const [layout, setLayout] = useState(readAdaptiveLayout);

  useEffect(() => {
    const observer = createAdaptiveLayoutObserver({
      getProfile: getClientCapabilityProfile,
      onChange: setLayout,
    });
    setLayout(observer.read());
    return () => observer.dispose();
  }, []);

  return layout;
}

export default useAdaptiveLayout;
