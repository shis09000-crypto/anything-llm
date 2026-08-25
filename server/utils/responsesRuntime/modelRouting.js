const FLASH_MODEL = "deepseek-v4-flash";
const DEFAULT_FLASH_VISION_MODEL = "deepseek-v4-flash-vision-exp";

function flashVisionModel(env = process.env) {
  return (
    String(env.DEEPSEEK_FLASH_VISION_MODEL || "").trim() ||
    DEFAULT_FLASH_VISION_MODEL
  );
}

function resolveResponsesModel({
  provider = "deepseek",
  requestedModel,
  env = process.env,
} = {}) {
  const normalizedProvider = String(provider || "").trim();
  const normalizedModel = String(requestedModel || "").trim();
  const effectiveModel =
    normalizedProvider === "deepseek" && normalizedModel === FLASH_MODEL
      ? flashVisionModel(env)
      : normalizedModel;

  return {
    provider: normalizedProvider,
    requestedModel: normalizedModel,
    effectiveModel,
    flashVision: normalizedModel === FLASH_MODEL,
  };
}

module.exports = {
  DEFAULT_FLASH_VISION_MODEL,
  FLASH_MODEL,
  flashVisionModel,
  resolveResponsesModel,
};
