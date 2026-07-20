const {
  _internals: { workspaceThreadIndexChange },
} = require("../../models/workspaceThread");

describe("WorkspaceThread Sync V2 index privacy", () => {
  test.each(["add", "update", "delete"])(
    "keeps %s index events aggregate-only",
    (operation) => {
      const change = workspaceThreadIndexChange(4, operation);

      expect(change).toEqual({
        changedPaths: ["threads"],
        payloadHint: { workspaceId: 4, operation },
      });
      expect(JSON.stringify(change)).not.toMatch(/threadId|threadSlug|title/);
    }
  );
});
