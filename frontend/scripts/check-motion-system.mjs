import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const srcDir = path.join(root, "src");
const centralMotionFiles = new Set([
  path.join(srcDir, "index.css"),
  path.join(srcDir, "contexts", "MotionProvider.jsx"),
  path.join(srcDir, "components", "MotionRouteOutlet", "index.jsx"),
]);

const forbiddenClassTokens = [
  /\btransition-(?:all|colors|opacity|transform)\b/g,
  /\bduration-\d+\b/g,
  /\bease-(?:linear|in|out|in-out)\b/g,
];

const forbiddenAnimatedProperties = [
  "height",
  "width",
  "top",
  "left",
  "right",
  "bottom",
  "max-height",
  "min-height",
  "max-width",
  "min-width",
  "box-shadow",
];

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(fullPath);
    return fullPath;
  });
}

function lineNumber(content, index) {
  return content.slice(0, index).split("\n").length;
}

function relative(file) {
  return path.relative(root, file);
}

function checkClassTokens(file, content, failures) {
  if (centralMotionFiles.has(file)) return;
  for (const pattern of forbiddenClassTokens) {
    for (const match of content.matchAll(pattern)) {
      failures.push(
        `${relative(file)}:${lineNumber(content, match.index)} uses "${match[0]}"; use a motion-* utility/token instead.`
      );
    }
  }
}

function checkGpuSafeCss(file, content, failures) {
  const cssBlocks = content.matchAll(/@keyframes\s+[^{]+\{([\s\S]*?)\n\}/g);
  for (const block of cssBlocks) {
    const body = block[1];
    for (const property of forbiddenAnimatedProperties) {
      const propertyPattern = new RegExp(`(^|[\\s{;])${property}\\s*:`, "m");
      if (propertyPattern.test(body)) {
        failures.push(
          `${relative(file)}:${lineNumber(content, block.index)} animates "${property}"; only opacity, transform, and light filter are motion-safe.`
        );
      }
    }
  }

  const transitionMatches = content.matchAll(
    /transition(?:-[a-z-]+)?\s*:[^;]+;/g
  );
  for (const match of transitionMatches) {
    for (const property of forbiddenAnimatedProperties) {
      if (match[0].includes(property)) {
        failures.push(
          `${relative(file)}:${lineNumber(content, match.index)} transitions "${property}"; use opacity, transform, or light filter.`
        );
      }
    }
  }
}

const files = walk(srcDir).filter((file) => /\.(css|js|jsx)$/.test(file));
const failures = [];

for (const file of files) {
  const content = fs.readFileSync(file, "utf8");
  checkClassTokens(file, content, failures);
  if (file.endsWith(".css")) checkGpuSafeCss(file, content, failures);
}

if (failures.length) {
  console.error("Motion system check failed:\n");
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("Motion system check passed.");
