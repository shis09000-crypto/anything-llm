import assert from "node:assert/strict";
import test from "node:test";
import {
  loadAllLanguageResources,
  supportedLanguages,
} from "./resources.js";

test("every supported language receives the English-shaped External MCP map", async () => {
  const resources = await loadAllLanguageResources();
  for (const language of supportedLanguages) {
    const common = resources[language]?.common;
    assert.equal(typeof common?.settings?.["api-keys"], "string", language);
    assert.equal(typeof common?.externalMcp?.title, "string", language);
    assert.equal(typeof common?.externalMcp?.create?.submit, "string", language);
    assert.equal(
      typeof common?.externalMcp?.consent?.authorize,
      "string",
      language
    );
    assert.equal(
      typeof common?.externalMcp?.legacy?.description,
      "string",
      language
    );
  }
});
