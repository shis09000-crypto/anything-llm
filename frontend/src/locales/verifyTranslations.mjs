/* global process */
import { loadAllLanguageResources } from "./resources.js";
let languageNames;

function langDisplayName(lang) {
  return languageNames.of(lang);
}

function compareStructures(lang, a, b, subdir = null) {
  //if a and b aren't the same type, they can't be equal
  if (typeof a !== typeof b && a !== null && b !== null) {
    console.log("Invalid type comparison", [
      {
        lang,
        a: typeof a,
        b: typeof b,
        values: {
          a,
          b,
        },
        ...(!!subdir ? { subdir } : {}),
      },
    ]);
    return false;
  }

  // Need the truthy guard because
  // typeof null === 'object'
  if (a && typeof a === "object") {
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
        console.log("Invalid array schema", {
          lang,
          translatedLength: Array.isArray(a) ? a.length : null,
          englishLength: Array.isArray(b) ? b.length : null,
          ...(!!subdir ? { subdir } : {}),
        });
        return false;
      }
      return a.every((value, index) =>
        compareStructures(
          lang,
          value,
          b[index],
          `${subdir || "array"}[${index}]`
        )
      );
    }

    var keysA = Object.keys(a).sort(),
      keysB = Object.keys(b).sort();

    const extraKeys = keysA.filter((key) => !keysB.includes(key));
    const missingKeys = keysB.filter((key) => !keysA.includes(key));
    if (extraKeys.length || missingKeys.length) {
      console.log("Translation does not match the English schema", {
        [lang]: keysA,
        en: keysB,
        ...(!!subdir ? { subdir } : {}),
        extraKeys,
        missingKeys,
      });
      return false;
    }

    return keysB.every(function (key) {
      return compareStructures(lang, a[key], b[key], key);
    });

    //for primitives just ignore since we don't check values.
  } else {
    return true;
  }
}

function tokenSet(value, pattern) {
  return [...String(value ?? "").matchAll(pattern)].map((match) => match[0]);
}

function validateTranslationValue(lang, translated, english, path = "") {
  if (english && typeof english === "object") {
    if (Array.isArray(english)) {
      return english.every((value, index) =>
        validateTranslationValue(
          lang,
          translated?.[index],
          value,
          `${path}[${index}]`
        )
      );
    }
    return Object.entries(english).every(([key, value]) =>
      validateTranslationValue(
        lang,
        translated?.[key],
        value,
        path ? `${path}.${key}` : key
      )
    );
  }

  if (typeof english === "string" && !english.trim())
    return translated === english;

  if (
    translated === null ||
    translated === undefined ||
    (typeof translated === "string" && !translated.trim())
  ) {
    console.log("Missing translation value", { lang, path });
    return false;
  }

  if (typeof english !== "string" || typeof translated !== "string")
    return true;

  const placeholders = tokenSet(english, /\{\{[^}]+\}\}/g);
  const translatedPlaceholders = tokenSet(translated, /\{\{[^}]+\}\}/g);
  const tags = tokenSet(english, /<\/?[a-zA-Z][a-zA-Z0-9]*\s*\/?>/g);
  const translatedTags = tokenSet(
    translated,
    /<\/?[a-zA-Z][a-zA-Z0-9]*\s*\/?>/g
  );
  if (
    placeholders.join("|") !== translatedPlaceholders.join("|") ||
    tags.join("|") !== translatedTags.join("|")
  ) {
    console.log("Translation changed required interpolation tokens", {
      lang,
      path,
      placeholders,
      translatedPlaceholders,
      tags,
      translatedTags,
    });
    return false;
  }
  return true;
}

function translationCoverage(source, target) {
  if (!source || typeof source !== "object") {
    return { total: 1, translated: target == null ? 0 : 1 };
  }
  let total = 0;
  let translated = 0;
  for (const [key, value] of Object.entries(source)) {
    const child = translationCoverage(value, target?.[key]);
    total += child.total;
    translated += child.translated;
  }
  return { total, translated };
}

async function main() {
  const resources = await loadAllLanguageResources();
  languageNames = new Intl.DisplayNames(Object.keys(resources), {
    type: "language",
  });
  const failed = [];
  const TRANSLATIONS = {};
  for (const [lang, { common }] of Object.entries(resources))
    TRANSLATIONS[lang] = common;
  const PRIMARY = { ...TRANSLATIONS["en"] };
  delete TRANSLATIONS["en"];

  console.log(
    `The following translation files will be verified: [${Object.keys(
      TRANSLATIONS
    ).join(",")}]`
  );
  for (const [lang, translations] of Object.entries(TRANSLATIONS)) {
    const passed = compareStructures(lang, translations, PRIMARY);
    const valuesPassed = validateTranslationValue(lang, translations, PRIMARY);
    const coverage = translationCoverage(PRIMARY, translations);
    const percent = coverage.total
      ? ((coverage.translated / coverage.total) * 100).toFixed(1)
      : "100.0";
    console.log(
      `${langDisplayName(lang)} (${lang}): ${passed && valuesPassed ? "✅" : "❌"} ` +
        `(coverage ${percent}%, fallback keys ${coverage.total - coverage.translated})`
    );
    (!passed || !valuesPassed) && failed.push(lang);
  }

  if (failed.length !== 0)
    throw new Error(
      `The following translations files are INVALID and need fixing. Please see logs`,
      failed
    );
  console.log(`👍 Every locale fully matches the English translation schema.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
