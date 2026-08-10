/* global process */
import assert from "node:assert/strict";
import MarkdownIt from "markdown-it";
import {
  stabilizeStreamingMarkdown,
  streamingMarkdownSegments,
} from "../src/utils/chat/streamingMarkdownProjection.js";

const markdown = new MarkdownIt({ html: false });
const fixtures = [
  "# 标题\n\n这是 **粗体** 和 *斜体*。",
  "- 第一项\n- 第二项\n- 第三项",
  "| 列一 | 列二 |\n| --- | --- |\n| 值一 | 值二 |",
  "[Athena](https://athenallm.online) 与 `inline code`",
  "```js\nconst value = '*';\nconsole.log(value);\n```",
  "> 中文引用\n\n日本語と English",
];

for (const fixture of fixtures) {
  let streamed = "";
  for (const character of Array.from(fixture)) {
    streamed += character;
    const stabilized = stabilizeStreamingMarkdown(streamed);
    assert.doesNotThrow(() => markdown.render(stabilized));
    assert.equal(
      /<script|onerror\s*=|javascript:/i.test(markdown.render(stabilized)),
      false
    );
  }
  assert.equal(
    stabilizeStreamingMarkdown(fixture),
    fixture,
    "complete Markdown must not be altered by the streaming projection"
  );
  assert.equal(
    markdown.render(stabilizeStreamingMarkdown(fixture)),
    markdown.render(fixture),
    "the terminal streaming projection must match the formal render"
  );
}

assert.equal(stabilizeStreamingMarkdown("**生成中"), "**生成中**");
assert.equal(stabilizeStreamingMarkdown("`生成中"), "`生成中`");
assert.equal(stabilizeStreamingMarkdown("```js\nconst a = 1"), "```js\nconst a = 1\n```");
assert.deepEqual(streamingMarkdownSegments("稳定段落\n\n生成中"), {
  stable: "稳定段落\n\n",
  live: "生成中",
});

process.stdout.write("streaming markdown projection checks passed\n");
