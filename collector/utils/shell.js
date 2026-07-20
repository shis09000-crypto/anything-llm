/**
 * Patch the shell environment path to ensure the PATH is properly set for the current platform.
 * Use the CommonJS bridge exposed by the pinned packages so Jest and the
 * production Node runtime execute the same path without VM ESM flags.
 * https://github.com/sindresorhus/fix-path/issues/6
 * @returns {Promise<{[key: string]: string}>} - Environment variables from shell
 */
async function patchShellEnvironmentPath() {
  try {
    if (process.platform === "win32") return process.env;
    const fixPathModule = require("fix-path");
    const { stripVTControlCharacters } = require("util");
    const fixPath = fixPathModule.default || fixPathModule;
    fixPath();
    if (process.env.PATH)
      process.env.PATH = stripVTControlCharacters(process.env.PATH);
    console.log("Shell environment path patched successfully.");
    return process.env;
  } catch (error) {
    console.error("Failed to patch shell environment path:", error);
    return process.env;
  }
}

module.exports = {
  patchShellEnvironmentPath,
};
