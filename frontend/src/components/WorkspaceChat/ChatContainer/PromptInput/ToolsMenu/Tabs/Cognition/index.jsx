import {
  Brain,
  Gavel,
  Scales,
  Sparkle,
  TextAlignLeft,
} from "@phosphor-icons/react";
import WorkspaceCognition from "@/models/workspaceCognition";
import WorkspaceThread from "@/models/workspaceThread";
import paths from "@/utils/paths";
import showToast from "@/utils/toast";
import useToolsMenuItems from "../../useToolsMenuItems";

export default function CognitionTab({
  workspace,
  threadSlug = null,
  promptRef,
  setShowing,
  highlightedIndex,
  registerItemCount,
}) {
  const items = [
    {
      key: "viewpoint",
      icon: Brain,
      label: "保存为观点候选",
      description: "保存输入框内容，稍后由本人确认",
    },
    {
      key: "conclusion",
      icon: Sparkle,
      label: "保存为结论候选",
      description: "不会自动成为正式工作区结论",
    },
    {
      key: "dispute",
      icon: Scales,
      label: "标记争议",
      description: "在输入框插入结构化争议模板",
    },
    {
      key: "extract",
      icon: TextAlignLeft,
      label: "提取本线程认知",
      description: "立即精筛当前未处理轮次，结果进入候选区",
    },
    {
      key: "meeting",
      icon: Gavel,
      label: "启动会议模式",
      description: "前往认知中心创建或启动冻结会议包",
    },
  ];

  async function select(item) {
    const slug = workspace?.slug;
    if (!slug) return;
    const text = String(promptRef?.current?.value || "").trim();
    if (["viewpoint", "conclusion"].includes(item.key) && !text) {
      showToast("请先在输入框中写下要保存的内容。", "warning", {
        clear: true,
      });
      return;
    }
    if (item.key === "viewpoint") {
      const result = await WorkspaceCognition.createAssertion(slug, {
        assertionType: "user_position",
        statement: text,
        asPosition: true,
        stance: "supports",
      });
      showToast(
        result.success ? "已保存为观点候选，请到认知中心确认。" : result.error,
        result.success ? "success" : "error",
        { clear: true }
      );
    } else if (item.key === "conclusion") {
      const result = await WorkspaceCognition.createAssertion(slug, {
        assertionType: "conclusion",
        statement: text,
        asPosition: false,
      });
      showToast(
        result.success ? "已保存为共享结论候选。" : result.error,
        result.success ? "success" : "error",
        { clear: true }
      );
    } else if (item.key === "dispute") {
      const template = text
        ? `争议命题 A：${text}\n争议命题 B：\n分歧依据：`
        : "争议命题 A：\n争议命题 B：\n分歧依据：";
      window.dispatchEvent(
        new CustomEvent("set_prompt_input", {
          detail: {
            messageContent: template,
            writeMode: "replace",
            targetThreadSlug: threadSlug,
          },
        })
      );
      promptRef.current.focus();
    } else if (item.key === "extract") {
      if (!threadSlug) {
        showToast("当前不是可回填的聊天线程。", "warning", { clear: true });
        return;
      }
      const result = await WorkspaceCognition.flush(slug, {
        threadSlug,
        reason: "manual",
      });
      showToast(
        result.success
          ? "认知抽取任务已创建，结果会进入待确认区。"
          : result.error,
        result.success ? "success" : "error",
        { clear: true }
      );
    } else if (item.key === "meeting") {
      const { threads = [] } = await WorkspaceThread.all(slug);
      const overview = threads.find(
        (thread) => thread.thread_type === "overview"
      );
      if (!overview?.slug) {
        showToast("未找到工作区总览线程。", "error", { clear: true });
        return;
      }
      window.location.assign(
        `${paths.workspace.thread(slug, overview.slug)}?cognition=meetings`
      );
      return;
    }
    setShowing(false);
  }

  useToolsMenuItems({
    items,
    highlightedIndex,
    onSelect: select,
    registerItemCount,
  });

  return items.map((item, index) => {
    const Icon = item.icon;
    return (
      <button
        type="button"
        key={item.key}
        onClick={() => select(item)}
        className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left ${
          highlightedIndex === index
            ? "bg-zinc-700 light:bg-slate-100"
            : "hover:bg-zinc-700/50 light:hover:bg-slate-100"
        }`}
      >
        <Icon size={18} className="shrink-0 text-sky-400 light:text-sky-600" />
        <span className="min-w-0">
          <span className="block text-xs font-medium text-white light:text-slate-800">
            {item.label}
          </span>
          <span className="block truncate text-[10px] text-zinc-400 light:text-slate-500">
            {item.description}
          </span>
        </span>
      </button>
    );
  });
}
