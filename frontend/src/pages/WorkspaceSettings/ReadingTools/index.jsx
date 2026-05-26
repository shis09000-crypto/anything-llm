import React, { useEffect, useMemo, useState } from "react";
import DOMPurify from "dompurify";
import renderMarkdown from "@/utils/chat/markdown";

const TEXT_SIZE_KEY = "anythingllm_text_size";

const SIZE_OPTIONS = [
  {
    value: "small",
    label: "小号",
    description: "更紧凑，适合长对话快速浏览。",
    previewClass: "text-[13px]",
  },
  {
    value: "normal",
    label: "标准",
    description: "AnythingLLM 默认阅读大小。",
    previewClass: "text-[15px]",
  },
  {
    value: "large",
    label: "大号",
    description: "更舒服，适合长时间阅读和演示。",
    previewClass: "text-[17px]",
  },
];

const PREVIEW_MARKDOWN = `### 助手回答预览

这是一段 **Markdown 加粗文本**，用于确认阅读字号、行距和强调样式是否舒适。

- 列表项目会保持清晰间距
- 中文和 English text 会一起展示

> 引用块用于展示来源摘录或推理说明。

\`\`\`js
const readable = true;
\`\`\`
`;

export default function ReadingTools() {
  const [textSize, setTextSize] = useState(() => {
    return window.localStorage.getItem(TEXT_SIZE_KEY) || "normal";
  });

  const selected = useMemo(
    () =>
      SIZE_OPTIONS.find((item) => item.value === textSize) || SIZE_OPTIONS[1],
    [textSize]
  );

  useEffect(() => {
    window.localStorage.setItem(TEXT_SIZE_KEY, textSize);
    window.dispatchEvent(
      new CustomEvent("textSizeChange", { detail: textSize })
    );
  }, [textSize]);

  return (
    <div className="max-w-5xl">
      <style>
        {`
          .reading-tools-preview strong { color: inherit; font-weight: 700; }
          .reading-tools-preview pre { margin-top: 0.75rem; border-radius: 0.75rem; padding: 0.875rem; overflow: auto; }
          .reading-tools-preview blockquote { margin: 0.75rem 0; padding-left: 0.875rem; border-left: 3px solid rgba(56, 189, 248, 0.55); }
          .reading-tools-preview ul { margin: 0.75rem 0; padding-left: 1.25rem; list-style: disc; }
        `}
      </style>
      <div className="mb-8">
        <p className="text-sm font-semibold uppercase tracking-wide text-sky-400">
          阅读工具
        </p>
        <h1 className="mt-2 text-2xl font-semibold text-white light:text-slate-900">
          字体大小与阅读预览
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-white/60 light:text-slate-500">
          字体大小是本地浏览器阅读偏好，只影响当前设备上的聊天阅读体验，不会写入工作区设置。
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        <div className="rounded-xl border border-white/10 light:border-slate-200 bg-white/5 light:bg-white p-4">
          <div className="text-sm font-semibold text-white light:text-slate-800">
            字号选择
          </div>
          <div className="mt-4 space-y-3">
            {SIZE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setTextSize(option.value)}
                className={`w-full rounded-lg border px-4 py-3 text-left transition-all ${
                  textSize === option.value
                    ? "border-sky-400 bg-sky-500/15 text-sky-100 light:bg-sky-50 light:text-sky-700"
                    : "border-white/10 light:border-slate-200 text-white/75 light:text-slate-700 hover:bg-white/5 light:hover:bg-slate-50"
                }`}
              >
                <div className="font-semibold">{option.label}</div>
                <div className="mt-1 text-xs opacity-70">
                  {option.description}
                </div>
              </button>
            ))}
          </div>
        </div>

        <div className="rounded-xl border border-white/10 light:border-slate-200 bg-zinc-950/40 light:bg-white p-5">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold text-white light:text-slate-800">
                实时预览
              </div>
              <div className="mt-1 text-xs text-white/50 light:text-slate-500">
                当前选择：{selected.label}
              </div>
            </div>
          </div>

          <div className={`${selected.previewClass} space-y-4`}>
            <div className="ml-auto max-w-[78%] rounded-2xl rounded-br-sm bg-sky-600 px-4 py-3 text-white shadow-sm">
              用户消息预览：请帮我把这份资料整理成清晰的知识结构。
            </div>
            <div className="max-w-[86%] rounded-2xl rounded-bl-sm bg-white/10 light:bg-slate-50 px-4 py-3 text-white/85 light:text-slate-800 shadow-sm">
              <div
                className="reading-tools-preview leading-7"
                dangerouslySetInnerHTML={{
                  __html: DOMPurify.sanitize(renderMarkdown(PREVIEW_MARKDOWN)),
                }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
