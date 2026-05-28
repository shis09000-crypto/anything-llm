import { Image, PaperPlaneTilt, Trash, X } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import System from "@/models/system";
import showToast from "@/utils/toast";
const DB_NAME = "vector-knowledge-feedback";
const STORE_NAME = "drafts";
const DRAFT_KEY = "footer-feedback";
function openDraftDb() {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function readDraft() {
  const db = await openDraftDb();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).get(DRAFT_KEY);
    request.onsuccess = () =>
      resolve(request.result || { reason: "", images: [] });
    request.onerror = () => resolve({ reason: "", images: [] });
  });
}
async function writeDraft(draft) {
  const db = await openDraftDb();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(draft, DRAFT_KEY);
    tx.oncomplete = resolve;
    tx.onerror = resolve;
  });
}
async function clearDraft() {
  const db = await openDraftDb();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(DRAFT_KEY);
    tx.oncomplete = resolve;
    tx.onerror = resolve;
  });
}
function fileToImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve({
        uid: `${Date.now()}-${file.name}`,
        name: file.name,
        contentString: reader.result,
      });
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
export default function FeedbackModal({ onClose }) {
  const [reason, setReason] = useState("");
  const [images, setImages] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const fileInputRef = useRef(null);
  useEffect(() => {
    readDraft().then((draft) => {
      setReason(draft.reason || "");
      setImages(Array.isArray(draft.images) ? draft.images : []);
    });
  }, []);
  useEffect(() => {
    const timeout = setTimeout(() => {
      writeDraft({ reason, images });
    }, 350);
    return () => clearTimeout(timeout);
  }, [reason, images]);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);
  async function addFiles(files) {
    const imageFiles = Array.from(files || []).filter((file) =>
      file.type.startsWith("image/")
    );
    if (imageFiles.length === 0) return;
    const nextImages = await Promise.all(
      imageFiles.slice(0, 5).map(fileToImage)
    );
    setImages((current) => [...current, ...nextImages].slice(0, 5));
  }
  async function handlePaste(event) {
    const files = Array.from(event.clipboardData?.files || []);
    if (files.length > 0) await addFiles(files);
  }
  async function submit() {
    if (!reason.trim()) {
      showToast("请先填写反馈原因。", "error");
      return;
    }
    setSubmitting(true);
    const result = await System.submitFeedback({ reason, images });
    setSubmitting(false);
    if (!result.success) {
      showToast(`反馈提交失败：${result.error}`, "error");
      return;
    }
    await clearDraft();
    setReason("");
    setImages([]);
    showToast("反馈已提交，感谢你的反馈。", "success");
    onClose();
  }
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="motion-modal-open fixed inset-0 z-[10000] flex items-center justify-center bg-slate-950/55 px-4 py-6 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      aria-labelledby="feedback-modal-title"
      onMouseDown={onClose}
    >
      <div
        className="motion-modal-content w-full max-w-[620px] overflow-hidden rounded-[24px] border border-white/10 bg-theme-bg-secondary shadow-[0_28px_90px_rgba(0,0,0,0.45)] light:border-slate-200 light:bg-white light:shadow-[0_28px_90px_rgba(15,23,42,0.20)]"
        onPaste={handlePaste}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-white/10 bg-white/[0.03] px-6 py-5 light:border-slate-200 light:bg-slate-50">
          <div>
            <h2
              id="feedback-modal-title"
              className="text-lg font-bold text-theme-text-primary"
            >
              提交问题反馈
            </h2>
            <p className="mt-1 max-w-[420px] text-xs leading-5 text-theme-text-secondary">
              问题说明、截图和本地日志会一起发送给支持邮箱。
            </p>
          </div>
          <button
            type="button"
            className="motion-hover inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/5 text-theme-text-secondary hover:bg-white/10 hover:text-theme-text-primary light:border-slate-200 light:bg-white light:hover:bg-slate-100"
            onClick={onClose}
            aria-label="关闭反馈"
          >
            <X size={18} />
          </button>
        </div>
        <div className="space-y-5 px-6 py-5">
          <label className="block">
            <span className="mb-2 block text-sm font-semibold text-theme-text-primary">
              反馈原因
            </span>
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              className="min-h-[140px] w-full resize-y rounded-2xl border border-white/10 bg-theme-settings-input-bg p-4 text-sm leading-6 text-theme-settings-input-text outline-none placeholder:text-theme-settings-input-placeholder focus:border-primary-button focus:outline-none light:border-slate-200 light:bg-slate-50"
              placeholder="请描述遇到的问题、操作步骤或期望结果。"
            />
          </label>
          <div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <span className="text-sm font-semibold text-theme-text-primary">
                反馈图片
              </span>
              <span className="text-xs text-theme-text-secondary">
                最多 5 张，可直接粘贴截图
              </span>
            </div>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="motion-hover flex h-[104px] w-full flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-white/20 bg-theme-settings-input-bg text-sm font-medium text-theme-text-secondary hover:border-primary-button hover:bg-theme-bg-primary hover:text-theme-text-primary light:border-slate-300 light:bg-slate-50 light:hover:bg-sky-50"
            >
              <Image size={22} />
              <span>上传图片或粘贴截图</span>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(event) => addFiles(event.target.files)}
            />
            {images.length > 0 && (
              <div className="mt-3 grid grid-cols-3 gap-2">
                {images.map((image) => (
                  <div
                    key={image.uid}
                    className="group relative overflow-hidden rounded-xl border border-white/10 bg-black/20 light:border-slate-200"
                  >
                    <img
                      src={image.contentString}
                      alt={image.name}
                      className="h-24 w-full object-cover"
                    />
                    <button
                      type="button"
                      className="motion-hover absolute right-1 top-1 rounded-full bg-black/70 p-1 text-white opacity-0 group-hover:opacity-100"
                      onClick={() =>
                        setImages((current) =>
                          current.filter((item) => item.uid !== image.uid)
                        )
                      }
                      aria-label="删除图片"
                    >
                      <Trash size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="flex justify-end gap-3 border-t border-white/10 bg-white/[0.02] px-6 py-4 light:border-slate-200 light:bg-slate-50">
          <button
            type="button"
            className="motion-hover rounded-xl border border-white/10 bg-white/10 px-4 py-2 text-sm font-semibold text-theme-text-primary hover:bg-white/15 light:border-slate-200 light:bg-white light:hover:bg-slate-100"
            onClick={onClose}
          >
            稍后再说
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={submit}
            className="motion-hover flex items-center gap-2 rounded-xl bg-primary-button px-4 py-2 text-sm font-semibold text-white shadow-[0_10px_24px_rgba(14,165,233,0.22)] hover:bg-sky-500 disabled:cursor-wait disabled:opacity-60"
          >
            <PaperPlaneTilt size={16} weight="fill" />
            {submitting ? "正在提交..." : "提交"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
