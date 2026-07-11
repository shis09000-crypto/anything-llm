import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceUrl = new URL("./index.jsx", import.meta.url);

test("thread options menu is rendered as a body portal overlay", async () => {
  const source = await readFile(sourceUrl, "utf8");

  assert.match(source, /import\s+\{\s*createPortal\s*\}\s+from\s+"react-dom"/);
  assert.match(source, /return\s+createPortal\(menu,\s*document\.body\)/);
  assert.match(source, /className="fixed z-\[9999\]/);
  assert.match(source, /menuPosition\.ready \? "visible" : "hidden"/);
  assert.match(source, /addEventListener\("scroll", updatePosition, true\)/);
  assert.match(source, /addEventListener\("resize", updatePosition\)/);
});
