import { createContext, useEffect, useState } from "react";
import AthenaMark from "./media/logo/athena-mark.svg";
import AthenaLogo from "./media/logo/athena-logo.svg";
import System from "./models/system";

export const REFETCH_LOGO_EVENT = "refetch-logo";

export const LogoContext = createContext();

export function LogoProvider({ children }) {
  const [logo, setLogo] = useState("");
  const [loginLogo, setLoginLogo] = useState("");
  const [isCustomLogo, setIsCustomLogo] = useState(false);

  async function fetchInstanceLogo({ force = false } = {}) {
    const DefaultLoginLogo = AthenaLogo;
    try {
      const { isCustomLogo, logoURL } = await System.fetchLogo({ force });
      if (logoURL && isCustomLogo) {
        setLogo(logoURL);
        setLoginLogo(logoURL);
        setIsCustomLogo(isCustomLogo);
      } else {
        setLogo(AthenaMark);
        setLoginLogo(DefaultLoginLogo);
        setIsCustomLogo(false);
      }
    } catch (err) {
      setLogo(AthenaMark);
      setLoginLogo(DefaultLoginLogo);
      setIsCustomLogo(false);
      console.error("Failed to fetch logo:", err);
    }
  }

  useEffect(() => {
    fetchInstanceLogo();
    const forceRefetchLogo = () => fetchInstanceLogo({ force: true });
    window.addEventListener(REFETCH_LOGO_EVENT, forceRefetchLogo);
    return () => {
      window.removeEventListener(REFETCH_LOGO_EVENT, forceRefetchLogo);
    };
  }, []);

  return (
    <LogoContext.Provider value={{ logo, setLogo, loginLogo, isCustomLogo }}>
      {children}
    </LogoContext.Provider>
  );
}
