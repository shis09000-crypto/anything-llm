import i18n, { loadAndActivateLanguage } from "@/i18n";
import {
  normalizeSupportedLanguage,
  supportedLanguages,
} from "@/locales/resources";

export function useLanguageOptions() {
  const languageNames = new Intl.DisplayNames(supportedLanguages, {
    type: "language",
  });
  const changeLanguage = (newLang = "en") => {
    if (!supportedLanguages.includes(newLang)) return false;
    void loadAndActivateLanguage(newLang);
    return true;
  };

  return {
    currentLanguage: normalizeSupportedLanguage(i18n.language),
    supportedLanguages,
    getLanguageName: (lang = "en") => languageNames.of(lang),
    changeLanguage,
  };
}
