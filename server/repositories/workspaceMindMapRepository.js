const { WorkspaceMindMaps } = require("../models/workspaceMindMaps");

const WorkspaceMindMapRepository = {
  ensureTable: (...args) => WorkspaceMindMaps.ensureTable(...args),
  cacheUserKey: (...args) => WorkspaceMindMaps.cacheUserKey(...args),
  toPayload: (...args) => WorkspaceMindMaps.toPayload(...args),
  get: (...args) => WorkspaceMindMaps.get(...args),
  where: (...args) => WorkspaceMindMaps.where(...args),
  findCached: (...args) => WorkspaceMindMaps.findCached(...args),
  create: (...args) => WorkspaceMindMaps.create(...args),
  updateViewport: (...args) => WorkspaceMindMaps.updateViewport(...args),
};

module.exports = { WorkspaceMindMapRepository };
