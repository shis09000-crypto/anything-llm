import assert from "node:assert/strict";
import test from "node:test";
import { unwrapMarkdownDocumentFence } from "./markdownDocument.js";

test("unwraps a completed outer markdown document fence", () => {
  assert.equal(
    unwrapMarkdownDocumentFence("```markdown\n# Title\n\n- item\n```"),
    "# Title\n\n- item"
  );
});

test("unwraps the opening fence while the response is still streaming", () => {
  assert.equal(
    unwrapMarkdownDocumentFence("```md\n# Title\n\nPartial"),
    "# Title\n\nPartial"
  );
});

test("preserves a nested code block and removes only the outer fence", () => {
  const input =
    "```markdown\n# Title\n\n```javascript\nconst ok = true;\n```\n\nDone.\n```";
  assert.equal(
    unwrapMarkdownDocumentFence(input),
    "# Title\n\n```javascript\nconst ok = true;\n```\n\nDone."
  );
});

test("unwraps a longer document fence while preserving nested code fences", () => {
  const input = [
    "````markdown",
    "# Report",
    "",
    "```javascript",
    "const ok = true;",
    "```",
    "````",
  ].join("\n");

  assert.equal(
    unwrapMarkdownDocumentFence(input),
    ["# Report", "", "```javascript", "const ok = true;", "```"].join("\n")
  );
});

test("unwraps an incomplete longer document fence during streaming", () => {
  assert.equal(
    unwrapMarkdownDocumentFence(
      "````markdown\n## Streaming\n\n```js\nconst a = 1;"
    ),
    "## Streaming\n\n```js\nconst a = 1;"
  );
});

test("does not unwrap an intentional source-code fence", () => {
  const input = "```javascript\nconst ok = true;\n```";
  assert.equal(unwrapMarkdownDocumentFence(input), input);
});
