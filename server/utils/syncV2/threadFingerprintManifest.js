const {
  WorkspaceThreadRepository,
} = require("../../repositories/workspaceThreadRepository");

async function threadFingerprintManifestForRequest(options = {}) {
  return await WorkspaceThreadRepository.fingerprintManifestForRequest(options);
}

module.exports = { threadFingerprintManifestForRequest };
