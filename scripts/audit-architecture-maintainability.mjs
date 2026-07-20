import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const espree = require("../server/node_modules/espree");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseline = JSON.parse(
  fs.readFileSync(
    path.join(root, "scripts/architecture-maintainability-baseline.json"),
    "utf8"
  )
);

function lineCount(file) {
  return fs.readFileSync(file, "utf8").split(/\r?\n/).length - 1;
}

function sourceFiles(directory) {
  const results = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (["node_modules", "build", "dist", "public", "DerivedData"].includes(entry.name))
        continue;
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (/\.(?:js|jsx|cjs|mjs|swift)$/.test(entry.name)) results.push(target);
    }
  };
  if (fs.existsSync(directory)) visit(directory);
  return results;
}

function walk(node, visitor) {
  if (!node || typeof node !== "object") return;
  visitor(node);
  for (const [key, value] of Object.entries(node)) {
    if (["parent", "tokens", "comments"].includes(key)) continue;
    if (Array.isArray(value)) value.forEach((entry) => walk(entry, visitor));
    else if (value && typeof value.type === "string") walk(value, visitor);
  }
}

function isSilentFallback(argument) {
  if (!argument) return false;
  if (argument.type === "ArrayExpression" && argument.elements.length === 0)
    return true;
  return argument.type === "Literal" && [0, false].includes(argument.value);
}

function silentFallbacksInFile(file) {
  const source = fs.readFileSync(file, "utf8");
  const ast = espree.parse(source, {
    ecmaVersion: "latest",
    sourceType: "commonjs",
    loc: true,
  });
  let count = 0;
  walk(ast, (node) => {
    if (node.type !== "CatchClause") return;
    walk(node.body, (entry) => {
      if (entry.type === "ReturnStatement" && isSilentFallback(entry.argument))
        count += 1;
    });
  });
  return count;
}

const findings = [];
const governed = baseline.godFiles || {};
const roots = ["server", "frontend/src", "ios/Athena/Athena", "desktop"];
for (const relativeRoot of roots) {
  for (const file of sourceFiles(path.join(root, relativeRoot))) {
    const relative = path.relative(root, file).replaceAll(path.sep, "/");
    const lines = lineCount(file);
    const policy = governed[relative];
    if (policy && lines > Number(policy.maxLines)) {
      findings.push({
        type: "god_file_growth",
        file: relative,
        lines,
        maxLines: policy.maxLines,
      });
    } else if (!policy && lines > Number(baseline.godFileThreshold || 3000)) {
      findings.push({
        type: "unowned_god_file",
        file: relative,
        lines,
      });
    }
  }
}

let silentModelFallbacks = 0;
for (const file of sourceFiles(path.join(root, "server/models"))) {
  silentModelFallbacks += silentFallbacksInFile(file);
}
if (silentModelFallbacks > Number(baseline.silentModelFallbackMax)) {
  findings.push({
    type: "silent_model_fallback_growth",
    count: silentModelFallbacks,
    max: baseline.silentModelFallbackMax,
  });
}

const report = {
  success: findings.length === 0,
  governedGodFiles: Object.keys(governed).length,
  silentModelFallbacks,
  silentModelFallbackMax: baseline.silentModelFallbackMax,
  findings,
};
console.log(JSON.stringify(report, null, 2));
if (findings.length) process.exitCode = 1;
