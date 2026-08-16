const SHORT_SOCIAL_MAX_CHARS = 32;

const SHORT_SOCIAL_MESSAGE_PATTERNS = [
  /^(?:哈+咯|哈+喽|哈+啰|嗨+|嘿+|你好|您好|早上好|上午好|中午好|下午好|晚上好|晚安)[!！。,.，~～\s]*$/iu,
  /^(?:谢谢|多谢|感谢|谢了|收到|明白了?|知道了?|好的?|好[哒的]|可以|行|没问题|再见|拜拜)[!！。,.，~～\s]*$/iu,
  /^(?:我是|我叫|你可以叫我)[\p{L}\p{N}_·•\-]{1,20}[!！。,.，~～\s]*$/u,
  /^(?:hi+|hello+|hey+|thanks?|thank\s+you|ok(?:ay)?|got\s+it|bye)[!！。,.，~～\s]*$/iu,
];

/**
 * Automatic mode normally routes every native-tool-capable model request into
 * the Agent Runtime. Short social messages do not need tools and should stay on
 * the normal chat stream so a control-plane delay cannot block a greeting.
 * Explicit @agent commands are checked by callers before this helper.
 */
function shouldBypassAutomaticAgentRouting(message = "") {
  const normalized = String(message || "")
    .normalize("NFKC")
    .trim();
  if (!normalized || [...normalized].length > SHORT_SOCIAL_MAX_CHARS)
    return false;
  return SHORT_SOCIAL_MESSAGE_PATTERNS.some((pattern) =>
    pattern.test(normalized)
  );
}

module.exports = { shouldBypassAutomaticAgentRouting };
