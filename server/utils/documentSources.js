const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { storagePath } = require("./environment");
const { safeJsonParse } = require("./http");

const SOURCE_ROOT = storagePath("document-sources");
const DOCX_SOURCE_PATTERN = /^[0-9a-f-]{36}\.docx$/i;

function ensureSourceRoot() {
  fs.mkdirSync(SOURCE_ROOT, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(SOURCE_ROOT, 0o700);
  } catch {}
  return SOURCE_ROOT;
}

function sourcePathForToken(token = "") {
  const normalized = String(token || "").trim();
  if (!DOCX_SOURCE_PATTERN.test(normalized)) return null;
  const resolved = path.resolve(SOURCE_ROOT, normalized);
  if (path.dirname(resolved) !== path.resolve(SOURCE_ROOT)) return null;
  return resolved;
}

function saveDocxSource(inputPath = "") {
  const resolvedInput = path.resolve(String(inputPath || ""));
  if (path.extname(resolvedInput).toLowerCase() !== ".docx") return null;
  if (!fs.existsSync(resolvedInput) || !fs.statSync(resolvedInput).isFile())
    return null;

  ensureSourceRoot();
  const token = `${randomUUID()}.docx`;
  const outputPath = sourcePathForToken(token);
  const tempPath = `${outputPath}.${randomUUID()}.tmp`;
  try {
    fs.copyFileSync(resolvedInput, tempPath, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(tempPath, 0o600);
    fs.renameSync(tempPath, outputPath);
    return token;
  } catch (error) {
    try {
      if (fs.existsSync(tempPath)) fs.rmSync(tempPath);
    } catch {}
    throw error;
  }
}

function readDocxSource(token = "") {
  const sourcePath = sourcePathForToken(token);
  if (!sourcePath || !fs.existsSync(sourcePath)) return null;
  const stat = fs.statSync(sourcePath);
  if (!stat.isFile()) return null;
  return fs.readFileSync(sourcePath);
}

function deleteDocxSource(token = "") {
  const sourcePath = sourcePathForToken(token);
  if (!sourcePath || !fs.existsSync(sourcePath)) return false;
  fs.rmSync(sourcePath);
  return true;
}

function sourceTokenFromMetadata(metadata = null) {
  const parsed =
    typeof metadata === "string" ? safeJsonParse(metadata, {}) : metadata || {};
  const token = parsed?.docxSource?.token;
  return DOCX_SOURCE_PATTERN.test(String(token || "")) ? token : null;
}

function cleanupDocxSources(records = []) {
  let removed = 0;
  for (const record of records || []) {
    const token = sourceTokenFromMetadata(record?.metadata ?? record);
    if (!token) continue;
    try {
      if (deleteDocxSource(token)) removed += 1;
    } catch {}
  }
  return removed;
}

module.exports = {
  SOURCE_ROOT,
  cleanupDocxSources,
  deleteDocxSource,
  readDocxSource,
  saveDocxSource,
  sourcePathForToken,
  sourceTokenFromMetadata,
};
