import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditDirectNetworkUsages,
  hasDirectNetworkUsage,
  isAllowedDirectNetworkUsage,
} from "./networkCoverageAudit.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(here, "../..");

async function walk(dir, files = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath, files);
      continue;
    }
    if (!/\.(js|jsx|ts|tsx)$/.test(entry.name)) continue;
    if (/\.node\.test\.m?js$|\.test\./.test(entry.name)) continue;
    files.push(fullPath);
  }
  return files;
}

test("direct network calls stay inside communication clients or explicit allowlist", async () => {
  const files = await walk(srcRoot);
  const entries = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    source.split(/\r?\n/).forEach((line, index) => {
      if (!hasDirectNetworkUsage(line)) return;
      entries.push({
        file,
        line,
        lineNumber: index + 1,
      });
    });
  }

  const violations = auditDirectNetworkUsages(entries);
  assert.deepEqual(
    violations.map((entry) => ({
      file: path.relative(srcRoot, entry.file),
      lineNumber: entry.lineNumber,
      line: entry.line.trim(),
    })),
    []
  );
  assert.equal(
    isAllowedDirectNetworkUsage("frontend/src/lib/communication/apiClient.js"),
    true
  );
});
