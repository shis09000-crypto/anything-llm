import React, { useState, useEffect, memo, useRef } from "react";
import truncate from "truncate";
import { CheckCircle, X, XCircle } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import Workspace from "../../../../../../models/workspace";
import { humanFileSize, milliToHms } from "../../../../../../utils/numbers";
import PreLoader from "../../../../../Preloader";

function FileUploadProgressComponent({
  slug,
  uuid,
  file,
  setFiles,
  rejected = false,
  reason = null,
  onUploadSuccess,
  onUploadError,
  setLoading,
  setLoadingMessage,
  uploadTargetFolder = "custom-documents",
}) {
  const { t } = useTranslation();
  const [timerMs, setTimerMs] = useState(10);
  const [status, setStatus] = useState("pending");
  const [error, setError] = useState("");
  const [isFadingOut, setIsFadingOut] = useState(false);
  const uploadControllerRef = useRef(null);
  const timerRef = useRef(null);
  const cancelledRef = useRef(false);

  const fadeOut = (cb) => {
    setIsFadingOut(true);
    cb?.();
  };

  const beginFadeOut = () => {
    setIsFadingOut(false);
    setFiles((prev) => {
      return prev.filter((item) => item.uid !== uuid);
    });
  };

  const cancelUpload = (event) => {
    event.preventDefault();
    event.stopPropagation();
    cancelledRef.current = true;
    uploadControllerRef.current?.abort();
    if (timerRef.current) clearInterval(timerRef.current);
    setLoading(false);
    setLoadingMessage("");
    setFiles((prev) => prev.filter((item) => item.uid !== uuid));
  };

  useEffect(() => {
    let mounted = true;
    async function uploadFile() {
      setLoading(true);
      setLoadingMessage("Uploading file...");
      const start = Number(new Date());
      const formData = new FormData();
      formData.append("file", file, file.name);
      formData.append("folderName", uploadTargetFolder || "custom-documents");
      const uploadController = new AbortController();
      uploadControllerRef.current = uploadController;
      const timer = setInterval(() => {
        setTimerMs(Number(new Date()) - start);
      }, 100);
      timerRef.current = timer;

      // Chunk streaming not working in production so we just sit and wait
      try {
        const { response, data } = await Workspace.uploadFile(
          slug,
          formData,
          uploadTargetFolder,
          {
            communicationScene: "workspace-upload-visible",
            task: {
              label: "workspace-upload:manage-workspace-file",
              kind: "upload",
              priority: "P0",
              policy: "foreground",
              protected: true,
              abortable: true,
              intentRank: 0,
              scope: {
                route: "workspace-settings",
                surface: "workspace-upload",
                workspaceSlug: slug,
                fileName: file?.name,
              },
            },
            signal: uploadController.signal,
          }
        );
        if (!mounted) return;
        if (!response.ok) {
          const message =
            data?.error || "Document upload failed. Please try again.";
          setStatus("failed");
          onUploadError(message);
          setError(message);
        } else {
          setStatus("complete");
          onUploadSuccess();
        }
      } catch (uploadFailure) {
        if (!mounted) return;
        if (cancelledRef.current || uploadFailure?.name === "AbortError")
          return;
        const message =
          uploadFailure?.message ||
          "Document upload failed. Please check the connection and retry.";
        setStatus("failed");
        setError(message);
        onUploadError(message);
      } finally {
        clearInterval(timer);
        timerRef.current = null;
        uploadControllerRef.current = null;
        if (mounted) {
          setLoading(false);
          setLoadingMessage("");

          if (!cancelledRef.current) {
            // Begin fadeout timer to clear uploader queue.
            setTimeout(() => {
              if (!mounted) return;
              fadeOut(() => setTimeout(() => beginFadeOut(), 300));
            }, 5000);
          }
        }
      }
    }
    !!file && !rejected && uploadFile();
    return () => {
      mounted = false;
      uploadControllerRef.current?.abort();
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const cancelButton =
    status === "complete" ? null : (
      <button
        type="button"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={cancelUpload}
        aria-label={t("connectors.upload.cancel-upload", {
          defaultValue: "Cancel upload",
        })}
        title={t("connectors.upload.cancel-upload", {
          defaultValue: "Cancel upload",
        })}
        className="absolute right-1 top-1 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-black/30 text-white/80 transition-colors hover:bg-error hover:text-white focus:outline-none focus:ring-1 focus:ring-white/80 light:bg-white/80 light:text-theme-text-secondary light:hover:bg-error light:hover:text-white"
      >
        <X className="h-3.5 w-3.5" weight="bold" />
      </button>
    );

  if (rejected) {
    return (
      <div
        className={`${
          isFadingOut ? "file-upload-fadeout" : "file-upload"
        } relative h-14 px-2 py-2 pr-7 flex items-center gap-x-4 rounded-lg bg-error/40 light:bg-error/30 light:border-solid light:border-error/40 border border-transparent`}
      >
        {cancelButton}
        <div className="w-6 h-6 flex-shrink-0">
          <XCircle
            color="var(--theme-bg-primary)"
            className="w-6 h-6 stroke-white bg-error rounded-full p-1 w-full h-full"
          />
        </div>
        <div className="flex flex-col">
          <p className="text-white light:text-red-600 text-xs font-semibold">
            {truncate(file.name, 30)}
          </p>
          <p className="text-red-100 light:text-red-600 text-xs font-medium">
            {reason || "this file failed to upload"}
          </p>
        </div>
      </div>
    );
  }

  if (status === "failed") {
    return (
      <div
        className={`${
          isFadingOut ? "file-upload-fadeout" : "file-upload"
        } relative h-14 px-2 py-2 pr-7 flex items-center gap-x-4 rounded-lg bg-error/40 light:bg-error/30 light:border-solid light:border-error/40 border border-transparent`}
      >
        {cancelButton}
        <div className="w-6 h-6 flex-shrink-0">
          <XCircle
            color="var(--theme-bg-primary)"
            className="w-6 h-6 stroke-white bg-error rounded-full p-1 w-full h-full"
          />
        </div>
        <div className="flex flex-col">
          <p className="text-white light:text-red-600 text-xs font-semibold">
            {truncate(file.name, 30)}
          </p>
          <p className="text-red-100 light:text-red-600 text-xs font-medium">
            {error}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`${
        isFadingOut ? "file-upload-fadeout" : "file-upload"
      } relative h-14 px-2 py-2 pr-7 flex items-center gap-x-4 rounded-lg bg-zinc-800 light:border-solid light:border-theme-modal-border light:bg-theme-bg-sidebar border border-white/20 shadow-md`}
    >
      {cancelButton}
      <div className="w-6 h-6 flex-shrink-0">
        {status !== "complete" ? (
          <div className="flex items-center justify-center">
            <PreLoader size="6" />
          </div>
        ) : (
          <CheckCircle
            color="var(--theme-bg-primary)"
            className="w-6 h-6 stroke-white bg-green-500 rounded-full p-1 w-full h-full"
          />
        )}
      </div>
      <div className="flex flex-col">
        <p className="text-white light:text-theme-text-primary text-xs font-medium">
          {truncate(file.name, 30)}
        </p>
        <p className="text-white/80 light:text-theme-text-secondary text-xs font-medium">
          {humanFileSize(file.size)} | {milliToHms(timerMs)}
        </p>
      </div>
    </div>
  );
}

export default memo(FileUploadProgressComponent);
