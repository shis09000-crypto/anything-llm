const LEGACY_VISION_TOOL_NAME_PATTERNS = [
  /^vision(?:[-_]?tool)?$/i,
  /^(?:view|analy[sz]e|recognize|describe)[-_]?image(?:s)?$/i,
  /^image[-_]?(?:analysis|recognition|vision)$/i,
  /^visual[-_]?(?:analysis|recognition)$/i,
];

/**
 * Legacy image-recognition tools are intentionally kept in the repository for
 * rollback, but their schemas must never be sent to a Responses model. Native
 * image inputs are represented by `input_image` and do not require a tool.
 */
function isLegacyVisionTool(tool = {}) {
  const name = String(tool?.name || tool?.function?.name || "").trim();
  return LEGACY_VISION_TOOL_NAME_PATTERNS.some((pattern) => pattern.test(name));
}

function functionsVisibleToResponsesModel(functions = []) {
  if (!Array.isArray(functions)) return [];
  return functions.filter((tool) => !isLegacyVisionTool(tool));
}

module.exports = {
  functionsVisibleToResponsesModel,
  isLegacyVisionTool,
};
