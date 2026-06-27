export const IMAGE_PRE_ANALYSIS_MARKER = "[System image pre-analysis]";

export function stripSystemImagePreAnalysis(prompt = "") {
  if (typeof prompt !== "string") return prompt;
  const markerIndex = prompt.indexOf(IMAGE_PRE_ANALYSIS_MARKER);
  if (markerIndex === -1) return prompt;
  return prompt.slice(0, markerIndex).trimEnd();
}

export function displayPrompt(prompt = "") {
  return stripSystemImagePreAnalysis(prompt);
}
