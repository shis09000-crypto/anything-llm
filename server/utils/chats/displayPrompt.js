const IMAGE_PRE_ANALYSIS_MARKER = "[System image pre-analysis]";

function stripSystemImagePreAnalysis(prompt = "") {
  if (typeof prompt !== "string") return prompt;
  const markerIndex = prompt.indexOf(IMAGE_PRE_ANALYSIS_MARKER);
  if (markerIndex === -1) return prompt;
  return prompt.slice(0, markerIndex).trimEnd();
}

function promptForHistory({ message = "", displayPrompt = null } = {}) {
  const candidate =
    typeof displayPrompt === "string" && displayPrompt.trim().length > 0
      ? displayPrompt
      : message;
  return stripSystemImagePreAnalysis(String(candidate ?? ""));
}

module.exports = {
  IMAGE_PRE_ANALYSIS_MARKER,
  promptForHistory,
  stripSystemImagePreAnalysis,
};
