const { WorkspaceVisualAsset } = require("../models/workspaceVisualAsset");

const WorkspaceVisualAssetRepository = {
  get DEFAULT_ROLE() {
    return WorkspaceVisualAsset.DEFAULT_ROLE;
  },
  ensureTable: (...args) => WorkspaceVisualAsset.ensureTable(...args),
  assetsRoot: (...args) => WorkspaceVisualAsset.assetsRoot(...args),
  normalizeRow: (...args) => WorkspaceVisualAsset.normalizeRow(...args),
  publicUrl: (...args) => WorkspaceVisualAsset.publicUrl(...args),
  list: (...args) => WorkspaceVisualAsset.list(...args),
  forWorkspace: (...args) => WorkspaceVisualAsset.forWorkspace(...args),
  forNode: (...args) => WorkspaceVisualAsset.forNode(...args),
  upsertFromUpload: (...args) => WorkspaceVisualAsset.upsertFromUpload(...args),
  get: (...args) => WorkspaceVisualAsset.get(...args),
  fileFor: (...args) => WorkspaceVisualAsset.fileFor(...args),
  delete: (...args) => WorkspaceVisualAsset.delete(...args),
};

module.exports = { WorkspaceVisualAssetRepository };
