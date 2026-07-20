import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import {
  defaultNS,
  loadLanguageResource,
  normalizeSupportedLanguage,
  resources,
} from "./locales/resources";

const initialization = i18next
  // https://github.com/i18next/i18next-browser-languageDetector/blob/9efebe6ca0271c3797bc09b84babf1ba2d9b4dbb/src/index.js#L11
  .use(initReactI18next) // Initialize i18n for React
  .use(LanguageDetector)
  .init({
    fallbackLng: "en",
    debug: import.meta.env.DEV,
    defaultNS,
    resources,
    lowerCaseLng: true,
    interpolation: {
      escapeValue: false,
    },
  });

export async function loadAndActivateLanguage(value = "en") {
  const { language, resource } = await loadLanguageResource(value);
  if (!i18next.hasResourceBundle(language, defaultNS)) {
    i18next.addResourceBundle(language, defaultNS, resource, true, true);
  }
  if (normalizeSupportedLanguage(i18next.language) !== language) {
    await i18next.changeLanguage(language);
  }
  return language;
}

export const i18nReady = Promise.resolve(initialization).then(() =>
  loadAndActivateLanguage(i18next.language)
);

export default i18next;
