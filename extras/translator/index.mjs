import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadAllLanguageResources,
  supportedLanguages,
} from "../../frontend/src/locales/resources.js";
import dotenv from "../../server/node_modules/dotenv/lib/main.js";
import OpenAI from "../../server/node_modules/openai/index.mjs";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const LOCALE_DIR = path.join(ROOT, "frontend/src/locales");
dotenv.config({ path: path.join(ROOT, "server/.env") });
const BATCH_SIZE = Math.max(
  10,
  Number(process.env.TRANSLATION_BATCH_SIZE || 80)
);
const CONCURRENCY = Math.max(
  1,
  Math.min(6, Number(process.env.TRANSLATION_CONCURRENCY || 3))
);
const MODEL = process.env.TRANSLATION_MODEL || "deepseek-v4-flash";
let resources;
let english;
let client;

function flatten(value, prefix = [], output = {}) {
  for (const [key, child] of Object.entries(value || {})) {
    const pathName = [...prefix, key];
    if (child && typeof child === "object" && !Array.isArray(child))
      flatten(child, pathName, output);
    else output[JSON.stringify(pathName)] = child;
  }
  return output;
}

function setNestedValue(target, pathName, value) {
  const parts = JSON.parse(pathName);
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    cursor[part] ||= {};
    cursor = cursor[part];
  }
  cursor[parts.at(-1)] = value;
}

function tokens(value) {
  return {
    placeholders: String(value ?? "").match(/\{\{[^}]+\}\}/g) || [],
    tags: String(value ?? "").match(/<\/?[a-zA-Z][a-zA-Z0-9]*\s*\/?>/g) || [],
  };
}

function validTranslation(source, translated) {
  if (typeof source === "string" && !source.trim())
    return translated === source;
  if (typeof translated !== "string" || !translated.trim()) return false;
  const sourceTokens = tokens(source);
  const translatedTokens = tokens(translated);
  return (
    sourceTokens.placeholders.join("|") ===
      translatedTokens.placeholders.join("|") &&
    sourceTokens.tags.join("|") === translatedTokens.tags.join("|")
  );
}

function localeFilename(language) {
  return { "zh-tw": "zh_TW", pt: "pt_BR", vi: "vn" }[language] || language;
}

function writeTranslations(language, translations) {
  const filename = path.join(LOCALE_DIR, localeFilename(language), "common.js");
  fs.writeFileSync(
    filename,
    `// Generated against the English schema. Keep every key translated.\nconst TRANSLATIONS = ${JSON.stringify(translations, null, 2)}\n\nexport default TRANSLATIONS;\n`
  );
}

function parseResponseObject(raw = "") {
  const cleaned = String(raw)
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const parsed = JSON.parse(cleaned);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Translation response was not a JSON object.");
  return parsed;
}

async function translateBatch(language, entries, attempt = 1) {
  const languageName = new Intl.DisplayNames(["en"], {
    type: "language",
  }).of(language);
  const source = Object.fromEntries(entries);
  try {
    const response = await client.responses.create({
      model: MODEL,
      instructions: [
        `You are a professional English to ${languageName} UI localization translator.`,
        "Return only one JSON object with exactly the same keys as the input.",
        "Translate every value naturally and consistently for a software interface.",
        "Keep product names, API names, file formats, commands, URLs, Markdown, emoji, {{placeholders}}, and HTML-like tags unchanged where appropriate.",
        "Do not add explanations or omit entries.",
      ].join(" "),
      input: JSON.stringify(source),
      max_output_tokens: 16_000,
      text: { format: { type: "json_object" } },
      thinking: { type: "disabled" },
    });
    const translated = parseResponseObject(response.output_text);
    const output = {};
    for (const [key, sourceText] of entries) {
      if (!Object.prototype.hasOwnProperty.call(translated, key))
        throw new Error(`Translation response omitted ${key}.`);
      if (!validTranslation(sourceText, translated[key]))
        throw new Error(`Translation response corrupted tokens for ${key}.`);
      output[key] = translated[key].trim();
    }
    return output;
  } catch (error) {
    if (attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
      return translateBatch(language, entries, attempt + 1);
    }
    if (entries.length > 1) {
      const midpoint = Math.ceil(entries.length / 2);
      const first = await translateBatch(language, entries.slice(0, midpoint));
      const second = await translateBatch(language, entries.slice(midpoint));
      return { ...first, ...second };
    }
    throw error;
  }
}

async function translateLanguage(
  language,
  { repairEnglishFallbacks = false } = {}
) {
  const translations = resources[language].common;
  const sourceMap = flatten(english);
  const translationMap = flatten(translations);
  const candidates = Object.entries(sourceMap).filter(([key, sourceText]) => {
    if (typeof sourceText !== "string") return false;
    if (!sourceText.trim()) return false;
    if (["@agent", "/reset"].includes(sourceText)) return false;
    const current = translationMap[key];
    return (
      current === null ||
      current === undefined ||
      !validTranslation(sourceText, current) ||
      (repairEnglishFallbacks && current === sourceText)
    );
  });
  if (!candidates.length) {
    console.log(`[${language}] complete; no translation work required.`);
    return;
  }

  console.log(
    `[${language}] translating ${candidates.length} entries with ${MODEL}.`
  );
  for (let offset = 0; offset < candidates.length; offset += BATCH_SIZE) {
    const batch = candidates.slice(offset, offset + BATCH_SIZE);
    const translated = await translateBatch(language, batch);
    for (const [key, value] of Object.entries(translated))
      setNestedValue(translations, key, value);
    writeTranslations(language, translations);
    console.log(
      `[${language}] ${Math.min(offset + batch.length, candidates.length)}/${candidates.length}`
    );
  }
}

async function mapConcurrent(items, worker) {
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const item = items[cursor++];
      await worker(item);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, run));
}

async function main() {
  resources = await loadAllLanguageResources();
  english = resources.en.common;
  if (!process.env.DEEPSEEK_API_KEY)
    throw new Error("DEEPSEEK_API_KEY is required for translation generation.");
  client = new OpenAI({
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseURL: "https://api.deepseek.com/v1",
  });

  const args = new Set(process.argv.slice(2));
  const repairEnglishFallbacks = args.has("--repair-english-fallbacks");
  const requested = process.argv
    .slice(2)
    .find((argument) => !argument.startsWith("--"));
  const languages = args.has("--all")
    ? supportedLanguages.filter((language) => language !== "en")
    : requested
      ? [requested]
      : [];

  if (!languages.length)
    throw new Error(
      "Provide a language code or --all. Add --repair-english-fallbacks to replace English placeholders."
    );
  for (const language of languages) {
    if (!resources[language] || language === "en")
      throw new Error(`Unsupported translation language: ${language}`);
  }

  await mapConcurrent(languages, (language) =>
    translateLanguage(language, { repairEnglishFallbacks })
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
