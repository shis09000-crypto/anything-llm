function referencesRecentImage(value = "") {
  return /(?:这|那|上|前|刚才|之前|最近)(?:一|几|些|个|张)?(?:幅|张)?(?:图|图片|截图|照片)|(?:this|that|the|previous|last|above|recent)\s+(?:image|picture|photo|screenshot)/iu.test(
    String(value || "")
  );
}

function persistentHistoryAttachments(response = {}, limit = 4) {
  return (Array.isArray(response.attachments) ? response.attachments : [])
    .filter(
      (attachment) =>
        attachment?.kind === "persistent" &&
        Boolean(attachment.assetId || attachment.contentObjectId)
    )
    .slice(0, Math.max(0, Number(limit) || 0));
}

module.exports = { persistentHistoryAttachments, referencesRecentImage };
