import test from "node:test";
import assert from "node:assert/strict";
import {
  dedupeReaderTextSources,
  readerTextSourceIdentity,
} from "./readerTextSources.js";

test("dedupeReaderTextSources collapses duplicate source keys", () => {
  const sources = dedupeReaderTextSources([
    {
      sourceKey: "pdf:p29:a",
      delivery: "txt",
      selectedText: "first",
      citationNo: 1,
      fileName: "first.txt",
    },
    {
      sourceKey: "pdf:p29:a",
      delivery: "txt",
      selectedText: "first",
      citationNo: 9,
      tempTextTitle: "filled-later.txt",
    },
  ]);

  assert.equal(sources.length, 1);
  assert.equal(sources[0].citationNo, 1);
  assert.equal(sources[0].tempTextTitle, "filled-later.txt");
});

test("dedupeReaderTextSources collapses duplicate fallback identities", () => {
  const first = {
    delivery: "txt",
    documentTitle: "红色资本",
    locatorLabel: "Page 29",
    selectedText: "银行体系的同一段文本",
  };
  const second = {
    delivery: "txt",
    documentTitle: "红色资本",
    locatorLabel: "Page 29",
    selectedText: "银行体系的同一段文本",
    fileName: "same.txt",
  };
  const sources = dedupeReaderTextSources([first, second]);

  assert.equal(
    readerTextSourceIdentity(first),
    readerTextSourceIdentity(second)
  );
  assert.equal(sources.length, 1);
  assert.equal(sources[0].fileName, "same.txt");
});

test("dedupeReaderTextSources preserves order and first citation numbers", () => {
  const sources = dedupeReaderTextSources([
    { sourceKey: "a", delivery: "txt", selectedText: "A", citationNo: 3 },
    { sourceKey: "b", delivery: "txt", selectedText: "B", citationNo: 4 },
    { sourceKey: "a", delivery: "txt", selectedText: "A", citationNo: 99 },
  ]);

  assert.deepEqual(
    sources.map((source) => source.sourceKey),
    ["a", "b"]
  );
  assert.deepEqual(
    sources.map((source) => source.citationNo),
    [3, 4]
  );
});

test("dedupeReaderTextSources ignores invalid entries and does not invent txt cards", () => {
  const nonTextSource = { documentTitle: "PDF", page: 1 };
  const sources = dedupeReaderTextSources([
    null,
    undefined,
    "bad",
    nonTextSource,
    nonTextSource,
  ]);

  assert.equal(sources.length, 2);
  assert.equal(sources[0], nonTextSource);
  assert.equal(sources[1], nonTextSource);
});
