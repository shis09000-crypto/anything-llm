/* global console, process */
import fs from "node:fs";
import path from "node:path";

const cwd = process.cwd();
const root =
  path.basename(cwd) === "frontend" && fs.existsSync(path.join(cwd, "src"))
    ? cwd
    : path.join(cwd, "frontend");
const srcDir = path.join(root, "src");
const distAssetsDir = path.join(root, "dist", "assets");
const failures = [];
const acceptedEvalRisks = [];

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(fullPath);
    return fullPath;
  });
}

function relative(file) {
  return path.relative(root, file);
}

function lineNumber(content, index) {
  return content.slice(0, index).split("\n").length;
}

function checkSourceOptionalCallDefaults() {
  const sourceFiles = walk(srcDir).filter((file) =>
    /\.(js|jsx|ts|tsx)$/.test(file)
  );
  const defaultParamOptionalCall =
    /[(,]\s*[\w$]+\s*=\s*[^)=,;{}]*\?\.[\w$]+\?\.\(/g;

  for (const file of sourceFiles) {
    const content = fs.readFileSync(file, "utf8");
    for (const match of content.matchAll(defaultParamOptionalCall)) {
      failures.push(
        `${relative(file)}:${lineNumber(
          content,
          match.index
        )} uses optional-call chaining in a default parameter; resolve it inside the function body before Vite/esbuild minification.`
      );
    }
  }
}

function checkSourceEvalUsage() {
  const sourceFiles = walk(srcDir).filter((file) =>
    /\.(js|jsx|ts|tsx)$/.test(file)
  );
  const evalPattern = /\b(?:eval\s*\(|new\s+Function\s*\()/g;

  for (const file of sourceFiles) {
    const content = fs.readFileSync(file, "utf8");
    for (const match of content.matchAll(evalPattern)) {
      failures.push(
        `${relative(file)}:${lineNumber(
          content,
          match.index
        )} uses eval/new Function; client source must remain CSP-compatible.`
      );
    }
  }
}

function classifyAcceptedEvalRisk(file, content) {
  const accepted = [];
  if (
    file.startsWith("mammoth.browser-") ||
    content.includes("mammoth") ||
    content.includes("@xmldom/xmldom")
  ) {
    accepted.push("mammoth browser bundle");
  }
  if (
    file.startsWith("PdfReader-") ||
    content.includes("pdfjs") ||
    content.includes("PDFWorker") ||
    content.includes("GlobalWorkerOptions")
  ) {
    accepted.push("pdfjs-dist worker/runtime");
  }
  if (
    file.startsWith("ort.") ||
    content.includes("onnxruntime") ||
    content.includes("ort-web") ||
    content.includes("wasmPaths")
  ) {
    accepted.push("onnxruntime-web wasm/runtime");
  }
  if (
    file.startsWith("EpubReader-") &&
    content.includes("setImmediate") &&
    content.includes("process.nextTick")
  ) {
    accepted.push("epub reader dependency setImmediate polyfill");
  }
  if (
    content.includes("registerMap") &&
    content.includes("geoJSON") &&
    content.includes("geoJson")
  ) {
    accepted.push("echarts geoJSON parser fallback");
  }
  if (
    content.includes("serenity") &&
    content.includes("opaque") &&
    content.includes("__wbg_new_no_args_1c7c842f08d00ebb")
  ) {
    accepted.push("@serenity-kit/opaque wasm-bindgen runtime");
  }
  return accepted;
}

function checkBuiltCryptoChunks() {
  if (!fs.existsSync(distAssetsDir)) {
    failures.push("dist/assets is missing; run this check after vite build.");
    return;
  }

  const jsFiles = fs
    .readdirSync(distAssetsDir)
    .filter((file) => file.endsWith(".js"));

  for (const file of jsFiles) {
    const fullPath = path.join(distAssetsDir, file);
    const content = fs.readFileSync(fullPath, "utf8");
    if (
      content.includes("tt.call(He)") ||
      /\(He=>\(He=.*?getEchartsInstance/.test(content)
    ) {
      failures.push(
        `${relative(fullPath)} contains the known broken Crypto Center minification shape that caused "He is not defined".`
      );
    }

    const hasEvalRisk =
      /\beval\s*\(/.test(content) || /\bnew\s+Function\s*\(/.test(content);
    if (!hasEvalRisk) continue;

    const accepted = classifyAcceptedEvalRisk(file, content);
    if (!accepted.length) {
      failures.push(
        `${relative(fullPath)} contains eval/new Function with no accepted third-party attribution.`
      );
      continue;
    }
    acceptedEvalRisks.push({
      file: relative(fullPath),
      acceptedBecause: accepted,
    });
  }
}

checkSourceOptionalCallDefaults();
checkSourceEvalUsage();
checkBuiltCryptoChunks();

if (failures.length) {
  console.error("Crypto build output check failed:\n");
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      success: true,
      message: "Crypto build output check passed.",
      acceptedEvalRisks,
    },
    null,
    2
  )
);
