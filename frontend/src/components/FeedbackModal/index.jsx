import { Image, PaperPlaneTilt, Trash, X } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
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
  return (
    <div className="fixed inset-0 z-[999] flex items-center justify-center bg-black/70 backdrop-blur-sm px-4">
      {" "}
      <div
        className="w-full max-w-[560px] rounded-lg border border-white/10 bg-theme-bg-secondary shadow-2xl"
        onPaste={handlePaste}
      >
        {" "}
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          {" "}
          <div>
            {" "}
            <h2 className="text-white text-base font-bold">
              提交问题反馈
            </h2>{" "}
            <p className="text-description text-xs mt-1">
              {" "}
              问题说明、截图和本地日志会一起发送给支持邮箱。{" "}
            </p>{" "}
          </div>{" "}
          <button
            type="button"
            className="rounded-full p-2 text-white hover:bg-white/10"
            onClick={onClose}
            aria-label="关闭反馈"
          >
            {" "}
            <X size={18} />{" "}
          </button>{" "}
        </div>{" "}
        <div className="px-5 py-4 space-y-4">
          {" "}
          <label className="block">
            {" "}
            <span className="block text-sm font-semibold text-white mb-2">
              {" "}
              反馈原因{" "}
            </span>{" "}
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              className="min-h-[132px] w-full resize-y rounded-lg border-none bg-theme-settings-input-bg p-3 text-sm text-white outline-none focus:outline-primary-button"
              placeholder="请描述遇到的问题、操作步骤或期望结果。"
            />{" "}
          </label>{" "}
          <div>
            {" "}
            <div className="flex items-center justify-between mb-2">
              {" "}
              <span className="text-sm font-semibold text-white">
                反馈图片
              </span>{" "}
              <span className="text-xs text-description">
                {" "}
                最多 5 张，可直接粘贴截图{" "}
              </span>{" "}
            </div>{" "}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex h-[88px] w-full items-center justify-center gap-2 rounded-lg border border-dashed border-white/20 bg-theme-settings-input-bg text-sm text-description hover:border-primary-button hover:text-white"
            >
              {" "}
              <Image size={20} /> 上传图片或粘贴截图{" "}
            </button>{" "}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(event) => addFiles(event.target.files)}
            />{" "}
            {images.length > 0 && (
              <div className="mt-3 grid grid-cols-3 gap-2">
                {" "}
                {images.map((image) => (
                  <div
                    key={image.uid}
                    className="group relative overflow-hidden rounded-lg border border-white/10 bg-black/20"
                  >
                    {" "}
                    <img
                      src={image.contentString}
                      alt={image.name}
                      className="h-24 w-full object-cover"
                    />{" "}
                    <button
                      type="button"
                      className="absolute right-1 top-1 rounded-full bg-black/70 p-1 text-white opacity-0 motion-hover group-hover:opacity-100"
                      onClick={() =>
                        setImages((current) =>
                          current.filter((item) => item.uid !== image.uid)
                        )
                      }
                      aria-label="删除图片"
                    >
                      {" "}
                      <Trash size={14} />{" "}
                    </button>{" "}
                  </div>
                ))}{" "}
              </div>
            )}{" "}
          </div>{" "}
        </div>{" "}
        <div className="flex justify-end gap-3 border-t border-white/10 px-5 py-4">
          {" "}
          <button
            type="button"
            className="rounded-lg bg-white/10 px-4 py-2 text-sm font-semibold text-white hover:bg-white/15"
            onClick={onClose}
          >
            {" "}
            稍后再说{" "}
          </button>{" "}
          <button
            type="button"
            disabled={submitting}
            onClick={submit}
            className="flex items-center gap-2 rounded-lg bg-primary-button px-4 py-2 text-sm font-semibold text-white hover:bg-secondary disabled:opacity-60"
          >
            {" "}
            <PaperPlaneTilt size={16} weight="fill" />{" "}
            {submitting ? "正在提交..." : "提交"}{" "}
          </button>{" "}
        </div>{" "}
      </div>{" "}
    </div>
  );
}
