const crypto = require("crypto");
const {
  formatMessagesForTools,
} = require("../agents/aibitat/providers/helpers/tooled");
const {
  clearUploadFlights,
  compatibleImage,
  decodeDataUrl,
  deepSeekBaseUrl,
  resolveImageInput,
  uploadDeepSeekFile,
} = require("../imageAssets/adapter");

function imageError(code, cause = null) {
  const error = new Error(code);
  error.code = code;
  error.httpStatus = 400;
  if (cause) error.cause = cause;
  return error;
}

function imageUrlValue(part = {}) {
  if (typeof part.image_url === "string") return part.image_url;
  return part.image_url?.url || "";
}

function persistentRef(part = {}) {
  return {
    kind: "persistent",
    assetId: String(part.asset_id || part.assetId || ""),
    attachmentRefId:
      part.attachment_ref_id || part.attachmentRefId || undefined,
    name: part.name || "image",
    mimeType: part.mime_type || part.mimeType || "application/octet-stream",
    byteSize: Number(part.byte_size || part.byteSize || 0),
    sha256: String(part.sha256 || ""),
    detail: "original",
  };
}

function ephemeralRef(part = {}, imageUrl) {
  const decoded = decodeDataUrl(imageUrl);
  return {
    kind: "ephemeral",
    source: part.image_source || part.source || "runtime_capture",
    dataUrl: imageUrl,
    mimeType: decoded.mimeType,
    sha256: crypto.createHash("sha256").update(decoded.buffer).digest("hex"),
    capturedAt: part.captured_at || new Date().toISOString(),
    detail: "original",
    retention: "turn",
  };
}

function remoteRef(part = {}, imageUrl) {
  return {
    kind: "remote",
    url: imageUrl,
    mimeType: part.mime_type || part.mimeType || undefined,
    detail: "original",
  };
}

async function nativeContent(content, role, options = {}) {
  if (!Array.isArray(content)) return content ?? "";
  const output = [];
  const bindingIds = [];
  const assetIds = [];
  let sawImage = false;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (["text", "input_text"].includes(part.type)) {
      output.push({ type: "input_text", text: String(part.text || "") });
      continue;
    }
    if (!["image_url", "input_image"].includes(part.type)) {
      output.push(part);
      continue;
    }
    if (!["user", "tool-output"].includes(role))
      throw imageError("responses_image_role_invalid");
    sawImage = true;
    let resolved;
    if (part.file_id) {
      resolved = { type: "input_image", file_id: String(part.file_id) };
    } else if (part.asset_id || part.assetId) {
      resolved = await (options.resolveImage || resolveImageInput)(
        persistentRef(part),
        options
      );
    } else {
      const imageUrl = imageUrlValue(part);
      if (!imageUrl) throw imageError("responses_image_source_missing");
      resolved = await (options.resolveImage || resolveImageInput)(
        imageUrl.startsWith("data:")
          ? ephemeralRef(part, imageUrl)
          : remoteRef(part, imageUrl),
        options
      );
    }
    if (resolved.bindingId) bindingIds.push(resolved.bindingId);
    if (resolved.assetId) assetIds.push(resolved.assetId);
    const {
      bindingId: _bindingId,
      assetId: _assetId,
      ...providerInput
    } = resolved;
    if (resolved.assetId) providerInput.athena_asset_id = resolved.assetId;
    output.push(providerInput);
  }
  return { content: output, sawImage, bindingIds, assetIds };
}

function toolOutputContent(message) {
  const content = [{ type: "input_text", text: String(message.content ?? "") }];
  for (const attachment of message.attachments || []) {
    const assetId = attachment.assetId || attachment.contentObjectId;
    if (attachment.kind === "persistent" || assetId) {
      content.push({
        type: "input_image",
        asset_id: assetId,
        attachment_ref_id:
          attachment.attachmentRefId || attachment.attachmentId,
        name: attachment.name || "image",
        mime_type: attachment.mimeType || attachment.mime,
        byte_size: attachment.byteSize,
        sha256: attachment.sha256,
      });
      continue;
    }
    const imageUrl = attachment.dataUrl || attachment.contentString;
    if (imageUrl) {
      content.push({
        type: "input_image",
        image_url: imageUrl,
        image_lifetime: "turn",
        image_source: attachment.source || "runtime_capture",
      });
      continue;
    }
    if (attachment.kind === "remote" || attachment.url) {
      content.push({ type: "input_image", image_url: attachment.url });
    }
  }
  return content;
}

function isEphemeralAttachment(attachment = {}) {
  const imageUrl = attachment.dataUrl || attachment.contentString || "";
  return (
    attachment.kind === "ephemeral" ||
    attachment.retention === "turn" ||
    String(imageUrl).startsWith("data:image/")
  );
}

function capEphemeralToolFrames(messages = [], maxFrames = 2) {
  const output = messages.map((message) => ({
    ...message,
    ...(Array.isArray(message.attachments)
      ? { attachments: [...message.attachments] }
      : {}),
  }));
  let retained = 0;
  for (let index = output.length - 1; index >= 0; index -= 1) {
    if (!Array.isArray(output[index].attachments)) continue;
    output[index].attachments = output[index].attachments.filter(
      (attachment) => {
        if (!isEphemeralAttachment(attachment)) return true;
        retained += 1;
        return retained <= Math.max(0, Number(maxFrames) || 0);
      }
    );
    if (!output[index].attachments.length) delete output[index].attachments;
  }
  return output;
}

async function prepareResponsesInput(messages = [], options = {}) {
  const formatted = capEphemeralToolFrames(
    formatMessagesForTools(messages, {
      injectReasoningContent: true,
    }),
    options.maxEphemeralFrames ?? 2
  );
  const input = [];
  const bindingIds = [];
  const assetIds = [];
  let sawImage = false;
  for (const { reasoning_content: _reasoning, ...message } of formatted) {
    if (message.role === "tool") {
      const converted = await nativeContent(
        toolOutputContent(message),
        "tool-output",
        options
      );
      if (converted.sawImage) sawImage = true;
      bindingIds.push(...converted.bindingIds);
      assetIds.push(...converted.assetIds);
      input.push({
        type: "function_call_output",
        call_id: message.tool_call_id,
        output:
          converted.sawImage || converted.content.length > 1
            ? converted.content
            : String(message.content ?? ""),
      });
      continue;
    }
    if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
      if (message.content)
        input.push({
          type: "message",
          role: "assistant",
          content: message.content,
        });
      for (const toolCall of message.tool_calls) {
        input.push({
          type: "function_call",
          call_id: toolCall.id,
          name: toolCall.function?.name || "",
          arguments: toolCall.function?.arguments || "{}",
        });
      }
      continue;
    }
    const converted = await nativeContent(
      message.content,
      message.role,
      options
    );
    const content = converted?.content || converted;
    if (converted?.sawImage) sawImage = true;
    bindingIds.push(...(converted?.bindingIds || []));
    assetIds.push(...(converted?.assetIds || []));
    input.push({ type: "message", role: message.role, content });
  }
  const uniqueBindingIds = [...new Set(bindingIds)];
  const uniqueAssetIds = [...new Set(assetIds)];
  return {
    input,
    sawImage,
    ...(uniqueBindingIds.length ? { bindingIds: uniqueBindingIds } : {}),
    ...(uniqueAssetIds.length ? { assetIds: uniqueAssetIds } : {}),
  };
}

// Retained for migration tests and emergency legacy mode only. Normal chat
// images resolve through an internal asset id and the persistent mapping table.
async function uploadDeepSeekImage({ dataUrl, name = "image" }, options = {}) {
  const decoded = decodeDataUrl(dataUrl);
  const image = await compatibleImage({ buffer: decoded.buffer, name });
  const uploaded = await uploadDeepSeekFile(image, options);
  return uploaded.providerFileId;
}

function deepSeekFilesUrl(env = process.env) {
  return `${deepSeekBaseUrl(env)}/files`;
}

function clearProviderFileCache() {
  clearUploadFlights();
}

module.exports = {
  clearProviderFileCache,
  compatibleImage,
  decodeDataUrl,
  deepSeekFilesUrl,
  capEphemeralToolFrames,
  prepareResponsesInput,
  uploadDeepSeekImage,
};
