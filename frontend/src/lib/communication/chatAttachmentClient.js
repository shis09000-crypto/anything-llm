import { postJson } from "./apiClient";
import { BLOB_KINDS, requestBlob } from "./blobClient";

const PREUPLOAD_THRESHOLD_BYTES = 1536 * 1024;

function isImageAttachment(attachment) {
  return String(attachment?.mime || "")
    .toLowerCase()
    .startsWith("image/");
}

function attachmentBlob(attachment) {
  if (attachment?.file instanceof Blob) return Promise.resolve(attachment.file);
  const content = String(attachment?.contentString || "");
  if (content.startsWith("data:"))
    return fetch(content).then((response) => response.blob());
  const binary = atob(content);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1)
    bytes[index] = binary.charCodeAt(index);
  return Promise.resolve(
    new Blob([bytes], { type: attachment.mime || "application/octet-stream" })
  );
}

async function sha256Hex(blob) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await blob.arrayBuffer()
  );
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

export async function uploadChatAttachment(
  workspaceSlug,
  attachment,
  { signal } = {}
) {
  const blob = await attachmentBlob(attachment);
  const digest = await sha256Hex(blob);
  const { data: created } = await postJson(
    `/workspace/${workspaceSlug}/chat-attachments/uploads`,
    {
      name: attachment.name,
      mime: attachment.mime || blob.type,
      byteSize: blob.size,
      sha256: digest,
    },
    { signal, communicationScene: "workspace-chat-attachment" }
  );
  const partBytes = Number(created.partBytes);
  let partNumber = 1;
  for (let offset = 0; offset < blob.size; offset += partBytes) {
    await requestBlob(
      `/workspace/${workspaceSlug}/chat-attachments/uploads/${created.uploadId}/parts/${partNumber}`,
      {
        method: "PUT",
        body: blob.slice(offset, Math.min(offset + partBytes, blob.size)),
        rawBody: true,
        headers: { "Content-Type": "application/octet-stream" },
        signal,
        blobKind: BLOB_KINDS.chatAttachment,
        communicationScene: "workspace-chat-attachment",
      }
    );
    partNumber += 1;
  }
  const { data: completed } = await postJson(
    `/workspace/${workspaceSlug}/chat-attachments/uploads/${created.uploadId}/complete`,
    {},
    { signal, communicationScene: "workspace-chat-attachment" }
  );
  return completed.attachment;
}

export async function preuploadLargeChatAttachments(
  workspaceSlug,
  attachments = [],
  { signal } = {}
) {
  const output = [];
  for (const attachment of attachments) {
    if (attachment?.uploadId || attachment?.contentObjectId) {
      output.push(attachment);
      continue;
    }
    if (attachment?.file instanceof Blob) {
      output.push(
        await uploadChatAttachment(workspaceSlug, attachment, { signal })
      );
      continue;
    }
    const contentLength = String(attachment?.contentString || "").length;
    const estimatedBytes = Math.floor((contentLength * 3) / 4);
    if (
      !attachment?.contentString ||
      (!isImageAttachment(attachment) &&
        estimatedBytes < PREUPLOAD_THRESHOLD_BYTES)
    ) {
      output.push(attachment);
      continue;
    }
    output.push(
      await uploadChatAttachment(workspaceSlug, attachment, { signal })
    );
  }
  return output;
}
