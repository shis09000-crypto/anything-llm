const { ImageAsset } = require("../models/imageAsset");
const { createModelRepository } = require("./createModelRepository");

const ImageAssetRepository = createModelRepository(ImageAsset, {
  domain: "image-asset",
  repositoryName: "ImageAssetRepository",
});

module.exports = { ImageAssetRepository };
