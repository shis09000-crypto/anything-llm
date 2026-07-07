#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();
const configPath = path.join(repoRoot, "docs/athena-module-boundaries.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const sourceExtensions = [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"];
const ignoredDirs = new Set([
  ".git",
  "node_modules",
  "storage",
  "public",
  "dist",
  "build",
  "swagger",
]);

function toPosix(filePath) {
  return filePath.split(path.sep).join("/");
}

function relative(filePath) {
  return toPosix(path.relative(repoRoot, filePath));
}

function startsWithAny(filePath, prefixes = []) {
  return prefixes.some((prefix) => {
    if (prefix.endsWith(".js") || prefix.endsWith(".jsx") || prefix.endsWith(".mjs")) {
      return filePath === prefix;
    }
    return filePath.startsWith(prefix);
  });
}

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignoredDirs.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, files);
      continue;
    }
    if (!sourceExtensions.includes(path.extname(entry.name))) continue;
    files.push(fullPath);
  }
  return files;
}

function resolveWithExtensions(candidate) {
  const candidates = [
    candidate,
    ...sourceExtensions.map((extension) => `${candidate}${extension}`),
    ...sourceExtensions.map((extension) => path.join(candidate, `index${extension}`)),
  ];
  return candidates.find((filePath) => fs.existsSync(filePath) && fs.statSync(filePath).isFile()) || null;
}

function resolveImport(importer, specifier) {
  if (specifier.startsWith("@/")) {
    return resolveWithExtensions(path.join(repoRoot, "frontend/src", specifier.slice(2)));
  }
  if (!specifier.startsWith(".")) return null;
  return resolveWithExtensions(path.resolve(path.dirname(importer), specifier));
}

function extractSpecifiers(source) {
  const specifiers = new Set();
  const patterns = [
    /import\s+(?:[^'"]+\s+from\s+)?["']([^"']+)["']/g,
    /import\s*\(\s*["']([^"']+)["']\s*\)/g,
    /require\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      specifiers.add(match[1]);
    }
  }
  return [...specifiers];
}

const files = walk(repoRoot);
const moduleCounts = Object.fromEntries(config.modules.map((module) => [module.id, 0]));
const violations = [];
let importCount = 0;

for (const filePath of files) {
  const from = relative(filePath);
  for (const module of config.modules) {
    if (startsWithAny(from, module.paths)) moduleCounts[module.id] += 1;
  }

  const source = fs.readFileSync(filePath, "utf8");
  for (const specifier of extractSpecifiers(source)) {
    const resolved = resolveImport(filePath, specifier);
    if (!resolved) continue;
    importCount += 1;
    const target = relative(resolved);

    for (const rule of config.rules) {
      if (!startsWithAny(from, rule.from)) continue;
      if (!startsWithAny(target, rule.deny)) continue;
      violations.push({
        rule: rule.id,
        severity: rule.severity,
        from,
        target,
        specifier,
        reason: rule.reason,
      });
    }
  }
}

const errors = violations.filter((violation) => violation.severity === "error");
const warnings = violations.filter((violation) => violation.severity !== "error");

console.log("Athena module boundary audit");
console.log(`Config: ${relative(configPath)}`);
console.log(`Files scanned: ${files.length}`);
console.log(`Local imports resolved: ${importCount}`);
console.log("");
console.log("Module file counts:");
for (const module of config.modules) {
  console.log(`- ${module.id}: ${moduleCounts[module.id]} files`);
}

if (violations.length) {
  console.log("");
  console.log("Boundary findings:");
  for (const violation of violations) {
    console.log(
      `- [${violation.severity}] ${violation.rule}: ${violation.from} -> ${violation.target} (${violation.specifier})`
    );
    console.log(`  ${violation.reason}`);
  }
}

console.log("");
console.log(
  `Result: ${errors.length} error(s), ${warnings.length} warning(s).`
);

if (errors.length) process.exit(1);
