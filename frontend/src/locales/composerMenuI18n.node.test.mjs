import assert from "node:assert/strict";
import test from "node:test";
import { loadAllLanguageResources, supportedLanguages } from "./resources.js";

test("all supported locales expose the complete composer add menu", async () => {
  const resources = await loadAllLanguageResources();
  const required = [
    "open",
    "file",
    "goal",
    "plan",
    "tools",
    "test",
    "flashVisionUnavailable",
    "replaceGoal",
    "abandonGoal",
    "goalCreateChip",
    "goalReplaceChip",
    "remove",
    "planCreating",
    "closePlan",
    "executePlan",
    "planRevisionPlaceholder",
    "submitPlanRevision",
    "planSteps",
  ];
  for (const language of supportedLanguages) {
    const menu =
      resources[language]?.common?.chat_window?.controls?.composerMenu;
    for (const key of required)
      assert.equal(typeof menu?.[key], "string", `${language}.${key}`);
    for (const status of [
      "drafting",
      "ready",
      "executing",
      "completed",
      "failed",
    ])
      assert.equal(
        typeof menu?.planStatus?.[status],
        "string",
        `${language}.planStatus.${status}`
      );
  }
});
