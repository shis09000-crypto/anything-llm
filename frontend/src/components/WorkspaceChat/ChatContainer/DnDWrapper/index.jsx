import {
  useState,
  useEffect,
  createContext,
  useContext,
  useRef,
  useCallback,
} from "react";
import { v4 } from "uuid";
import System from "@/models/system";
import { useDropzone } from "react-dropzone";
import DndIcon from "./dnd-icon.png";
import Workspace from "@/models/workspace";
import showToast from "@/utils/toast";
import FileUploadWarningModal from "./FileUploadWarningModal";
import pluralize from "pluralize";

export const DndUploaderContext = createContext();
export const REMOVE_ATTACHMENT_EVENT = "ATTACHMENT_REMOVE";
export const CLEAR_ATTACHMENTS_EVENT = "ATTACHMENT_CLEAR";
export const PASTE_ATTACHMENT_EVENT = "ATTACHMENT_PASTED";
export const ATTACHMENTS_PROCESSING_EVENT = "ATTACHMENTS_PROCESSING";
export const ATTACHMENTS_PROCESSED_EVENT = "ATTACHMENTS_PROCESSED";
export const PARSED_FILE_ATTACHMENT_REMOVED_EVENT =
  "PARSED_FILE_ATTACHMENT_REMOVED";

/**
 * File Attachment for automatic upload on the chat container page.
 * @typedef Attachment
 * @property {string} uid - unique file id.
 * @property {File} file - native File object
 * @property {string|null} contentString - base64 encoded string of file
 * @property {string|null} previewUrl - local object URL for immediate previews.
 * @property {string|null} mime - normalized mime type for the file.
 * @property {('in_progress'|'failed'|'success'|'embedded'|'added_context')} status - the automatic upload status.
 * @property {string|null} error - Error message
 * @property {{id:string, location:string}|null} document - uploaded document details
 * @property {('attachment'|'upload')} type - The type of upload. Attachments are chat-specific, uploads go to the workspace.
 */

/**
 * @typedef {Object} ParsedFile
 * @property {number} id - The id of the parsed file.
 * @property {string} filename - The name of the parsed file.
 * @property {number} workspaceId - The id of the workspace the parsed file belongs to.
 * @property {string|null} userId - The id of the user the parsed file belongs to.
 * @property {string|null} threadId - The id of the thread the parsed file belongs to.
 * @property {string} metadata - The metadata of the parsed file.
 * @property {number} tokenCountEstimate - The estimated token count of the parsed file.
 */

export function DnDFileUploaderProvider({
  workspace,
  threadSlug = null,
  children,
}) {
  const [files, setFiles] = useState([]);
  const [ready, setReady] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [showWarningModal, setShowWarningModal] = useState(false);
  const [isEmbedding, setIsEmbedding] = useState(false);
  const [embedProgress, setEmbedProgress] = useState(0);
  const [pendingFiles, setPendingFiles] = useState([]);
  const [tokenCount, setTokenCount] = useState(0);
  const [maxTokens, setMaxTokens] = useState(Number.POSITIVE_INFINITY);
  const filesRef = useRef([]);
  const processorCheckRef = useRef(null);

  function uploadTask(label, priority = "P0", scope = {}) {
    return {
      label,
      kind: "upload",
      priority,
      policy: priority === "P0" ? "foreground" : "visible",
      protected: true,
      abortable: false,
      intentRank: 0,
      scope: {
        route: "workspace-chat",
        surface: "workspace-upload",
        workspaceSlug: workspace?.slug,
        threadSlug: threadSlug || null,
        ...scope,
      },
    };
  }

  async function ensureDocumentProcessorReady(priority = "P0") {
    if (ready === true) return true;
    if (ready === false) return false;
    if (!processorCheckRef.current) {
      processorCheckRef.current = System.checkDocumentProcessorOnline({
        communicationScene: "workspace-upload-visible",
        task: uploadTask("workspace-upload:processor-ready", priority),
      })
        .then((status) => {
          setReady(status);
          return status;
        })
        .finally(() => {
          processorCheckRef.current = null;
        });
    }
    return processorCheckRef.current;
  }

  useEffect(() => {
    filesRef.current = files;
  }, [files]);

  useEffect(() => {
    return () => {
      revokeAttachmentPreviews(filesRef.current);
    };
  }, []);

  useEffect(() => {
    window.addEventListener(REMOVE_ATTACHMENT_EVENT, handleRemove);
    window.addEventListener(CLEAR_ATTACHMENTS_EVENT, resetAttachments);
    window.addEventListener(PASTE_ATTACHMENT_EVENT, handlePastedAttachment);
    window.addEventListener(
      PARSED_FILE_ATTACHMENT_REMOVED_EVENT,
      handleRemoveParsedFile
    );

    return () => {
      window.removeEventListener(REMOVE_ATTACHMENT_EVENT, handleRemove);
      window.removeEventListener(CLEAR_ATTACHMENTS_EVENT, resetAttachments);
      window.removeEventListener(
        PARSED_FILE_ATTACHMENT_REMOVED_EVENT,
        handleRemoveParsedFile
      );
      window.removeEventListener(
        PASTE_ATTACHMENT_EVENT,
        handlePastedAttachment
      );
    };
  }, []);

  /**
   * Handles the removal of a parsed file attachment from the uploader queue.
   * Only uses the document id to remove the file from the queue
   * @param {CustomEvent<{document: ParsedFile}>} event
   */
  async function handleRemoveParsedFile(event) {
    const { document } = event.detail;
    if (!document?.id) return;
    setFiles((prev) => {
      const next = prev.filter(
        (prevFile) => prevFile.document?.id !== document.id
      );
      revokeRemovedAttachmentPreviews(prev, next);
      return next;
    });
  }

  /**
   * Remove file from uploader queue.
   * @param {CustomEvent<{uid: string}>} event
   */
  async function handleRemove(event) {
    /** @type {{uid: Attachment['uid'], document: Attachment['document']}} */
    const { uid, document } = event.detail;
    setFiles((prev) => {
      const next = prev.filter((prevFile) => prevFile.uid !== uid);
      revokeRemovedAttachmentPreviews(prev, next);
      return next;
    });
    if (!document?.location) return;
    await Workspace.deleteAndUnembedFile(workspace.slug, document.location);
  }

  /**
   * Clear queue of attached files currently in prompt box
   */
  function resetAttachments() {
    setFiles((prev) => {
      revokeAttachmentPreviews(prev);
      return [];
    });
  }

  /**
   * Turns files into attachments we can send as body request to backend
   * for a chat.
   * @returns {{name:string,mime:string,contentString:string}[]}
   */
  const parseAttachments = useCallback(() => {
    return (
      files
        ?.filter((file) => file.type === "attachment")
        ?.filter((file) => !!file.contentString)
        ?.map(
          (
            /** @type {Attachment} */
            attachment
          ) => {
            return {
              name: attachment.file.name,
              mime: attachment.mime || normalizedFileMime(attachment.file),
              contentString: attachment.contentString,
            };
          }
        ) || []
    );
  }, [files]);

  /**
   * Handle pasted attachments.
   * @param {CustomEvent<{files: File[], source?: string}>} event
   */
  function handlePastedAttachment(event) {
    const { files = [], source = "paste" } = event.detail;
    emitAttachmentDebug("attachment-event-received", {
      source,
      count: files.length,
      items: files.map(fileDebugPayload),
    });
    handleIncomingFiles(files, source);
  }

  /**
   * Handle dropped files.
   * @param {Attachment[]} acceptedFiles
   * @param {any[]} _rejections
   */
  function onDrop(acceptedFiles, _rejections) {
    setDragging(false);
    handleIncomingFiles(acceptedFiles, "drop");
  }

  /**
   * Add files to the queue immediately, then finish expensive processing.
   * @param {File[]} acceptedFiles
   * @param {string} source
   */
  async function handleIncomingFiles(acceptedFiles = [], source = "upload") {
    emitAttachmentDebug("attachment-incoming", {
      source,
      count: acceptedFiles.length,
      items: acceptedFiles.map(fileDebugPayload),
    });
    if (!acceptedFiles.length) return;
    const processorReady = await ensureDocumentProcessorReady("P0");
    if (!processorReady) {
      showToast(
        "Document processor is offline. Please try again later.",
        "error"
      );
      return;
    }
    /** @type {Attachment[]} */
    const newAccepted = acceptedFiles.map((file) =>
      createAttachmentRecord(file, source)
    );
    emitAttachmentDebug("attachment-records-created", {
      source,
      records: newAccepted.map(attachmentDebugPayload),
    });
    setFiles((prev) => [...prev, ...newAccepted]);
    emitAttachmentDebug("attachment-state-enqueue-scheduled", {
      source,
      addedCount: newAccepted.length,
    });

    window.dispatchEvent(new CustomEvent(ATTACHMENTS_PROCESSING_EVENT));
    const imageTask = processImageAttachments(newAccepted);
    const uploadTask = embedEligibleAttachments(newAccepted, {
      emitEvents: false,
    });
    Promise.allSettled([imageTask, uploadTask]).finally(() => {
      window.dispatchEvent(new CustomEvent(ATTACHMENTS_PROCESSED_EVENT));
    });
  }

  /**
   * Convert queued image attachments to request-ready base64.
   * @param {Attachment[]} newAttachments
   */
  async function processImageAttachments(newAttachments = []) {
    const imageAttachments = newAttachments.filter(
      (attachment) => attachment.type === "attachment"
    );
    if (!imageAttachments.length) return;

    await Promise.all(
      imageAttachments.map(async (attachment) => {
        const mime = attachment.mime || normalizedFileMime(attachment.file);
        emitAttachmentDebug("attachment-image-convert-start", {
          uid: attachment.uid,
          mime,
          asset: fileDebugPayload(attachment.file),
        });
        try {
          const contentString = await toBase64(attachment.file, mime);
          setFiles((prev) =>
            prev.map((prevFile) =>
              prevFile.uid === attachment.uid
                ? {
                    ...prevFile,
                    contentString,
                    mime,
                    status: "success",
                    error: null,
                  }
                : prevFile
            )
          );
          emitAttachmentDebug("attachment-image-convert-success", {
            uid: attachment.uid,
            mime,
            contentStringLength: contentString.length,
            dataPrefix: contentString.slice(0, 32),
          });
        } catch (error) {
          setFiles((prev) =>
            prev.map((prevFile) =>
              prevFile.uid === attachment.uid
                ? {
                    ...prevFile,
                    status: "failed",
                    error: error?.message || "Image processing failed",
                  }
                : prevFile
            )
          );
          emitAttachmentDebug("attachment-image-convert-failed", {
            uid: attachment.uid,
            error: error?.message || String(error),
          });
        }
      })
    );
  }

  /**
   * Embeds attachments that are eligible for embedding - basically files that are not images.
   * @param {Attachment[]} newAttachments
   */
  async function embedEligibleAttachments(newAttachments = [], options = {}) {
    const { emitEvents = true } = options;
    const uploadAttachments = newAttachments.filter(
      (attachment) => attachment.type !== "attachment"
    );
    emitAttachmentDebug("attachment-upload-embed-start", {
      count: uploadAttachments.length,
      items: uploadAttachments.map(attachmentDebugPayload),
    });
    if (!uploadAttachments.length) return;
    if (emitEvents) {
      window.dispatchEvent(new CustomEvent(ATTACHMENTS_PROCESSING_EVENT));
    }
    const promises = [];

    const { currentContextTokenCount, contextWindow } =
      await Workspace.getParsedFiles(workspace.slug, threadSlug, {
        communicationScene: "workspace-upload-visible",
        task: uploadTask("workspace-upload:parsed-files", "P0"),
      });
    const workspaceContextWindow = contextWindow
      ? Math.floor(contextWindow * Workspace.maxContextWindowLimit)
      : Number.POSITIVE_INFINITY;
    setMaxTokens(workspaceContextWindow);

    let totalTokenCount = currentContextTokenCount;
    let batchPendingFiles = [];

    for (const attachment of uploadAttachments) {
      const formData = new FormData();
      formData.append("file", attachment.file, attachment.file.name);
      formData.append("threadSlug", threadSlug || null);
      promises.push(
        Workspace.parseFile(workspace.slug, formData, {
          communicationScene: "workspace-upload-visible",
          task: uploadTask("workspace-upload:parse-file", "P0", {
            fileName: attachment.file?.name,
          }),
        }).then(async ({ response, data }) => {
          if (!response.ok) {
            const updates = {
              status: "failed",
              error: data?.error ?? null,
            };
            setFiles((prev) =>
              prev.map(
                (
                  /** @type {Attachment} */
                  prevFile
                ) =>
                  prevFile.uid !== attachment.uid
                    ? prevFile
                    : { ...prevFile, ...updates }
              )
            );
            return;
          }
          // Will always be one file in the array
          /** @type {ParsedFile} */
          const file = data.files[0];

          // Add token count for this file
          // and add it to the batch pending files
          totalTokenCount += file.tokenCountEstimate;
          batchPendingFiles.push({
            attachment,
            parsedFileId: file.id,
            tokenCount: file.tokenCountEstimate,
          });

          if (totalTokenCount > workspaceContextWindow) {
            setTokenCount(totalTokenCount);
            setPendingFiles(batchPendingFiles);
            setShowWarningModal(true);
            return;
          }

          // File is within limits, keep in parsed files
          const result = { success: true, document: file };
          const updates = {
            status: result.success ? "added_context" : "failed",
            error: result.error ?? null,
            document: result.document,
          };

          setFiles((prev) =>
            prev.map(
              (
                /** @type {Attachment} */
                prevFile
              ) =>
                prevFile.uid !== attachment.uid
                  ? prevFile
                  : { ...prevFile, ...updates }
            )
          );
        })
      );
    }

    // Wait for all promises to resolve in some way before dispatching the event to unlock the send button
    return Promise.all(promises).finally(() => {
      emitAttachmentDebug("attachment-upload-embed-finished", {
        count: uploadAttachments.length,
      });
      if (emitEvents) {
        window.dispatchEvent(new CustomEvent(ATTACHMENTS_PROCESSED_EVENT));
      }
    });
  }

  // Handle modal actions
  const handleCloseModal = async () => {
    if (!pendingFiles.length) return;

    // Delete all files from this batch
    await Workspace.deleteParsedFiles(
      workspace.slug,
      pendingFiles.map((file) => file.parsedFileId)
    );

    // Remove all files from this batch from the UI
    setFiles((prev) =>
      prev.filter(
        (prevFile) =>
          !pendingFiles.some((file) => file.attachment.uid === prevFile.uid)
      )
    );
    setShowWarningModal(false);
    setPendingFiles([]);
    setTokenCount(0);
    window.dispatchEvent(new CustomEvent(ATTACHMENTS_PROCESSED_EVENT));
  };

  const handleContinueAnyway = async () => {
    if (!pendingFiles.length) return;
    const results = pendingFiles.map((file) => ({
      success: true,
      document: { id: file.parsedFileId },
    }));

    const fileUpdates = pendingFiles.map((file, i) => ({
      uid: file.attachment.uid,
      updates: {
        status: results[i].success ? "success" : "failed",
        error: results[i].error ?? null,
        document: results[i].document,
      },
    }));

    setFiles((prev) =>
      prev.map((prevFile) => {
        const update = fileUpdates.find((f) => f.uid === prevFile.uid);
        return update ? { ...prevFile, ...update.updates } : prevFile;
      })
    );
    setShowWarningModal(false);
    setPendingFiles([]);
    setTokenCount(0);
  };

  const handleEmbed = async () => {
    if (!pendingFiles.length) return;
    setIsEmbedding(true);
    setEmbedProgress(0);

    // Embed all pending files
    let completed = 0;
    const results = await Promise.all(
      pendingFiles.map((file) =>
        Workspace.embedParsedFile(workspace.slug, file.parsedFileId, {
          communicationScene: "workspace-upload-visible",
          task: uploadTask("workspace-upload:embed-parsed-file", "P0", {
            parsedFileId: file.parsedFileId,
          }),
        }).then((result) => {
          completed++;
          setEmbedProgress(completed);
          return result;
        })
      )
    );

    // Update status for all files
    const fileUpdates = pendingFiles.map((file, i) => ({
      uid: file.attachment.uid,
      updates: {
        status: results[i].response.ok ? "embedded" : "failed",
        error: results[i].data?.error ?? null,
        document: results[i].data?.document,
      },
    }));

    setFiles((prev) =>
      prev.map((prevFile) => {
        const update = fileUpdates.find((f) => f.uid === prevFile.uid);
        return update ? { ...prevFile, ...update.updates } : prevFile;
      })
    );
    setShowWarningModal(false);
    setPendingFiles([]);
    setTokenCount(0);
    setIsEmbedding(false);
    window.dispatchEvent(new CustomEvent(ATTACHMENTS_PROCESSED_EVENT));
    showToast(
      `${pendingFiles.length} ${pluralize("file", pendingFiles.length)} embedded successfully`,
      "success"
    );
  };

  return (
    <DndUploaderContext.Provider
      value={{
        files,
        ready,
        dragging,
        setDragging,
        onDrop,
        parseAttachments,
        ensureDocumentProcessorReady,
      }}
    >
      <FileUploadWarningModal
        show={showWarningModal}
        onClose={handleCloseModal}
        onContinue={handleContinueAnyway}
        onEmbed={handleEmbed}
        tokenCount={tokenCount}
        maxTokens={maxTokens}
        fileCount={pendingFiles.length}
        isEmbedding={isEmbedding}
        embedProgress={embedProgress}
      />
      {children}
    </DndUploaderContext.Provider>
  );
}

export default function DnDFileUploaderWrapper({ children }) {
  const { onDrop, ready, dragging, setDragging, ensureDocumentProcessorReady } =
    useContext(DndUploaderContext);
  const { getRootProps, getInputProps } = useDropzone({
    onDrop,
    disabled: ready === false,
    noClick: true,
    noKeyboard: true,
    onDragEnter: () => {
      setDragging(true);
      ensureDocumentProcessorReady("P1");
    },
    onDragLeave: () => setDragging(false),
  });

  return (
    <div
      className={`relative flex flex-col h-full w-full md:mt-0 mt-[40px] p-[1px]`}
      {...getRootProps()}
    >
      <div
        hidden={!dragging}
        className="absolute top-0 w-full h-full bg-dark-text/90 light:bg-[#C2E7FE]/90 rounded-2xl border-[4px] border-white z-[9999]"
      >
        <div className="w-full h-full flex justify-center items-center rounded-xl">
          <div className="flex flex-col gap-y-[14px] justify-center items-center">
            <img
              src={DndIcon}
              width={69}
              height={69}
              alt="Drag and drop icon"
            />
            <p className="text-white text-[24px] font-semibold">Add anything</p>
            <p className="text-white text-[16px] text-center">
              Drop a file or image here to attach it to your <br />
              workspace auto-magically.
            </p>
          </div>
        </div>
      </div>
      <input id="dnd-chat-file-uploader" {...getInputProps()} />
      {children}
    </div>
  );
}

const IMAGE_EXTENSION_MIME_MAP = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
};

function emitAttachmentDebug(label, payload = {}) {
  if (typeof window === "undefined" || typeof CustomEvent === "undefined")
    return;
  window.dispatchEvent(
    new CustomEvent("athena:chat-turn-debug", {
      detail: {
        label,
        at: new Date().toISOString(),
        payload,
      },
    })
  );
}

function fileDebugPayload(file = {}) {
  return {
    name: file?.name || null,
    type: file?.type || null,
    size: file?.size || 0,
    lastModified: file?.lastModified || null,
  };
}

function attachmentDebugPayload(attachment = {}) {
  return {
    uid: attachment.uid,
    type: attachment.type,
    status: attachment.status,
    mime: attachment.mime || null,
    hasPreviewUrl: !!attachment.previewUrl,
    hasContentString: !!attachment.contentString,
    asset: fileDebugPayload(attachment.file),
  };
}

function fileExtension(file = {}) {
  const name = String(file?.name || "");
  const extension = name.includes(".") ? name.split(".").pop() : "";
  return String(extension || "").toLowerCase();
}

function sourceImpliesImage(source = "") {
  return ["camera", "photos", "photo", "image"].includes(String(source));
}

function inferredImageMime(file = {}, source = "") {
  const existingType = String(file?.type || "").toLowerCase();
  if (existingType.startsWith("image/")) return existingType;
  const extensionMime = IMAGE_EXTENSION_MIME_MAP[fileExtension(file)];
  if (extensionMime) return extensionMime;
  return sourceImpliesImage(source) ? "image/jpeg" : null;
}

function normalizedFileMime(file = {}, source = "") {
  return (
    file?.type || inferredImageMime(file, source) || "application/octet-stream"
  );
}

function isImageAttachmentFile(file = {}, source = "") {
  return !!inferredImageMime(file, source);
}

function createObjectPreviewUrl(file) {
  if (typeof URL === "undefined" || !URL.createObjectURL) return null;
  try {
    return URL.createObjectURL(file);
  } catch {
    return null;
  }
}

function revokeAttachmentPreview(attachment = {}) {
  if (!attachment?.previewUrl) return;
  if (typeof URL === "undefined" || !URL.revokeObjectURL) return;
  try {
    URL.revokeObjectURL(attachment.previewUrl);
  } catch {
    // best effort cleanup only
  }
}

function revokeAttachmentPreviews(attachments = []) {
  attachments.forEach(revokeAttachmentPreview);
}

function revokeRemovedAttachmentPreviews(previous = [], next = []) {
  const nextUids = new Set(next.map((attachment) => attachment.uid));
  previous.forEach((attachment) => {
    if (!nextUids.has(attachment.uid)) revokeAttachmentPreview(attachment);
  });
}

function createAttachmentRecord(file, source = "upload") {
  if (isImageAttachmentFile(file, source)) {
    return {
      uid: v4(),
      file,
      contentString: null,
      previewUrl: createObjectPreviewUrl(file),
      mime: normalizedFileMime(file, source),
      status: "in_progress",
      error: null,
      type: "attachment",
    };
  }

  return {
    uid: v4(),
    file,
    contentString: null,
    previewUrl: null,
    mime: normalizedFileMime(file, source),
    status: "in_progress",
    error: null,
    type: "upload",
  };
}

/**
 * Convert image types into Base64 strings for requests.
 * @param {File} file
 * @param {string|null} fallbackMime
 * @returns {Promise<string>}
 */
async function toBase64(file, fallbackMime = null) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const base64String = result.includes(",") ? result.split(",")[1] : result;
      const mime = fallbackMime || normalizedFileMime(file);
      resolve(`data:${mime};base64,${base64String}`);
    };
    reader.onerror = (error) => reject(error);
    reader.readAsDataURL(file);
  });
}
