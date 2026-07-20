/* global console, process */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

export const BUDGETS = Object.freeze({
  initialRawBytes: Math.floor(1.2 * 1024 * 1024),
  initialGzipBytes: 350 * 1024,
  lazyRawBytes: 800 * 1024,
  hardChunkRawBytes: 2 * 1024 * 1024,
});

const LARGE_LAZY_EXCEPTIONS = Object.freeze([
  {
    module: "node_modules/elkjs/",
    reason: "MindMap layout engine",
  },
  {
    module: "node_modules/echarts/",
    reason: "advanced charting engine",
  },
  {
    module: "node_modules/highlight.js/",
    reason: "syntax language pack",
  },
]);

function frontendRoot(cwd = process.cwd()) {
  return path.basename(cwd) === "frontend" ? cwd : path.join(cwd, "frontend");
}

function readBuildHtml(root) {
  for (const name of ["_index.html", "index.html"]) {
    const file = path.join(root, "dist", name);
    if (fs.existsSync(file)) return { file, html: fs.readFileSync(file, "utf8") };
  }
  throw new Error("bundle_budget_build_html_missing");
}

export function initialScriptPaths(html) {
  const paths = new Set();
  for (const match of html.matchAll(
    /<(?:script|link)\b[^>]*(?:src|href)=["']([^"']+\.js)["'][^>]*>/gi
  )) {
    const tag = match[0];
    if (tag.startsWith("<script") || /rel=["']modulepreload["']/i.test(tag)) {
      paths.add(match[1].replace(/^\//, ""));
    }
  }
  return [...paths];
}

function collectTreeNames(node, output = [], parentPath = "") {
  const currentPath =
    typeof node?.name === "string"
      ? parentPath
        ? `${parentPath}/${node.name}`
        : node.name
      : parentPath;
  if (currentPath) output.push(currentPath);
  for (const child of node?.children || [])
    collectTreeNames(child, output, currentPath);
  return output;
}

function inspectorChunkModules(root) {
  const file = path.join(root, "bundleinspector.html");
  if (!fs.existsSync(file)) return new Map();
  const content = fs.readFileSync(file, "utf8");
  const marker = "const data = ";
  const start = content.indexOf(marker);
  if (start < 0) return new Map();
  const jsonStart = start + marker.length;
  const jsonEnd = content.indexOf(";\n", jsonStart);
  if (jsonEnd < 0) return new Map();

  const data = JSON.parse(content.slice(jsonStart, jsonEnd));
  return new Map(
    (data.tree?.children || [])
      .filter((node) => node.name?.endsWith(".js"))
      .map((node) => [node.name, collectTreeNames(node)])
  );
}

export function classifyLargeLazyChunk(chunkPath, modules = []) {
  for (const exception of LARGE_LAZY_EXCEPTIONS) {
    if (modules.some((module) => module.includes(exception.module))) {
      return exception.reason;
    }
  }
  return null;
}

function formatBytes(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

export function inspectBundle(root = frontendRoot()) {
  const { html } = readBuildHtml(root);
  const dist = path.join(root, "dist");
  const initialPaths = initialScriptPaths(html);
  if (initialPaths.length === 0) throw new Error("bundle_budget_initial_script_missing");

  const initial = initialPaths.map((relativePath) => {
    const file = path.join(dist, relativePath);
    if (!fs.existsSync(file)) throw new Error(`bundle_budget_asset_missing:${relativePath}`);
    const source = fs.readFileSync(file);
    return {
      path: relativePath,
      rawBytes: source.byteLength,
      gzipBytes: zlib.gzipSync(source, { level: 9 }).byteLength,
    };
  });

  const initialRawBytes = initial.reduce((sum, item) => sum + item.rawBytes, 0);
  const initialGzipBytes = initial.reduce((sum, item) => sum + item.gzipBytes, 0);
  const inspector = inspectorChunkModules(root);
  const jsFiles = fs
    .readdirSync(path.join(dist, "assets"))
    .filter((name) => name.endsWith(".js"))
    .map((name) => ({
      name,
      relativePath: `assets/${name}`,
      rawBytes: fs.statSync(path.join(dist, "assets", name)).size,
    }));
  const initialSet = new Set(initialPaths);
  const exceptions = [];
  const failures = [];

  if (initialRawBytes > BUDGETS.initialRawBytes) {
    failures.push(
      `initial raw JS ${formatBytes(initialRawBytes)} exceeds ${formatBytes(BUDGETS.initialRawBytes)}`
    );
  }
  if (initialGzipBytes > BUDGETS.initialGzipBytes) {
    failures.push(
      `initial gzip JS ${formatBytes(initialGzipBytes)} exceeds ${formatBytes(BUDGETS.initialGzipBytes)}`
    );
  }

  for (const chunk of jsFiles) {
    if (chunk.rawBytes > BUDGETS.hardChunkRawBytes) {
      failures.push(
        `${chunk.relativePath} ${formatBytes(chunk.rawBytes)} exceeds hard chunk limit ${formatBytes(BUDGETS.hardChunkRawBytes)}`
      );
      continue;
    }
    if (initialSet.has(chunk.relativePath) || chunk.rawBytes <= BUDGETS.lazyRawBytes) continue;
    const reason = classifyLargeLazyChunk(
      chunk.relativePath,
      inspector.get(chunk.relativePath) || []
    );
    if (!reason) {
      failures.push(
        `${chunk.relativePath} ${formatBytes(chunk.rawBytes)} exceeds lazy chunk limit without an approved module exception`
      );
    } else {
      exceptions.push({
        path: chunk.relativePath,
        rawBytes: chunk.rawBytes,
        reason,
      });
    }
  }

  return {
    budgets: BUDGETS,
    initial,
    initialRawBytes,
    initialGzipBytes,
    exceptions,
    largestChunkRawBytes: Math.max(0, ...jsFiles.map((item) => item.rawBytes)),
    failures,
  };
}

function main() {
  const result = inspectBundle();
  console.log(
    JSON.stringify(
      {
        status: result.failures.length === 0 ? "pass" : "fail",
        initialRawBytes: result.initialRawBytes,
        initialGzipBytes: result.initialGzipBytes,
        largestChunkRawBytes: result.largestChunkRawBytes,
        approvedLargeLazyChunks: result.exceptions,
        failures: result.failures,
      },
      null,
      2
    )
  );
  if (result.failures.length > 0) process.exitCode = 1;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  main();
}
