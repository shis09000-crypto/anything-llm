import { useState, useEffect } from "react";
import {
  TEXT_SIZE_CHANGE_EVENT,
  getTextSizePreference,
  textSizeStyleFor,
} from "@/utils/textSize";

export default function useTextSize() {
  const [preference, setPreference] = useState(() => getTextSizePreference());

  useEffect(() => {
    const handleTextSizeChange = (event) => {
      setPreference(event.detail?.px ? event.detail : getTextSizePreference());
    };

    window.addEventListener(TEXT_SIZE_CHANGE_EVENT, handleTextSizeChange);
    return () => {
      window.removeEventListener(TEXT_SIZE_CHANGE_EVENT, handleTextSizeChange);
    };
  }, []);

  return {
    textSize: preference.value,
    textSizeClass: preference.textClass,
    textSizeStyle: textSizeStyleFor(preference),
    textSizePreference: preference,
  };
}
