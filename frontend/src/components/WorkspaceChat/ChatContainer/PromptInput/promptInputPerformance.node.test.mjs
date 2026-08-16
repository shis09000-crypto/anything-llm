import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourcePath = new URL("./index.jsx", import.meta.url);

test("prompt input keeps one stable undo debounce", async () => {
  const source = await readFile(sourcePath, "utf8");
  assert.match(
    source,
    /const debouncedSaveState = useMemo\([\s\S]*debounce\(pushUndoSnapshot, 250\)/
  );
  assert.doesNotMatch(source, /const debouncedSaveState = debounce\(/);
  assert.match(source, /debouncedSaveState\.cancel\(\)/);
});

test("prompt input is uncontrolled and IME-aware", async () => {
  const source = await readFile(sourcePath, "utf8");
  assert.match(source, /defaultValue=""/);
  assert.doesNotMatch(source, /value=\{promptInput\}/);
  assert.match(source, /onBeforeInput=\{handleBeforeInput\}/);
  assert.match(source, /insertCompositionText/);
  assert.match(source, /event\.isComposing \|\| isComposingRef\.current/);
});

test("prompt height reporting is not keyed to each character", async () => {
  const source = await readFile(sourcePath, "utf8");
  assert.match(source, /new ResizeObserver\(scheduleReport\)/);
  assert.match(source, /scheduleTextAreaResize = useCallback/);
  assert.doesNotMatch(
    source,
    /attachments\.length,[\s\S]{0,120}promptInput[\s\S]{0,120}reportInputHeight/
  );
});
