const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { v4 } = require("uuid");
const { normalizePath, sanitizeFileName } = require(".");
const { storagePath } = require("../environment");

const DOCUMENT_UPLOAD_MAX_BYTES = 500 * 1024 * 1024;
const ASSET_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
const collectorHotdir = path.resolve(__dirname, "../../../collector/hotdir");
const MAX_PHYSICAL_FILENAME_BYTES = 240;

function utf8Prefix(value, maxBytes) {
  let result = "";
  let bytes = 0;
  for (const character of String(value || "")) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) break;
    result += character;
    bytes += size;
  }
  return result;
}

function isolatedDocumentFilename(file) {
  file.originalname = sanitizeFileName(
    normalizePath(Buffer.from(file.originalname, "latin1").toString("utf8"))
  );
  const prefix = `${v4()}-`;
  const rawExtension = path.extname(file.originalname);
  const extension = utf8Prefix(rawExtension, 24);
  const rawBase = rawExtension
    ? file.originalname.slice(0, -rawExtension.length)
    : file.originalname;
  const baseBudget =
    MAX_PHYSICAL_FILENAME_BYTES -
    Buffer.byteLength(prefix, "utf8") -
    Buffer.byteLength(extension, "utf8");
  const base = utf8Prefix(rawBase || "upload", Math.max(baseBudget, 1));
  return `${prefix}${base}${extension}`;
}

function uploadError(response, err, maxBytes) {
  const tooLarge = err?.code === "LIMIT_FILE_SIZE";
  const storageUnavailable = ["EACCES", "ENOENT", "EROFS"].includes(err?.code);
  console.error("[Upload] Multipart document upload failed.", {
    code: err?.code || "multipart_upload_failed",
    storageUnavailable,
  });
  return response
    .status(tooLarge ? 413 : storageUnavailable ? 503 : 500)
    .json({
      success: false,
      error: tooLarge
        ? "request_entity_too_large"
        : storageUnavailable
          ? "document_upload_storage_unavailable"
          : "invalid_file_upload",
      ...(tooLarge ? { limitClass: "multipart", maxBytes } : {}),
    })
    .end();
}

function cleanupTemporaryUploadOnResponse(request, response) {
  let finished = false;
  const cleanup = () => {
    if (finished) return;
    finished = true;
    const target = request.file?.path;
    if (!target || !fs.existsSync(target)) return;
    try {
      fs.rmSync(target);
    } catch (error) {
      console.warn("[Upload] Failed to remove temporary document upload.", {
        code: error?.code || "upload_cleanup_failed",
      });
    }
  };
  response.once("finish", cleanup);
  response.once("close", cleanup);
}

/**
 * Handle File uploads for auto-uploading.
 * Mostly used for internal GUI/API uploads.
 */
const fileUploadStorage = multer.diskStorage({
  destination: function (_, __, cb) {
    fs.mkdirSync(collectorHotdir, { recursive: true });
    cb(null, collectorHotdir);
  },
  filename: function (_, file, cb) {
    cb(null, isolatedDocumentFilename(file));
  },
});

/**
 * Handle API file upload as documents - this does not manipulate the filename
 * at all for encoding/charset reasons.
 */
const fileAPIUploadStorage = multer.diskStorage({
  destination: function (_, __, cb) {
    fs.mkdirSync(collectorHotdir, { recursive: true });
    cb(null, collectorHotdir);
  },
  filename: function (_, file, cb) {
    cb(null, isolatedDocumentFilename(file));
  },
});

// Asset storage for logos
const assetUploadStorage = multer.diskStorage({
  destination: function (_, __, cb) {
    const uploadOutput = storagePath("assets");
    fs.mkdirSync(uploadOutput, { recursive: true });
    return cb(null, uploadOutput);
  },
  filename: function (_, file, cb) {
    file.originalname = sanitizeFileName(
      normalizePath(Buffer.from(file.originalname, "latin1").toString("utf8"))
    );
    cb(null, file.originalname);
  },
});

/**
 * Handle PFP file upload as logos
 */
const pfpUploadStorage = multer.diskStorage({
  destination: function (_, __, cb) {
    const uploadOutput = storagePath("assets", "pfp");
    fs.mkdirSync(uploadOutput, { recursive: true });
    return cb(null, uploadOutput);
  },
  filename: function (req, file, cb) {
    const randomFileName = `${v4()}${path.extname(
      normalizePath(file.originalname)
    )}`;
    req.randomFileName = randomFileName;
    cb(null, randomFileName);
  },
});

/**
 * Handle Generic file upload as documents from the GUI
 * @param {Request} request
 * @param {Response} response
 * @param {NextFunction} next
 */
function handleFileUpload(request, response, next) {
  const upload = multer({
    storage: fileUploadStorage,
    limits: { fileSize: DOCUMENT_UPLOAD_MAX_BYTES },
  }).single("file");
  upload(request, response, function (err) {
    if (err) {
      return uploadError(response, err, DOCUMENT_UPLOAD_MAX_BYTES);
    }
    cleanupTemporaryUploadOnResponse(request, response);
    next();
  });
}

/**
 * Handle API file upload as documents - this does not manipulate the filename
 * at all for encoding/charset reasons.
 * @param {Request} request
 * @param {Response} response
 * @param {NextFunction} next
 */
function handleAPIFileUpload(request, response, next) {
  const upload = multer({
    storage: fileAPIUploadStorage,
    limits: { fileSize: DOCUMENT_UPLOAD_MAX_BYTES },
  }).single("file");
  upload(request, response, function (err) {
    if (err) {
      return uploadError(response, err, DOCUMENT_UPLOAD_MAX_BYTES);
    }
    cleanupTemporaryUploadOnResponse(request, response);
    next();
  });
}

/**
 * Handle logo asset uploads
 */
function handleAssetUpload(request, response, next) {
  const upload = multer({
    storage: assetUploadStorage,
    limits: { fileSize: ASSET_UPLOAD_MAX_BYTES },
  }).single("logo");
  upload(request, response, function (err) {
    if (err) {
      return uploadError(response, err, ASSET_UPLOAD_MAX_BYTES);
    }
    next();
  });
}

/**
 * Handle PFP file upload as logos
 */
function handlePfpUpload(request, response, next) {
  const upload = multer({
    storage: pfpUploadStorage,
    limits: { fileSize: ASSET_UPLOAD_MAX_BYTES },
  }).single("file");
  upload(request, response, function (err) {
    if (err) {
      return uploadError(response, err, ASSET_UPLOAD_MAX_BYTES);
    }
    next();
  });
}

module.exports = {
  ASSET_UPLOAD_MAX_BYTES,
  DOCUMENT_UPLOAD_MAX_BYTES,
  handleFileUpload,
  handleAPIFileUpload,
  handleAssetUpload,
  handlePfpUpload,
  _internals: {
    cleanupTemporaryUploadOnResponse,
    isolatedDocumentFilename,
    utf8Prefix,
  },
};
