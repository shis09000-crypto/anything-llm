import test from "node:test";
import assert from "node:assert/strict";
import {
  readerFileFingerprint,
  readerFileFingerprintsMatch,
  readerLocalSourcePatch,
} from "./readerLocalSources.js";

test("readerFileFingerprint keeps stable local file identity fields", () => {
  const fingerprint = readerFileFingerprint({
    name: "book.pdf",
    size: 1024,
    lastModified: 1710000000000,
  });

  assert.deepEqual(fingerprint, {
    name: "book.pdf",
    size: 1024,
    lastModified: 1710000000000,
  });
});

test("readerFileFingerprintsMatch rejects moved or replaced files", () => {
  const original = {
    name: "book.pdf",
    size: 1024,
    lastModified: 1710000000000,
  };

  assert.equal(readerFileFingerprintsMatch(original, { ...original }), true);
  assert.equal(
    readerFileFingerprintsMatch(original, {
      ...original,
      lastModified: 1710000001000,
    }),
    false
  );
  assert.equal(
    readerFileFingerprintsMatch(original, { ...original, size: 2048 }),
    false
  );
});

test("readerLocalSourcePatch stores only lightweight bookshelf metadata", () => {
  const patch = readerLocalSourcePatch({
    id: "book-key",
    kind: "file-handle",
    fingerprint: {
      name: "book.pdf",
      size: 1024,
      lastModified: 1710000000000,
    },
    handle: { name: "not serialized into localStorage" },
  });

  assert.deepEqual(patch, {
    localSourceId: "book-key",
    localSourceKind: "file-handle",
    localFingerprint: {
      name: "book.pdf",
      size: 1024,
      lastModified: 1710000000000,
    },
  });
});
