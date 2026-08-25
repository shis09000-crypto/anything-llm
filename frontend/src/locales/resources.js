// English is the only locale shipped in the bootstrap graph. Every other
// dictionary is loaded on demand before the application becomes interactive.
import English from "./en/common.js";
import { externalMcpChinese, externalMcpEnglish } from "./externalMcp.js";
import { localRuntimeChinese, localRuntimeEnglish } from "./localRuntime.js";
import { composerMenuChinese, composerMenuEnglish } from "./composerMenu.js";

function completeExternalMcpLocale(resource, language) {
  const localized = language === "zh" ? externalMcpChinese : {};
  const localRuntimeLocalized = language === "zh" ? localRuntimeChinese : {};
  const composerMenuLocalized =
    language === "zh" ? composerMenuChinese : composerMenuEnglish;
  return {
    ...resource,
    settings: {
      ...(resource.settings || {}),
      "api-keys": localized.title || externalMcpEnglish.title,
      "local-runtime": localRuntimeLocalized.title || localRuntimeEnglish.title,
    },
    externalMcp: {
      ...externalMcpEnglish,
      ...localized,
      tabs: { ...externalMcpEnglish.tabs, ...(localized.tabs || {}) },
      connection: {
        ...externalMcpEnglish.connection,
        ...(localized.connection || {}),
      },
      create: { ...externalMcpEnglish.create, ...(localized.create || {}) },
      secret: { ...externalMcpEnglish.secret, ...(localized.secret || {}) },
      consent: { ...externalMcpEnglish.consent, ...(localized.consent || {}) },
      emergency: {
        ...externalMcpEnglish.emergency,
        ...(localized.emergency || {}),
      },
      legacy: { ...externalMcpEnglish.legacy, ...(localized.legacy || {}) },
    },
    localRuntime: {
      ...localRuntimeEnglish,
      ...localRuntimeLocalized,
    },
    chat_window: {
      ...(resource.chat_window || {}),
      controls: {
        ...(resource.chat_window?.controls || {}),
        composerMenu: {
          ...composerMenuEnglish,
          ...composerMenuLocalized,
        },
      },
    },
  };
}

const completedEnglish = completeExternalMcpLocale(English, "en");

export const defaultNS = "common";
export const supportedLanguages = [
  "en",
  "zh",
  "zh-tw",
  "es",
  "de",
  "fr",
  "ko",
  "et",
  "ru",
  "it",
  "pt",
  "he",
  "nl",
  "vi",
  "fa",
  "tr",
  "ar",
  "da",
  "ja",
  "lv",
  "pl",
  "ro",
  "cs",
  "lt",
  "ca",
];

export const resources = { en: { common: completedEnglish } };

const loaders = {
  zh: () => import("./zh/common.js"),
  "zh-tw": () => import("./zh_TW/common.js"),
  es: () => import("./es/common.js"),
  de: () => import("./de/common.js"),
  fr: () => import("./fr/common.js"),
  ko: () => import("./ko/common.js"),
  et: () => import("./et/common.js"),
  ru: () => import("./ru/common.js"),
  it: () => import("./it/common.js"),
  pt: () => import("./pt_BR/common.js"),
  he: () => import("./he/common.js"),
  nl: () => import("./nl/common.js"),
  vi: () => import("./vn/common.js"),
  fa: () => import("./fa/common.js"),
  tr: () => import("./tr/common.js"),
  ar: () => import("./ar/common.js"),
  da: () => import("./da/common.js"),
  ja: () => import("./ja/common.js"),
  lv: () => import("./lv/common.js"),
  pl: () => import("./pl/common.js"),
  ro: () => import("./ro/common.js"),
  cs: () => import("./cs/common.js"),
  lt: () => import("./lt/common.js"),
  ca: () => import("./ca/common.js"),
};

export function normalizeSupportedLanguage(value = "en") {
  const normalized = String(value).trim().toLowerCase().replaceAll("_", "-");
  if (supportedLanguages.includes(normalized)) return normalized;
  const base = normalized.split("-")[0];
  return supportedLanguages.includes(base) ? base : "en";
}

export async function loadLanguageResource(value = "en") {
  const language = normalizeSupportedLanguage(value);
  if (language === "en") return { language, resource: completedEnglish };
  const module = await loaders[language]();
  return {
    language,
    resource: completeExternalMcpLocale(module.default, language),
  };
}

export async function loadAllLanguageResources() {
  const loaded = await Promise.all(
    supportedLanguages.map((language) => loadLanguageResource(language))
  );
  return Object.fromEntries(
    loaded.map(({ language, resource }) => [language, { common: resource }])
  );
}
