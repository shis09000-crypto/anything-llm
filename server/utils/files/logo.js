const path = require("path");
const { getType } = require("mime");
const { v4 } = require("uuid");
const { DataAccessCenter } = require("../dataAccess");
const {
  FileStorageProvider,
} = require("../../providers/storage/fileStorageProvider");
const { storagePath } = require("../environment");

const SystemSettings = DataAccessCenter.adminSystem;

const LOGO_FILENAME = "anything-llm.png";
const LOGO_FILENAME_DARK = "anything-llm-dark.png";

/**
 * Checks if the filename is the default logo filename for dark or light mode.
 * @param {string} filename - The filename to check.
 * @returns {boolean} Whether the filename is the default logo filename.
 */
function isDefaultFilename(filename) {
  return [LOGO_FILENAME, LOGO_FILENAME_DARK].includes(filename);
}

function validFilename(newFilename = "") {
  return !isDefaultFilename(newFilename);
}

/**
 * Shows the logo for the current theme. In dark mode, it shows the light logo
 * and vice versa.
 * @param {boolean} darkMode - Whether the logo should be for dark mode.
 * @returns {string} The filename of the logo.
 */
function getDefaultFilename(darkMode = true) {
  return darkMode ? LOGO_FILENAME : LOGO_FILENAME_DARK;
}

async function determineLogoFilepath(defaultFilename = LOGO_FILENAME) {
  const currentLogoFilename = await SystemSettings.currentLogoFilename();
  const basePath = storagePath("assets");
  const defaultFilepath = FileStorageProvider.resolvePath(defaultFilename, {
    base: basePath,
  });

  if (currentLogoFilename && validFilename(currentLogoFilename)) {
    let customLogoPath = null;
    try {
      customLogoPath = FileStorageProvider.resolvePath(currentLogoFilename, {
        base: basePath,
      });
    } catch {
      return defaultFilepath;
    }
    return FileStorageProvider.existsPath(customLogoPath)
      ? customLogoPath
      : defaultFilepath;
  }

  return defaultFilepath;
}

function fetchLogo(logoPath) {
  let exists = false;
  try {
    exists = !!logoPath && FileStorageProvider.existsPath(logoPath);
  } catch {
    exists = false;
  }

  if (!exists) {
    return {
      found: false,
      buffer: null,
      size: 0,
      mime: "none/none",
    };
  }

  const mime = getType(logoPath);
  const buffer = FileStorageProvider.readFilePath(logoPath);
  return {
    found: true,
    buffer,
    size: buffer.length,
    mime,
  };
}

async function renameLogoFile(originalFilename = null) {
  const extname = path.extname(originalFilename) || ".png";
  const newFilename = `${v4()}${extname}`;
  const assetsDirectory = storagePath("assets");
  const originalFilepath = FileStorageProvider.resolvePath(originalFilename, {
    base: assetsDirectory,
  });

  // The output always uses a random filename.
  const outputFilepath = FileStorageProvider.resolvePath(newFilename, {
    base: assetsDirectory,
  });

  FileStorageProvider.renamePath(originalFilepath, outputFilepath);
  return newFilename;
}

async function removeCustomLogo(logoFilename = LOGO_FILENAME) {
  if (!logoFilename || !validFilename(logoFilename)) return false;
  const assetsDirectory = storagePath("assets");

  const logoPath = FileStorageProvider.resolvePath(logoFilename, {
    base: assetsDirectory,
  });
  FileStorageProvider.deletePath(logoPath, { force: true });
  return true;
}

module.exports = {
  fetchLogo,
  renameLogoFile,
  removeCustomLogo,
  validFilename,
  getDefaultFilename,
  determineLogoFilepath,
  isDefaultFilename,
  LOGO_FILENAME,
};
