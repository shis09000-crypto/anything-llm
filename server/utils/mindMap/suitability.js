function mindMapSuitability(sourceText = "") {
  const text = String(sourceText || "").trim();
  const words = text.split(/\s+/).filter(Boolean);
  const sentences = text.split(/[.!?。！？\n]+/).filter((part) => part.trim());
  const headings = (text.match(/^#{1,4}\s+.+$/gm) || []).length;
  const bullets = (text.match(/^\s*[-*+]\s+|\n\s*\d+\.\s+/gm) || []).length;
  const timelineTerms = (
    text.match(
      /\b(before|after|then|next|finally|timeline|phase|step|q[1-4]|year|month|week)\b/gi
    ) || []
  ).length;
  const comparisonTerms = (
    text.match(
      /\b(compare|versus|vs\.?|pros|cons|tradeoff|similar|different|advantage|disadvantage)\b/gi
    ) || []
  ).length;
  const processTerms = (
    text.match(
      /\b(cause|effect|because|therefore|depends|leads to|workflow|pipeline|process|system|architecture)\b/gi
    ) || []
  ).length;
  const entities = new Set(text.match(/\b[A-Z][a-zA-Z0-9]{2,}\b/g) || []);
  const score =
    (words.length >= 160 ? 2 : words.length >= 80 ? 1 : 0) +
    (sentences.length >= 8 ? 1 : 0) +
    (headings >= 2 ? 2 : headings) +
    (bullets >= 3 ? 2 : bullets >= 1 ? 1 : 0) +
    (timelineTerms >= 3 ? 1 : 0) +
    (comparisonTerms >= 2 ? 1 : 0) +
    (processTerms >= 2 ? 1 : 0) +
    (entities.size >= 6 ? 1 : 0);

  if (score >= 4) {
    return {
      status: "recommended",
      score,
      canForce: false,
      recommendation: "这段内容结构和概念密度足够，适合生成思维导图。",
      reasons: {
        wordCount: words.length,
        sentenceCount: sentences.length,
        headings,
        bullets,
        entityCount: entities.size,
      },
    };
  }

  return {
    status: "not_recommended",
    score,
    canForce: true,
    recommendation:
      "这段内容较短或结构较线性，默认不建议生成思维导图。你可以查看简短总结，或选择强制生成。",
    reasons: {
      wordCount: words.length,
      sentenceCount: sentences.length,
      headings,
      bullets,
      entityCount: entities.size,
    },
  };
}

module.exports = { mindMapSuitability };
