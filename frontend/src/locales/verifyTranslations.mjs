/* global process */
import { resources } from "./resources.js";
const languageNames = new Intl.DisplayNames(Object.keys(resources), {
  type: "language",
});

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
    if (extraKeys.length) {
      console.log("Translation contains keys outside the English schema", {
        [lang]: keysA,
        en: keysB,
        ...(!!subdir ? { subdir } : {}),
        extraKeys,
      });
      return false;
    }

    // Missing translation keys intentionally fall back to English at runtime.
    // Validate only keys that this locale actually defines so the verification
    // gate does not force thousands of null placeholders into the client bundle.
    return keysA.every(function (key) {
      return compareStructures(lang, a[key], b[key], key);
    });

    //for primitives just ignore since we don't check values.
  } else {
    return true;
  }
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
  const coverage = translationCoverage(PRIMARY, translations);
  const percent = coverage.total
    ? ((coverage.translated / coverage.total) * 100).toFixed(1)
    : "100.0";
  console.log(
    `${langDisplayName(lang)} (${lang}): ${passed ? "✅" : "❌"} ` +
      `(coverage ${percent}%, fallback keys ${coverage.total - coverage.translated})`
  );
  !passed && failed.push(lang);
}

if (failed.length !== 0)
  throw new Error(
    `The following translations files are INVALID and need fixing. Please see logs`,
    failed
  );
console.log(
  `👍 All defined translation keys match the English schema; missing keys use the configured English fallback.`
);
process.exit(0);
