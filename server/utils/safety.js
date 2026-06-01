const fs = require("fs");
const path = require("path");
const { safeJsonParse } = require("./http");

class AppError extends Error {
  constructor(
    message,
    { code = "APP_ERROR", status = 500, context = {} } = {}
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.context = context;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      context: this.context,
    };
  }
}

function errorReport(error, context = {}) {
  return {
    code: error?.code || error?.name || "ERROR",
    message: error?.message || String(error || "Unknown error"),
    context,
  };
}

function timestampSuffix() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function safeJsonParseWithReport(value, fallback = null, context = {}) {
  try {
    return {
      ok: true,
      value: safeJsonParse(value, fallback),
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      value: fallback,
      error: errorReport(error, context),
    };
  }
}

function quarantineCorruptFile(filePath, error = null) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const corruptPath = `${filePath}.corrupt.${timestampSuffix()}`;
  try {
    fs.renameSync(filePath, corruptPath);
    return corruptPath;
  } catch (renameError) {
    console.warn(
      `[safety] Failed to quarantine corrupt file ${filePath}: ${renameError.message}`,
      error?.message || ""
    );
    return null;
  }
}

function safeReadJsonFile(filePath, fallback = null, options = {}) {
  const { quarantine = true, context = {} } = options;
  try {
    if (!fs.existsSync(filePath)) {
      return {
        ok: false,
        value: fallback,
        error: {
          code: "FILE_NOT_FOUND",
          message: "JSON file does not exist.",
          context: { filePath, ...context },
        },
      };
    }

    const raw = fs.readFileSync(filePath, "utf8");
    return { ok: true, value: JSON.parse(raw), error: null };
  } catch (error) {
    const corruptPath = quarantine
      ? quarantineCorruptFile(filePath, error)
      : null;
    return {
      ok: false,
      value: fallback,
      error: {
        code: "JSON_READ_FAILED",
        message: error.message,
        context: { filePath, corruptPath, ...context },
      },
    };
  }
}

function atomicWriteJsonFile(filePath, value, options = {}) {
  const { spaces = 2, encoding = "utf8" } = options;
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );
  try {
    fs.writeFileSync(tempPath, JSON.stringify(value, null, spaces), encoding);
    fs.renameSync(tempPath, filePath);
    return { ok: true, filePath };
  } catch (error) {
    try {
      if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
    } catch {}
    return {
      ok: false,
      error: {
        code: "ATOMIC_JSON_WRITE_FAILED",
        message: error.message,
        context: { filePath },
      },
    };
  }
}

async function withTimeout(promiseOrFactory, timeoutMs, options = {}) {
  const { code = "TIMEOUT", message = `Timed out after ${timeoutMs}ms` } =
    options;
  let timeoutId = null;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new AppError(message, { code, context: { timeoutMs } })),
      timeoutMs
    );
  });
  try {
    const promise =
      typeof promiseOrFactory === "function"
        ? promiseOrFactory()
        : promiseOrFactory;
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function retryWithBackoff(fn, options = {}) {
  const {
    retries = 2,
    baseDelayMs = 250,
    maxDelayMs = 2_000,
    shouldRetry = () => true,
  } = options;
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn({ attempt });
    } catch (error) {
      lastError = error;
      if (attempt >= retries || !shouldRetry(error)) break;
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

function safeFileMove(sourcePath, destinationPath, options = {}) {
  const { overwrite = false } = options;
  if (!sourcePath || !destinationPath)
    throw new AppError("Missing move path.", { code: "INVALID_MOVE_PATH" });
  if (!fs.existsSync(sourcePath))
    throw new AppError("Source file does not exist.", {
      code: "SOURCE_FILE_NOT_FOUND",
      status: 404,
      context: { sourcePath },
    });
  if (!overwrite && fs.existsSync(destinationPath))
    throw new AppError("Destination file already exists.", {
      code: "DESTINATION_EXISTS",
      status: 409,
      context: { destinationPath },
    });
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });

  try {
    fs.renameSync(sourcePath, destinationPath);
    return { ok: true, method: "rename", destinationPath };
  } catch (error) {
    if (error.code !== "EXDEV") throw error;
    fs.copyFileSync(sourcePath, destinationPath);
    fs.unlinkSync(sourcePath);
    return { ok: true, method: "copy_unlink", destinationPath };
  }
}

module.exports = {
  AppError,
  atomicWriteJsonFile,
  errorReport,
  retryWithBackoff,
  safeFileMove,
  safeJsonParseWithReport,
  safeReadJsonFile,
  withTimeout,
};
