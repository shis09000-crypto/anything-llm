import React, {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import Workspace from "@/models/workspace";
import System from "@/models/system";
import FileAccessPolicy from "@/models/fileAccessPolicy";
import AgentSkillWhitelist from "@/models/agentSkillWhitelist";
import QuizCard from "@/components/WorkspaceChat/ChatContainer/ChatHistory/QuizCard";
import AppButton from "@/components/lib/AppButton";
import {
  ATTACHMENTS_PROCESSED_EVENT,
  ATTACHMENTS_PROCESSING_EVENT,
  CLEAR_ATTACHMENTS_EVENT,
  DndUploaderContext,
  DnDFileUploaderProvider,
  PASTE_ATTACHMENT_EVENT,
  REMOVE_ATTACHMENT_EVENT,
} from "@/components/WorkspaceChat/ChatContainer/DnDWrapper";
import { openImageLightbox } from "@/components/ImageLightbox";
import { AuthContext } from "@/AuthContext";
import paths from "@/utils/paths";
import { guardGlobalRefresh } from "@/utils/globalRefreshPolicy";
import { confirmSignOut } from "@/utils/authSignOutConfirm";
import MemoryBlocksCard from "@/pages/UserSettings/AccountSettings/MemoryBlocksCard";
import ContactMethodsCard from "@/pages/UserSettings/AccountSettings/ContactMethodsCard";
import LoginSecurityCard from "@/pages/UserSettings/AccountSettings/LoginSecurityCard";
import PasskeysCard from "@/pages/UserSettings/AccountSettings/PasskeysCard";
import SessionsDevicesCard from "@/pages/UserSettings/AccountSettings/SessionsDevicesCard";
import NotificationsCard from "@/pages/UserSettings/AccountSettings/NotificationsCard";
import DataPrivacyCard from "@/pages/UserSettings/AccountSettings/DataPrivacyCard";
import PersonalizationCard from "@/pages/UserSettings/AccountSettings/PersonalizationCard";
import AdminPanel from "@/pages/UserSettings/AccountSettings/AdminPanel";
import AccountSettingsApi from "@/pages/UserSettings/AccountSettings/accountSettingsApi";
import { AccountSettingsDataProvider } from "@/pages/UserSettings/AccountSettings/AccountSettingsDataProvider";
import {
  ChatThreadDraftProviderBoundary,
  useChatDraft,
  useChatThreadDrafts,
  useThreadActivity,
  useThreadActivitySnapshot,
} from "@/contexts/ChatThreadDraftProvider";
import {
  hasAssistantAfterSubmitted,
  historyIncludesSubmittedMessage,
  messageWithinSubmittedWindow,
} from "@/utils/chat/mobilePendingIdentity";
import { createTurnId } from "@/utils/chat/turns";
import { mergeMobileMessagesWithDraft } from "@/utils/chat/mobileMessageMerge";
import { sortThreadsForDisplay } from "@/utils/workspaceThreads";
import { SyncCenterProvider } from "@/hooks/useSyncCenterEvents";
import { useWorkspaceSyncEvents } from "@/hooks/useWorkspaceSyncEvents";
import usePfp from "@/hooks/usePfp";
import useTimeoutProgress from "@/hooks/useTimeoutProgress";
import StreamingMarkdown from "@/components/Markdown/StreamingMarkdown";
import { displayPrompt } from "@/utils/chat/displayPrompt";
import {
  MOBILE_PWA_HISTORY_HYDRATE_MARKER,
  mergeMobileHydratedHistory,
  mobileHistoryHydrationTargets,
  mobileHistoryPayloadSummary,
  mobileHistoryRequestOptions,
} from "@/utils/chat/mobileHistoryHydration";
import { nFormatter } from "@/utils/numbers";
import { API_BASE } from "@/utils/constants";
import { setAuthToken } from "@/utils/authTokenStorage";
import { setLoginUserActionNow } from "@/utils/userAction";
import { setStoredAuthUser } from "@/utils/authUserStorage";
import {
  MOBILE_COMPOSER_FALLBACK_INSET,
  mobileChatPanePaddingBottom,
  mobileNewMessageButtonBottom,
  normalizeMobileComposerInset,
} from "@/utils/mobileChatLayout";
import {
  getPreferredLocalZkDevice,
  listLocalZkDevices,
} from "@/utils/zkLoginStorage";
import { postJson } from "@/lib/communication/apiClient";
import showToast from "@/utils/toast";
import {
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  USERNAME_PATTERN,
} from "@/utils/username";
import {
  detectAuthCapability,
  passkeyCapabilityDescription,
} from "@/utils/authCapability";
import "@/pages/UserSettings/AccountSettings/styles.css";
import "./styles.css";
import { GlassCard } from "@developer-hub/liquid-glass";
import {
  ArrowUp,
  ArrowsClockwise,
  Bell,
  BookOpen,
  Camera,
  CaretDown,
  CaretLeft,
  CaretRight,
  ChatsCircle,
  Check,
  CircleNotch,
  ClockCounterClockwise,
  Copy,
  DeviceMobile,
  DotsThree,
  EnvelopeSimple,
  File as FileIcon,
  Fingerprint,
  GearSix,
  GitFork,
  ImageSquare,
  List,
  LockKey,
  Microphone,
  Note,
  NotePencil,
  Paperclip,
  PencilSimple,
  Plus,
  PushPinSimple,
  Question,
  Shield,
  ShieldCheck,
  SpeakerHigh,
  SpeakerSlash,
  Sparkle,
  SignOut,
  TextT,
  Trash,
  UserCircle,
  UserCircleGear,
  X,
} from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import { canSeeAdmin } from "@/utils/authz";
import { useNavigate } from "react-router-dom";

const DEVICE_WIDTH = 430;
const DEVICE_HEIGHT = 932;
const CLOUD_MOBILE_APP_URL = "https://athenallm.online";
const USER_MESSAGE_COLLAPSE_LENGTH = 120;
const MOBILE_HISTORY_BOOTSTRAP_LIMIT = 20;
const MOBILE_FILE_ACCESS_MODES = [
  FileAccessPolicy.modes.sandbox,
  FileAccessPolicy.modes.authorized,
  FileAccessPolicy.modes.open,
];

const FALLBACK_WORKSPACE_SLUG = "mock-workspace";

const mockThreads = [
  {
    id: "inheritance",
    workspaceSlug: FALLBACK_WORKSPACE_SLUG,
    threadSlug: "inheritance",
    workspace: "我的工作区",
    title: "继承人的疲惫与困惑",
    subtitle: "长期记忆 · 深度对话",
  },
  {
    id: "molecule",
    workspaceSlug: "mock-molecule",
    threadSlug: "molecule",
    workspace: "细胞分子学",
    title: "细胞周期复习",
    subtitle: "Reader 关联 · 4 个来源",
  },
  {
    id: "finance",
    workspaceSlug: "mock-finance",
    threadSlug: "finance",
    workspace: "金钱心理学",
    title: "行为金融笔记",
    subtitle: "Agent 草稿 · 待确认",
  },
];

const emptyProductionThread = {
  id: "cloud-mobile-loading",
  workspaceSlug: null,
  threadSlug: null,
  workspace: "云端数据",
  title: "正在加载真实移动端",
  subtitle: "Cloud mobile runtime",
};

const initialMessages = [
  {
    id: "u-1",
    role: "user",
    text: "少爷，帮我把今天的学习状态整理一下。",
    time: "09:41",
  },
  {
    id: "a-1",
    role: "assistant",
    text: "今天你更适合做轻量推进：先复盘两条长期记忆，再把西方哲学史和细胞分子学的交叉兴趣整理成一个小任务。",
    time: "09:42",
  },
  {
    id: "u-2",
    role: "user",
    text: "那先从长期记忆开始，帮我列一个五分钟能完成的小清单。",
    time: "09:43",
  },
  {
    id: "a-2",
    role: "assistant",
    text: "可以。第一步只读最近三条记忆；第二步标出今天仍然重要的一条；第三步把它改写成一句行动提醒；第四步不要扩展资料，只保留一个下一步。",
    time: "09:44",
  },
  {
    id: "u-3",
    role: "user",
    text: "移动端上我希望它看起来轻一点，不要像桌面端那样信息太满。",
    time: "09:46",
  },
  {
    id: "a-3",
    role: "assistant",
    text: "移动端可以把复杂信息切成可滑动的卡片：顶部只保留当前 thread，中间只展示对话与状态，底部导航承担 Reader、Agent、Workspace 和 Settings 的入口。",
    time: "09:46",
  },
  {
    id: "u-4",
    role: "user",
    text: "那 Agent 状态卡也要能撑开页面，方便测试滚动。",
    time: "09:48",
  },
  {
    id: "a-4",
    role: "assistant",
    text: "已经在 mock 里保留了可展开状态卡。它不会连接真实 WebSocket，但可以模拟等待确认、运行中、已完成等状态。",
    time: "09:49",
  },
  {
    id: "u-5",
    role: "user",
    text: "Reader 的入口也要能像手机 App 一样快速进入最近文档。",
    time: "09:51",
  },
  {
    id: "a-5",
    role: "assistant",
    text: "Reader tab 会展示最近文档、阅读进度、引用卡片和稍后阅读队列。第一版只用临时数据，后续再决定是否接入真实跨设备状态。",
    time: "09:52",
  },
  {
    id: "u-6",
    role: "user",
    text: "现在继续增加几条消息，我要测试上下滑动和输入框固定效果。",
    time: "09:55",
  },
  {
    id: "a-6",
    role: "assistant",
    text: "好的。这里继续填充测试内容：滑动时顶部栏和底部输入区域保持在移动页面结构内，中间聊天流独立滚动，适合观察玻璃气泡、状态卡和长内容的层次。",
    time: "09:56",
  },
];

const moreActions = [
  { label: "搜索当前对话", meta: "Mock search" },
  { label: "查看 thread 信息", meta: "Mock details" },
  { label: "移动端设置", meta: "Mock settings" },
];

function formatMessageTime(timestamp) {
  if (!timestamp) return "";
  const date = new Date(Number(timestamp) * 1000);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function clampRatio(value) {
  const ratio = Number(value);
  if (!Number.isFinite(ratio)) return 0;
  return Math.min(1, Math.max(0, ratio));
}

function threadTitle(thread = {}, fallback = "未命名 thread") {
  return thread.title || thread.name || fallback;
}

function realThreadId(workspaceSlug, threadSlug = null) {
  return `${workspaceSlug}:${threadSlug || "workspace"}`;
}

function threadToDrawerItem(workspace = {}, thread = {}) {
  const title = threadTitle(thread, thread.slug || "未命名 thread");
  return {
    id: realThreadId(workspace.slug, thread.slug),
    slug: thread.slug,
    name: thread.name || title,
    workspaceSlug: workspace.slug,
    threadSlug: thread.slug,
    thread_type: thread.thread_type || thread.threadType || null,
    threadType: thread.thread_type || thread.threadType || null,
    created_from: thread.created_from || thread.createdFrom || null,
    createdFrom: thread.created_from || thread.createdFrom || null,
    lastChatAt: thread.lastChatAt || null,
    lastChatId: thread.lastChatId || null,
    updatedAt: thread.updatedAt || null,
    lastUpdatedAt: thread.lastUpdatedAt || thread.updatedAt || null,
    createdAt: thread.createdAt || null,
    workspace: workspace.name || workspace.slug || "Workspace",
    title,
    subtitle: thread.slug ? "Thread chat" : "Workspace chat",
  };
}

function sortMobileDrawerThreadsForDisplay(
  threads = [],
  pinnedThreadIds = [],
  activityFor = null
) {
  const pinned = new Set(pinnedThreadIds);
  const groups = [];
  const byWorkspaceSlug = new Map();

  for (const thread of threads) {
    const workspaceSlug = thread.workspaceSlug || thread.workspace;
    if (!workspaceSlug) continue;
    if (!byWorkspaceSlug.has(workspaceSlug)) {
      const group = { slug: workspaceSlug, threads: [] };
      byWorkspaceSlug.set(workspaceSlug, group);
      groups.push(group);
    }
    byWorkspaceSlug.get(workspaceSlug).threads.push(thread);
  }

  return groups.flatMap((group) => {
    const sortedThreads = sortThreadsForDisplay(
      group.threads,
      group.slug,
      activityFor
    ).map(({ thread }) => thread);
    const pinnedThreads = sortedThreads.filter((thread) =>
      pinned.has(thread.id)
    );
    const unpinnedThreads = sortedThreads.filter(
      (thread) => !pinned.has(thread.id)
    );
    return [...pinnedThreads, ...unpinnedThreads];
  });
}

function normalizeThreadToken(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function isOverviewThreadItem(thread = {}) {
  if (thread?.threadType === "overview" || thread?.thread_type === "overview")
    return true;

  const title = normalizeThreadToken(thread.title || thread.name);
  const slug = normalizeThreadToken(thread.threadSlug || thread.slug);
  const id = normalizeThreadToken(thread.id);

  return (
    !thread?.threadSlug ||
    title === "overview" ||
    title === "总览页" ||
    slug === "overview" ||
    slug === "workspace" ||
    id.endsWith(":workspace")
  );
}

function isVisibleThreadItem(thread = {}) {
  return (
    !!thread?.workspaceSlug &&
    !!thread?.threadSlug &&
    !isOverviewThreadItem(thread)
  );
}

function findInitialMobileThread(
  threads = [],
  initialWorkspaceSlug = null,
  initialThreadSlug = null
) {
  const visibleThreads = threads.filter(isVisibleThreadItem);
  if (!visibleThreads.length) return null;

  if (initialWorkspaceSlug && initialThreadSlug) {
    const requestedThread = visibleThreads.find(
      (thread) =>
        thread.workspaceSlug === initialWorkspaceSlug &&
        thread.threadSlug === initialThreadSlug
    );
    if (requestedThread) return requestedThread;
  }

  if (initialWorkspaceSlug) {
    const workspaceThreads = visibleThreads.filter(
      (thread) => thread.workspaceSlug === initialWorkspaceSlug
    );
    if (workspaceThreads[0]) return workspaceThreads[0];
  }

  return visibleThreads[0];
}

function findThreadAfterDeletion(
  deletedThread = {},
  sortedVisibleThreads = []
) {
  if (!deletedThread?.id) return null;
  const remainingThreads = sortedVisibleThreads.filter(
    (thread) => isVisibleThreadItem(thread) && thread.id !== deletedThread.id
  );
  const sameWorkspaceThreads = sortedVisibleThreads.filter(
    (thread) =>
      isVisibleThreadItem(thread) &&
      thread.workspaceSlug === deletedThread.workspaceSlug
  );
  const deletedWorkspaceIndex = sameWorkspaceThreads.findIndex(
    (thread) => thread.id === deletedThread.id
  );
  const remainingSameWorkspaceThreads = sameWorkspaceThreads.filter(
    (thread) => thread.id !== deletedThread.id
  );

  if (deletedWorkspaceIndex > 0) {
    return remainingSameWorkspaceThreads[deletedWorkspaceIndex - 1] || null;
  }
  if (deletedWorkspaceIndex === 0) {
    return remainingSameWorkspaceThreads[0] || remainingThreads[0] || null;
  }
  return remainingSameWorkspaceThreads[0] || remainingThreads[0] || null;
}

function normalizedText(value = "") {
  return String(value || "").trim();
}

function arrayPayload(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function historyToMessages(history = [], { fallbackToInitial = true } = {}) {
  const grouped = [];
  const byChatId = new Map();

  for (const item of history.filter(Boolean)) {
    const key =
      item.chatId ||
      item.publicChatId ||
      `${item.role}:${item.sentAt}:${item.id}`;
    if (!byChatId.has(key)) {
      byChatId.set(key, { user: null, assistant: null });
      grouped.push(byChatId.get(key));
    }
    const group = byChatId.get(key);
    if (item.role === "user" && !group.user) group.user = item;
    if (item.role === "assistant" && !group.assistant) group.assistant = item;
  }

  const messages = [];
  for (const group of grouped) {
    if (group.user?.content) {
      messages.push({
        id: `u-${group.user.chatId || group.user.publicChatId}`,
        chatId: group.user.chatId,
        publicChatId: group.user.publicChatId,
        clientTurnId: group.user.clientTurnId || null,
        role: "user",
        text: displayPrompt(group.user.content),
        time: formatMessageTime(group.user.sentAt),
        sentAt: group.user.sentAt,
        attachments: arrayPayload(group.user.attachments),
        hydrationStatus: group.user.hydrationStatus || null,
      });
    }
    if (
      group.assistant?.content ||
      arrayPayload(group.assistant?.outputs).length > 0 ||
      arrayPayload(group.assistant?.agentEvents).length > 0 ||
      arrayPayload(group.assistant?.clarifyingQuestions).length > 0
    ) {
      messages.push({
        id: `a-${group.assistant.chatId || group.assistant.publicChatId}`,
        chatId: group.assistant.chatId,
        publicChatId: group.assistant.publicChatId,
        clientTurnId: group.assistant.clientTurnId || null,
        role: "assistant",
        text: group.assistant.content,
        time: formatMessageTime(group.assistant.sentAt),
        sentAt: group.assistant.sentAt,
        sources: arrayPayload(group.assistant.sources),
        outputs: arrayPayload(group.assistant.outputs),
        timeline: arrayPayload(group.assistant.agentEvents),
        clarifyingQuestions: arrayPayload(group.assistant.clarifyingQuestions),
        hydrationStatus: group.assistant.hydrationStatus || null,
      });
    }
  }

  return messages.length ? messages : fallbackToInitial ? initialMessages : [];
}

function historyHasAssistantAfterSubmitted(
  messages = [],
  submittedText = "",
  submittedAt = null,
  clientTurnId = null,
  options = {}
) {
  return hasAssistantAfterSubmitted(
    messages,
    submittedText,
    submittedAt,
    messageHasStrongAssistantPayload,
    { clientTurnId, hasAttachments: !!options.hasAttachments }
  );
}

function assistantMessageMatchesPending(message = {}, pending = null) {
  if (!pending || message.role !== "assistant") return false;
  if (pending.clientTurnId && message.clientTurnId) {
    return message.clientTurnId === pending.clientTurnId;
  }
  return messageWithinSubmittedWindow(message, pending.submittedAt);
}

function weakAssistantMessagesForPending(messages = [], pending = null) {
  if (!pending) return [];
  return messages.filter(
    (message) =>
      assistantMessageMatchesPending(message, pending) &&
      !messageHasStrongAssistantPayload(message)
  );
}

function removeWeakAssistantMessagesForPending(messages = [], pending = null) {
  const weakMessages = weakAssistantMessagesForPending(messages, pending);
  if (!weakMessages.length) return messages;
  const weakIds = new Set(
    weakMessages.map(
      (message) =>
        message.id ||
        `${message.role}:${message.chatId || message.publicChatId || message.sentAt}`
    )
  );
  return messages.filter((message) => {
    const key =
      message.id ||
      `${message.role}:${message.chatId || message.publicChatId || message.sentAt}`;
    return !weakIds.has(key);
  });
}

function messageHasChatIdentity(message = {}) {
  return !!(message.chatId || message.publicChatId);
}

function messageHasAssistantPayload(message = {}) {
  return !!(
    normalizedText(message.text) ||
    message.outputs?.length ||
    message.timeline?.length ||
    message.clarifyingQuestions?.length ||
    message.error
  );
}

function messageHasStrongAssistantPayload(message = {}) {
  return !!(
    normalizedText(message.text) ||
    message.outputs?.length ||
    message.clarifyingQuestions?.length ||
    message.error
  );
}

function assistantPayloadSummary(message = {}) {
  return {
    id: message.id || null,
    chatId: message.chatId || null,
    publicChatId: message.publicChatId || null,
    clientTurnId: message.clientTurnId || null,
    sentAt: message.sentAt || null,
    hasAttachments: Array.isArray(message.attachments)
      ? message.attachments.length > 0
      : false,
    textLength: normalizedText(message.text).length,
    timelineLength: message.timeline?.length || 0,
    outputCount: message.outputs?.length || 0,
    clarificationCount: message.clarifyingQuestions?.length || 0,
    error: message.error ? String(message.error).slice(0, 160) : null,
    strong: messageHasStrongAssistantPayload(message),
  };
}

function messageIdentity(message = {}) {
  return message.publicChatId || message.chatId || null;
}

function latestIdentifiedAssistantMessage(messages = []) {
  return [...messages]
    .reverse()
    .find(
      (message) =>
        message?.role === "assistant" &&
        messageIdentity(message) &&
        messageHasAssistantPayload(message)
    );
}

const MOBILE_ASSISTANT_SETTLED_STATUSES = new Set([
  "completed",
  "failed",
  "interrupted",
]);

function messageAssistantLooksSettled(message = {}) {
  if (message.role !== "assistant") return false;
  if (message.draftTurnId || message.draftIsActiveTurn) return false;
  if (!messageHasStrongAssistantPayload(message)) return false;
  if (MOBILE_ASSISTANT_SETTLED_STATUSES.has(message.status)) return true;
  return messageHasChatIdentity(message) && !message.status;
}

function displayHasConfirmedAssistantAfterSubmitted(
  messages = [],
  submittedText = "",
  submittedAt = null,
  clientTurnId = null,
  options = {}
) {
  return hasAssistantAfterSubmitted(
    messages,
    submittedText,
    submittedAt,
    messageAssistantLooksSettled,
    { clientTurnId, hasAttachments: !!options.hasAttachments }
  );
}

const MOBILE_CLIENT_DEBUG_UPLOAD_PATH =
  "/debug/communication/mobile-client-log";
const MOBILE_CLIENT_DEBUG_UPLOAD_MAX_QUEUE = 240;
const MOBILE_CLIENT_DEBUG_UPLOAD_BATCH_SIZE = 30;
const MOBILE_CLIENT_DEBUG_UPLOAD_DELAY_MS = 800;
const mobileClientDebugUploadState = {
  queue: [],
  timer: null,
  disabledUntil: 0,
};

function mobileDebugFlagState(name) {
  if (typeof window === "undefined") return null;

  try {
    const params = new URLSearchParams(window.location.search || "");
    const queryValue = params.get(name);
    if (queryValue === "1" || queryValue === "true") {
      window.localStorage?.setItem(name, "true");
      return true;
    }
    if (queryValue === "0" || queryValue === "false") {
      window.localStorage?.setItem(name, "false");
      return false;
    }
    const storedValue = window.localStorage?.getItem(name);
    if (storedValue === "true") return true;
    if (storedValue === "false") return false;
    return null;
  } catch {
    return null;
  }
}

function mobileDebugFlagEnabled(name) {
  return mobileDebugFlagState(name) === true;
}

function mobileClientDebugUploadEnabled() {
  const uploadFlag = mobileDebugFlagState("mobileChatDebugUpload");
  if (uploadFlag !== null) return uploadFlag;
  const debugFlag = mobileDebugFlagState("mobileChatDebug");
  if (debugFlag !== null) return debugFlag;
  return import.meta.env.DEV;
}

function mobileClientDebugUploadUrl() {
  return MOBILE_CLIENT_DEBUG_UPLOAD_PATH;
}

function safeMobileDebugValue(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > 5) return "[max-depth]";
  if (typeof value === "string") {
    return value.length > 1_000
      ? `${value.slice(0, 1_000)}...[truncated]`
      : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value
      .slice(0, 80)
      .map((item) => safeMobileDebugValue(item, depth + 1));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 120)
        .map(([key, entry]) => [key, safeMobileDebugValue(entry, depth + 1)])
    );
  }
  return String(value);
}

function mobileDebugClientContext() {
  if (typeof window === "undefined") return {};
  return {
    path: window.location.pathname,
    viewport: {
      width: window.innerWidth || null,
      height: window.innerHeight || null,
      visualWidth: window.visualViewport?.width || null,
      visualHeight: window.visualViewport?.height || null,
    },
    network: navigator.connection
      ? {
          effectiveType: navigator.connection.effectiveType || null,
          downlink: navigator.connection.downlink || null,
          rtt: navigator.connection.rtt || null,
        }
      : null,
  };
}

function flushMobileClientDebugUpload() {
  if (typeof window === "undefined") return;
  mobileClientDebugUploadState.timer = null;
  if (!mobileClientDebugUploadEnabled()) return;
  if (Date.now() < mobileClientDebugUploadState.disabledUntil) return;
  if (!mobileClientDebugUploadState.queue.length) return;

  const events = mobileClientDebugUploadState.queue.splice(
    0,
    MOBILE_CLIENT_DEBUG_UPLOAD_BATCH_SIZE
  );
  postJson(
    mobileClientDebugUploadUrl(),
    {
      context: mobileDebugClientContext(),
      events,
    },
    {
      includeBaseHeaders: false,
      communicationScene: "mobile_client_debug_upload",
    }
  )
    .then((response) => {
      if (!response?.data?.success) {
        mobileClientDebugUploadState.disabledUntil = Date.now() + 10_000;
      }
    })
    .catch(() => {
      mobileClientDebugUploadState.disabledUntil = Date.now() + 10_000;
    });

  if (mobileClientDebugUploadState.queue.length) {
    mobileClientDebugUploadState.timer = window.setTimeout(
      flushMobileClientDebugUpload,
      MOBILE_CLIENT_DEBUG_UPLOAD_DELAY_MS
    );
  }
}

function queueMobileClientDebugUpload(entry = {}) {
  if (typeof window === "undefined") return;
  if (!mobileClientDebugUploadEnabled()) return;
  if (Date.now() < mobileClientDebugUploadState.disabledUntil) return;

  mobileClientDebugUploadState.queue.push({
    ...safeMobileDebugValue(entry),
    clientContext: mobileDebugClientContext(),
  });
  if (
    mobileClientDebugUploadState.queue.length >
    MOBILE_CLIENT_DEBUG_UPLOAD_MAX_QUEUE
  ) {
    mobileClientDebugUploadState.queue.splice(
      0,
      mobileClientDebugUploadState.queue.length -
        MOBILE_CLIENT_DEBUG_UPLOAD_MAX_QUEUE
    );
  }
  if (mobileClientDebugUploadState.timer) return;
  mobileClientDebugUploadState.timer = window.setTimeout(
    flushMobileClientDebugUpload,
    MOBILE_CLIENT_DEBUG_UPLOAD_DELAY_MS
  );
}

function mobileChatDebug(label, payload = {}) {
  if (typeof window === "undefined") return;

  const entry = {
    label,
    at: new Date().toISOString(),
    payload,
  };
  window.__mobileChatDebug = Array.isArray(window.__mobileChatDebug)
    ? window.__mobileChatDebug
    : [];
  window.__mobileChatDebug.push(entry);
  if (window.__mobileChatDebug.length > 120) window.__mobileChatDebug.shift();
  queueMobileClientDebugUpload(entry);

  try {
    const enabled =
      mobileDebugFlagEnabled("mobileChatDebug") ||
      mobileDebugFlagEnabled("chatTurnDebug");
    if (enabled) console.debug("[mobile-chat-debug]", label, payload);
  } catch {}
}

function mobileFileDebugPayload(file = {}) {
  return {
    name: file?.name || null,
    type: file?.type || null,
    size: file?.size || 0,
    lastModified: file?.lastModified || null,
  };
}

function mobileAttachmentDebugItems(attachments = []) {
  return attachments.map((attachment) => ({
    uid: attachment.uid || null,
    type: attachment.type || null,
    status: attachment.status || null,
    mime: attachment.mime || null,
    name: attachment.file?.name || null,
    hasPreviewUrl: !!attachment.previewUrl,
    hasContentString: !!attachment.contentString,
  }));
}

function mobileAttachmentDebugSignature(attachments = [], extra = {}) {
  return JSON.stringify({
    ...extra,
    items: mobileAttachmentDebugItems(attachments),
  });
}

const MOBILE_PENDING_SUBMITTED_MESSAGE_PREFIX =
  "athena-mobile-pending-submitted";
const MOBILE_PENDING_SUBMITTED_TTL_MS = 30 * 60 * 1000;
const MOBILE_PENDING_HISTORY_MAX_ATTEMPTS = 45;
const MOBILE_PENDING_HISTORY_BASE_DELAY_MS = 900;
const MOBILE_PENDING_HISTORY_MAX_DELAY_MS = 3_000;
const MOBILE_PENDING_UNACCEPTED_STALL_MS = 45_000;
const MOBILE_PENDING_ORPHAN_STALL_MS = 180_000;
const MOBILE_THREAD_DELETE_ANIMATION_MS = 190;

function pendingSubmittedStorageKey(target = {}) {
  if (!target?.workspaceSlug || !target?.threadSlug) return null;
  return `${MOBILE_PENDING_SUBMITTED_MESSAGE_PREFIX}:${target.workspaceSlug}:${target.threadSlug}`;
}

function readStoredPendingSubmittedMessage(thread = {}) {
  if (typeof window === "undefined") return null;
  const key = pendingSubmittedStorageKey(thread);
  if (!key) return null;

  try {
    const pending = JSON.parse(window.sessionStorage.getItem(key) || "null");
    if (!pending?.text || !pending?.submittedAt) return null;
    const createdAtMs = Number(pending.createdAtMs || 0);
    if (
      createdAtMs &&
      Date.now() - createdAtMs > MOBILE_PENDING_SUBMITTED_TTL_MS
    ) {
      window.sessionStorage.removeItem(key);
      return null;
    }
    return {
      ...pending,
      threadId: pending.threadId || thread.id,
      workspaceSlug: pending.workspaceSlug || thread.workspaceSlug,
      threadSlug: pending.threadSlug || thread.threadSlug,
      attempts: Number(pending.attempts || 0),
    };
  } catch {
    window.sessionStorage.removeItem(key);
    return null;
  }
}

function sanitizePendingAttachmentForStorage(attachment = {}) {
  const file = attachment.file || {};
  const lightweightFile = {
    name: file.name || attachment.name || null,
    type: file.type || attachment.mime || null,
    size: Number(file.size || attachment.size || 0),
    lastModified: file.lastModified || null,
  };

  return {
    uid: attachment.uid || null,
    type: attachment.type || null,
    status: attachment.status || null,
    mime: attachment.mime || lightweightFile.type || null,
    file: lightweightFile.name ? lightweightFile : null,
    storageLightweight: true,
  };
}

function sanitizePendingSubmittedForStorage(pending = {}) {
  const attachments = Array.isArray(pending.attachments)
    ? pending.attachments.map(sanitizePendingAttachmentForStorage)
    : [];

  return {
    ...pending,
    attachments,
    createdAtMs: pending.createdAtMs || Date.now(),
  };
}

function storePendingSubmittedMessage(pending = {}) {
  if (typeof window === "undefined") return;
  const key = pendingSubmittedStorageKey(pending);
  if (!key) return;

  try {
    window.sessionStorage.setItem(
      key,
      JSON.stringify(sanitizePendingSubmittedForStorage(pending))
    );
  } catch (error) {
    mobileChatDebug("pending:storage-skipped", {
      message: error?.message || String(error),
      key,
      threadId: pending.threadId || null,
      workspaceSlug: pending.workspaceSlug || null,
      threadSlug: pending.threadSlug || null,
      attachmentCount: Array.isArray(pending.attachments)
        ? pending.attachments.length
        : 0,
      textLength: String(pending.text || "").length,
    });
    try {
      window.sessionStorage.removeItem(key);
    } catch {}
  }
}

function pendingSubmittedCreatedAtMs(pending = {}) {
  const createdAtMs = Number(pending.createdAtMs || 0);
  if (createdAtMs) return createdAtMs;
  const submittedAt = Number(pending.submittedAt || 0);
  return submittedAt ? submittedAt * 1000 : Date.now();
}

function pendingSubmittedMatchesTurn(left = null, right = null) {
  if (!left || !right) return false;
  if (left.clientTurnId || right.clientTurnId) {
    return left.clientTurnId === right.clientTurnId;
  }
  return (
    left.workspaceSlug === right.workspaceSlug &&
    left.threadSlug === right.threadSlug &&
    left.submittedAt === right.submittedAt &&
    normalizedText(left.text) === normalizedText(right.text)
  );
}

function clearStoredPendingSubmittedMessage(target = {}) {
  if (typeof window === "undefined") return;
  const key = pendingSubmittedStorageKey(target);
  if (!key) return;
  window.sessionStorage.removeItem(key);
}

function pendingSubmittedToMessage(pending = {}) {
  return {
    id: pending.messageId || `u-local-${pending.submittedAt}`,
    role: "user",
    clientTurnId: pending.clientTurnId || null,
    text: pending.displayText || pending.text || "",
    displayText: pending.displayText || pending.text || "",
    time: "现在",
    sentAt: pending.submittedAt,
    attachments: pending.attachments || [],
    workspaceSlug: pending.workspaceSlug,
    threadSlug: pending.threadSlug,
  };
}

function pendingSubmittedHasAttachments(pending = {}) {
  return Array.isArray(pending.attachments) && pending.attachments.length > 0;
}

function mergePendingSubmittedMessage(messages = [], pending = null) {
  if (!pending?.text) return messages;
  if (
    historyIncludesSubmittedMessage(
      messages,
      pending.text,
      pending.submittedAt,
      {
        clientTurnId: pending.clientTurnId || null,
        hasAttachments: pendingSubmittedHasAttachments(pending),
      }
    )
  ) {
    return messages;
  }

  return [...messages, pendingSubmittedToMessage(pending)];
}

function sentAtFromTurnTimestamp(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp)) return null;
  return timestamp > 10_000_000_000
    ? Math.floor(timestamp / 1000)
    : Math.floor(timestamp);
}

function formatTurnItemTime(value) {
  const sentAt = sentAtFromTurnTimestamp(value);
  if (!sentAt) return "";
  return formatMessageTime(sentAt);
}

function mobileTimelineEvents(value) {
  return arrayPayload(value).filter(Boolean);
}

function mobileToolName(event = {}) {
  return (
    event.skillName ||
    event.toolName ||
    event.name ||
    event.functionName ||
    "tool"
  );
}

function mobileDraftToMessages(draft = null) {
  if (!draft?.items?.length) return [];

  const assistantByTurnId = new Map();
  const unfinishedTurnIds = new Set();
  for (const item of draft.items) {
    if (item?.type !== "assistant_turn" || item?.role !== "assistant") continue;
    assistantByTurnId.set(item.turnId, item);
    if (item.status !== "completed") unfinishedTurnIds.add(item.turnId);
  }

  return draft.items.reduce((messages, item) => {
    if (item?.type === "user" && item?.role === "user") {
      const assistantTurn = assistantByTurnId.get(item.turnId);
      messages.push({
        id: item.chatId
          ? `u-${item.chatId}`
          : item.publicChatId
            ? `u-${item.publicChatId}`
            : item.id || `u-${item.turnId}`,
        chatId: item.chatId,
        publicChatId: item.publicChatId,
        clientTurnId: item.clientTurnId || item.turnId || null,
        role: "user",
        text: item.content || "",
        time: formatTurnItemTime(item.createdAt) || "现在",
        sentAt: sentAtFromTurnTimestamp(item.createdAt),
        attachments: item.attachments || [],
        draftTurnId: item.turnId || null,
        draftTurnStatus: assistantTurn?.status || null,
        draftTurnUnfinished: unfinishedTurnIds.has(item.turnId),
        draftIsActiveTurn: item.turnId === draft.activeTurnId,
      });
      return messages;
    }

    if (item?.type === "assistant_turn" && item?.role === "assistant") {
      const timeline = mobileTimelineEvents(item.timeline);
      const outputs = arrayPayload(item.outputs);
      const clarifyingQuestions = arrayPayload(item.clarifyingQuestions);
      const text = item.finalContent || item.content || "";
      const hasVisiblePayload =
        !!text.trim() ||
        outputs.length > 0 ||
        timeline.length > 0 ||
        clarifyingQuestions.length > 0 ||
        !!item.error;

      if (!hasVisiblePayload) return messages;

      messages.push({
        id: item.chatId
          ? `a-${item.chatId}`
          : item.publicChatId
            ? `a-${item.publicChatId}`
            : item.id || `a-${item.turnId}`,
        chatId: item.chatId,
        publicChatId: item.publicChatId,
        clientTurnId: item.clientTurnId || item.turnId || null,
        role: "assistant",
        text: text || (item.error ? "Agent 遇到问题，操作未完成。" : ""),
        time: formatTurnItemTime(item.updatedAt || item.createdAt) || "现在",
        sentAt: sentAtFromTurnTimestamp(item.createdAt),
        sources: item.sources || [],
        outputs,
        timeline,
        clarifyingQuestions,
        status: item.status,
        streamConnectionState: item.streamConnectionState || null,
        error: item.error,
        draftTurnId: item.turnId || null,
        draftTurnStatus: item.status || null,
        draftTurnUnfinished: unfinishedTurnIds.has(item.turnId),
        draftIsActiveTurn: item.turnId === draft.activeTurnId,
      });
    }

    return messages;
  }, []);
}

function mobileAssistantTurns(draft = null) {
  return (draft?.items || []).filter(
    (item) => item?.type === "assistant_turn" && item?.role === "assistant"
  );
}

function mobileAssistantTurnHasPayload(turn = {}) {
  return !!(
    normalizedText(turn.finalContent || turn.content) ||
    arrayPayload(turn.outputs).length ||
    mobileTimelineEvents(turn.timeline).length ||
    arrayPayload(turn.clarifyingQuestions).length ||
    turn.error
  );
}

function mobileAssistantTurnHasStrongPayload(turn = {}) {
  return !!(
    normalizedText(turn.finalContent || turn.content) ||
    arrayPayload(turn.outputs).length ||
    arrayPayload(turn.clarifyingQuestions).length ||
    turn.error
  );
}

function mobileAssistantTurnSummary(turn = {}) {
  const timeline = mobileTimelineEvents(turn.timeline);
  const outputs = arrayPayload(turn.outputs);
  const clarifyingQuestions = arrayPayload(turn.clarifyingQuestions);
  const text = turn.finalContent || turn.content || "";

  return {
    id: turn.id || null,
    turnId: turn.turnId || null,
    status: turn.status || null,
    chatId: turn.chatId || null,
    publicChatId: turn.publicChatId || null,
    hasChatIdentity: !!(turn.chatId || turn.publicChatId),
    hasPayload: mobileAssistantTurnHasPayload(turn),
    hasStrongPayload: mobileAssistantTurnHasStrongPayload(turn),
    textLength: normalizedText(text).length,
    timelineLength: timeline.length,
    outputCount: outputs.length,
    clarificationCount: clarifyingQuestions.length,
    error: turn.error ? String(turn.error).slice(0, 160) : null,
  };
}

function mobileDraftSettledAssistantAfterSubmitted(
  draft = null,
  pending = null
) {
  if (!draft?.items?.length || !pending?.text) return null;
  if (draft.pendingClarification || draft.pendingApproval) return null;
  const expected = normalizedText(pending.text);
  const submittedIndex = draft.items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => {
      if (item?.type !== "user" || item?.role !== "user") return false;
      if (pending.clientTurnId && item.clientTurnId) {
        return item.clientTurnId === pending.clientTurnId;
      }
      if (normalizedText(item.content) !== expected) return false;
      return messageWithinSubmittedWindow(
        { sentAt: sentAtFromTurnTimestamp(item.createdAt) },
        pending.submittedAt
      );
    })
    .sort((first, second) => {
      const submitted = Number(pending.submittedAt || 0);
      if (submitted) {
        const firstDistance = Math.abs(
          Number(sentAtFromTurnTimestamp(first.item.createdAt) || submitted) -
            submitted
        );
        const secondDistance = Math.abs(
          Number(sentAtFromTurnTimestamp(second.item.createdAt) || submitted) -
            submitted
        );
        if (firstDistance !== secondDistance)
          return firstDistance - secondDistance;
      }
      return second.index - first.index;
    })[0]?.index;

  if (submittedIndex === undefined || submittedIndex < 0) return null;
  const settledTurn = draft.items.slice(submittedIndex + 1).find((item) => {
    if (item?.type !== "assistant_turn" || item?.role !== "assistant")
      return false;
    if (!MOBILE_ASSISTANT_SETTLED_STATUSES.has(item.status)) return false;
    return mobileAssistantTurnHasStrongPayload(item);
  });

  return settledTurn ? mobileAssistantTurnSummary(settledTurn) : null;
}

function mobileActiveAssistantTurn(draft = null) {
  const turns = mobileAssistantTurns(draft);
  if (!turns.length) return null;
  if (draft?.activeTurnId) {
    const active = turns.find((turn) => turn.turnId === draft.activeTurnId);
    if (active) return active;
  }
  return turns[turns.length - 1];
}

function mobileDraftHasRuntimeActivity(draft = null) {
  if (!draft) return false;
  return !!(
    draft.isStreaming ||
    draft.isAgentRunning ||
    draft.pendingApproval ||
    draft.pendingClarification ||
    draft.activeToolCall ||
    mobileActiveAssistantTurn(draft)?.status === "running"
  );
}

function mobileRuntimeActivity(draft = null) {
  if (!draft) return null;
  if (draft.pendingClarification || draft.pendingApproval) return null;

  if (draft.activeToolCall) {
    return {
      key: `tool:${mobileRuntimeToolKey(draft.activeToolCall) || "active"}`,
      label: `正在调用 ${mobileToolName(draft.activeToolCall)}`,
    };
  }

  if (
    draft.isStreaming ||
    draft.isAgentRunning ||
    mobileActiveAssistantTurn(draft)?.status === "running"
  ) {
    return {
      key: "thinking",
      label: "正在思考",
    };
  }

  return null;
}

function mobileRuntimeToolKey(activeToolCall = null) {
  if (!activeToolCall) return null;
  return (
    activeToolCall.id ||
    activeToolCall.uuid ||
    activeToolCall.runId ||
    activeToolCall.requestId ||
    activeToolCall.toolName ||
    null
  );
}

function mobileRuntimeRequestKey({
  pendingApproval = null,
  pendingClarification = null,
  activeToolCall = null,
} = {}) {
  if (pendingClarification?.requestId)
    return `clarification:${pendingClarification.requestId}`;
  if (pendingApproval?.requestId)
    return `approval:${pendingApproval.requestId}`;
  const toolKey = mobileRuntimeToolKey(activeToolCall);
  return toolKey ? `tool:${toolKey}` : null;
}

function mobileTimeoutRemainingMs(timeoutMs, requestedAt, progressPercent) {
  if (!timeoutMs) return 0;
  if (requestedAt) {
    return Math.max(0, timeoutMs - (Date.now() - requestedAt));
  }
  return Math.max(0, timeoutMs * (progressPercent / 100));
}

function formatMobileTimeout(remainingMs = 0) {
  const seconds = Math.ceil(Math.max(0, remainingMs) / 1000);
  if (seconds >= 60) return `${Math.ceil(seconds / 60)} 分钟`;
  return `${seconds} 秒`;
}

async function writeClipboardText(text = "") {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  if (typeof document === "undefined") return;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

function prefersReducedMobileMotion() {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function useAnimatedPresence(open, duration = 160) {
  const [shouldRender, setShouldRender] = useState(open);
  const [isVisible, setIsVisible] = useState(open);

  useEffect(() => {
    const reducedMotion = prefersReducedMobileMotion();
    let frame = null;
    let timeout = null;

    if (open) {
      setShouldRender(true);
      if (reducedMotion || typeof window === "undefined") {
        setIsVisible(true);
      } else {
        frame = window.requestAnimationFrame(() => setIsVisible(true));
      }

      return () => {
        if (frame) window.cancelAnimationFrame(frame);
      };
    }

    setIsVisible(false);
    if (reducedMotion) {
      setShouldRender(false);
      return undefined;
    }

    timeout = window.setTimeout(() => setShouldRender(false), duration);
    return () => {
      if (timeout) window.clearTimeout(timeout);
    };
  }, [open, duration]);

  return { shouldRender, isVisible };
}

function mobileExperimentRealRuntimeEnabled() {
  if (typeof window === "undefined") return false;
  const value = new URLSearchParams(window.location.search).get("real");
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function mobileExperimentMockRuntimeEnabled() {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  const cloudMode = String(params.get("cloudMobile") || "")
    .trim()
    .toLowerCase();
  const mock = String(params.get("mock") || "")
    .trim()
    .toLowerCase();
  return (
    cloudMode === "mock" ||
    cloudMode === "experiment" ||
    ["1", "true", "yes", "on"].includes(mock)
  );
}

function localMobileExperimentHost() {
  if (typeof window === "undefined") return false;
  return ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
}

function mobileExperimentCloudMode() {
  if (typeof window === "undefined") return "experiment";
  const value = new URLSearchParams(window.location.search).get("cloudMobile");
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "proxy" || normalized === "launch") return normalized;
  if (mobileExperimentMockRuntimeEnabled()) return "experiment";
  if (mobileExperimentRealRuntimeEnabled() || localMobileExperimentHost()) {
    return "proxy";
  }
  return "experiment";
}

function cloudMobileUrl({ path = "/", platform = "ios", mobile = true } = {}) {
  const url = new URL(path, CLOUD_MOBILE_APP_URL);
  url.searchParams.set("athenaMobile", mobile ? "1" : "0");
  if (mobile) url.searchParams.set("athenaPlatform", platform);
  else url.searchParams.delete("athenaPlatform");
  return url.toString();
}

function mobileThreadRoute(thread) {
  if (!thread?.workspaceSlug) return null;
  return thread.threadSlug
    ? paths.workspace.thread(thread.workspaceSlug, thread.threadSlug)
    : paths.workspace.chat(thread.workspaceSlug);
}

export default function MobilePageExperiment() {
  const cloudMode = mobileExperimentCloudMode();
  if (cloudMode === "launch") return <CloudMobileLaunchPanel />;
  if (cloudMode === "proxy")
    return (
      <ChatThreadDraftProviderBoundary>
        <SyncCenterProvider>
          <MobilePageExperimentContent
            mode="production"
            presentation="framed"
          />
        </SyncCenterProvider>
      </ChatThreadDraftProviderBoundary>
    );

  return (
    <ChatThreadDraftProviderBoundary>
      <SyncCenterProvider>
        <MobilePageExperimentContent mode="experiment" />
      </SyncCenterProvider>
    </ChatThreadDraftProviderBoundary>
  );
}

function CloudMobileLaunchPanel() {
  const iosLoginUrl = cloudMobileUrl({
    path: "/login?nt=1",
    platform: "ios",
  });
  const iosHomeUrl = cloudMobileUrl({ path: "/", platform: "ios" });
  const androidHomeUrl = cloudMobileUrl({ path: "/", platform: "android" });
  const desktopUrl = cloudMobileUrl({ path: "/", mobile: false });
  const proxyUrl =
    "/settings/mobile-page-experiment?cloudMobile=proxy&real=1&athenaMobile=1&athenaPlatform=ios";

  return (
    <div className="mobile-isolation-zone min-h-screen w-full overflow-y-auto bg-[#f3f6fb] p-5 text-slate-950 md:p-8">
      <div className="mx-auto max-w-4xl rounded-[28px] border border-white/80 bg-white/82 p-6 shadow-[0_28px_80px_rgba(15,23,42,0.12)] backdrop-blur-2xl">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.18em] text-sky-500">
              Cloud Mobile Launch
            </p>
            <h1 className="mt-2 text-2xl font-black text-slate-950">
              真实云端移动端启动台
            </h1>
            <p className="mt-3 max-w-2xl text-sm font-semibold leading-6 text-slate-500">
              这里不会 iframe 嵌入云端页面；生产环境有安全头限制。按钮会打开
              athenallm.online，并附带移动端强制参数，便于验证真实域名、通行密钥和
              PWA 行为。
            </p>
          </div>
          <div className="rounded-full border border-emerald-200 bg-emerald-50 px-4 py-2 text-xs font-black text-emerald-700">
            API: {CLOUD_MOBILE_APP_URL}
          </div>
        </div>

        <div className="mt-7 grid gap-3 md:grid-cols-2">
          <CloudLaunchButton label="打开 iOS 登录页" href={iosLoginUrl} />
          <CloudLaunchButton label="打开 iOS 首页" href={iosHomeUrl} />
          <CloudLaunchButton label="打开 Android 首页" href={androidHomeUrl} />
          <CloudLaunchButton label="清除强制移动端" href={desktopUrl} />
        </div>

        <div className="mt-7 rounded-[22px] border border-slate-200 bg-slate-50 p-4">
          <p className="text-sm font-black text-slate-800">本地 Proxy 模式</p>
          <p className="mt-2 text-xs font-semibold leading-5 text-slate-500">
            本地手机壳运行本地最新代码，数据请求经 Vite 代理到云端。
          </p>
          <a
            href={proxyUrl}
            className="mt-3 inline-flex rounded-full bg-slate-900 px-4 py-2 text-xs font-black text-white transition hover:bg-slate-700"
          >
            进入 Proxy 模式
          </a>
        </div>

        <div className="mt-4 rounded-[22px] border border-sky-100 bg-sky-50 p-4">
          <p className="text-sm font-black text-sky-800">常用命令</p>
          <code className="mt-2 block overflow-x-auto whitespace-pre rounded-2xl bg-white px-3 py-2 text-xs font-bold text-slate-700">
            yarn dev:mobile-cloud{"\n"}
            yarn logs:mobile-cloud -- --app --since 10m --grep
            'mobile|history|hydrate|error'
          </code>
        </div>
      </div>
    </div>
  );
}

function CloudLaunchButton({ label, href }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-black text-slate-800 shadow-[0_10px_30px_rgba(15,23,42,0.08)] transition hover:-translate-y-0.5 hover:border-sky-200 hover:text-sky-700"
    >
      {label}
    </a>
  );
}

export function MobileWebPwa({
  initialWorkspaceSlug = null,
  initialThreadSlug = null,
  presentation = "fullscreen",
}) {
  return (
    <ChatThreadDraftProviderBoundary>
      <SyncCenterProvider>
        <MobilePageExperimentContent
          mode="production"
          presentation={presentation}
          initialWorkspaceSlug={initialWorkspaceSlug}
          initialThreadSlug={initialThreadSlug}
        />
      </SyncCenterProvider>
    </ChatThreadDraftProviderBoundary>
  );
}

export function useMobileViewportFrame(enabled = true) {
  const baseHeightRef = useRef(null);
  const [frame, setFrame] = useState(() => ({
    height:
      typeof window === "undefined"
        ? "100svh"
        : `${Math.max(window.innerHeight || 0, 1)}px`,
    keyboardInset: 0,
  }));

  useEffect(() => {
    if (!enabled || typeof document === "undefined") return undefined;

    const root = document.documentElement;
    const body = document.body;
    const previous = {
      rootOverflow: root.style.overflow,
      rootHeight: root.style.height,
      rootOverscrollBehaviorY: root.style.overscrollBehaviorY,
      bodyOverflow: body.style.overflow,
      bodyHeight: body.style.height,
      bodyOverscrollBehaviorY: body.style.overscrollBehaviorY,
      bodyWidth: body.style.width,
    };

    function pinDocumentScroll() {
      if (typeof window === "undefined") return;
      if (window.scrollX === 0 && window.scrollY === 0) return;
      window.scrollTo(0, 0);
    }

    function scheduleScrollPin() {
      pinDocumentScroll();
      window.requestAnimationFrame(pinDocumentScroll);
      window.setTimeout(pinDocumentScroll, 80);
      window.setTimeout(pinDocumentScroll, 220);
    }

    function handleFocusIn(event) {
      const target = event.target;
      const tagName = target?.tagName?.toLowerCase?.();
      const editable =
        tagName === "input" ||
        tagName === "textarea" ||
        target?.isContentEditable;
      if (!editable) return;
      scheduleScrollPin();
    }

    root.style.overflow = "hidden";
    root.style.height = "100%";
    root.style.overscrollBehaviorY = "none";
    body.style.overflow = "hidden";
    body.style.height = "100%";
    body.style.overscrollBehaviorY = "none";
    body.style.width = "100%";
    window.addEventListener("focusin", handleFocusIn, true);
    window.visualViewport?.addEventListener("resize", scheduleScrollPin);
    window.visualViewport?.addEventListener("scroll", scheduleScrollPin);

    return () => {
      window.removeEventListener("focusin", handleFocusIn, true);
      window.visualViewport?.removeEventListener("resize", scheduleScrollPin);
      window.visualViewport?.removeEventListener("scroll", scheduleScrollPin);
      root.style.overflow = previous.rootOverflow;
      root.style.height = previous.rootHeight;
      root.style.overscrollBehaviorY = previous.rootOverscrollBehaviorY;
      body.style.overflow = previous.bodyOverflow;
      body.style.height = previous.bodyHeight;
      body.style.overscrollBehaviorY = previous.bodyOverscrollBehaviorY;
      body.style.width = previous.bodyWidth;
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return undefined;

    function updateFrame({ resetBase = false } = {}) {
      const viewport = window.visualViewport;
      const viewportHeight = viewport?.height || window.innerHeight || 0;
      const viewportOffsetTop = viewport?.offsetTop || 0;
      const visibleBottom = viewportHeight + viewportOffsetTop;
      const nextKeyboardInset = Math.max(
        0,
        Math.round((window.innerHeight || viewportHeight) - visibleBottom)
      );

      if (
        resetBase ||
        !baseHeightRef.current ||
        nextKeyboardInset < 8 ||
        window.innerHeight > baseHeightRef.current
      ) {
        baseHeightRef.current = Math.max(
          window.innerHeight || viewportHeight,
          1
        );
      }

      setFrame({
        height: `${baseHeightRef.current}px`,
        keyboardInset: nextKeyboardInset,
      });
    }

    function handleOrientationChange() {
      baseHeightRef.current = null;
      window.setTimeout(() => updateFrame({ resetBase: true }), 250);
    }

    updateFrame({ resetBase: true });
    window.visualViewport?.addEventListener("resize", updateFrame);
    window.visualViewport?.addEventListener("scroll", updateFrame);
    window.addEventListener("orientationchange", handleOrientationChange);
    return () => {
      window.visualViewport?.removeEventListener("resize", updateFrame);
      window.visualViewport?.removeEventListener("scroll", updateFrame);
      window.removeEventListener("orientationchange", handleOrientationChange);
    };
  }, [enabled]);

  return {
    "--mobile-app-height": frame.height,
    "--mobile-keyboard-inset": `${frame.keyboardInset}px`,
    height: "var(--mobile-app-height, 100svh)",
  };
}

export function MobilePageExperimentContent({
  mode = "experiment",
  presentation = "framed",
  initialWorkspaceSlug = null,
  initialThreadSlug = null,
}) {
  const auth = useContext(AuthContext);
  const navigate = useNavigate();
  const { pfp: currentAccountPfp } = usePfp();
  const productionMode = mode === "production";
  const [drawerThreads, setDrawerThreads] = useState(
    productionMode ? [] : mockThreads
  );
  const [pinnedThreadIds, setPinnedThreadIds] = useState([]);
  const [removingThreadIds, setRemovingThreadIds] = useState([]);
  const [activeThreadId, setActiveThreadId] = useState(
    productionMode ? null : mockThreads[0].id
  );
  const [messages, setMessages] = useState(
    productionMode ? [] : initialMessages
  );
  const [input, setInput] = useState("");
  const [loadingData, setLoadingData] = useState(true);
  const [loadingThreadHistory, setLoadingThreadHistory] = useState(false);
  const [dataError, setDataError] = useState(null);
  const [streaming, setStreaming] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [attachmentSheetOpen, setAttachmentSheetOpen] = useState(false);
  const [mobileAttachments, setMobileAttachments] = useState([]);
  const [mobileAttachmentsProcessing, setMobileAttachmentsProcessing] =
    useState(false);
  const [recording, setRecording] = useState(false);
  const [quizMode, setQuizMode] = useState(false);
  const [memoryStatus, setMemoryStatus] = useState(null);
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [memoryUnavailable, setMemoryUnavailable] = useState(true);
  const [chatEditSession, setChatEditSession] = useState(null);
  const [chatMutationView, setChatMutationView] = useState(null);
  const [messageActionBusy, setMessageActionBusy] = useState(null);
  const [copiedMessageId, setCopiedMessageId] = useState(null);
  const [speakingMessageId, setSpeakingMessageId] = useState(null);
  const [mobileSessionSignedOut, setMobileSessionSignedOut] = useState(false);
  const [mobileSessionUser, setMobileSessionUser] = useState(null);
  const [mobileSessionPfp, setMobileSessionPfp] = useState(null);
  const [mobileLoginInitialMode, setMobileLoginInitialMode] = useState("quick");
  const [mobileLoginAccountHint, setMobileLoginAccountHint] = useState(null);
  const [mobileAuthRevision, setMobileAuthRevision] = useState(0);
  const [localRuntimeActivity, setLocalRuntimeActivity] = useState(null);
  const messagesEndRef = useRef(null);
  const chatPaneRef = useRef(null);
  const mobileShouldFollowRef = useRef(true);
  const mobileLastScrollTopRef = useRef(0);
  const [mobileHasNewMessages, setMobileHasNewMessages] = useState(false);
  const [mobileComposerBottomInset, setMobileComposerBottomInset] = useState(
    MOBILE_COMPOSER_FALLBACK_INSET
  );
  const runtimeSheetRef = useRef(null);
  const replyTimerRef = useRef(null);
  const copiedTimerRef = useRef(null);
  const attachmentButtonRef = useRef(null);
  const cameraInputRef = useRef(null);
  const photoInputRef = useRef(null);
  const fileInputRef = useRef(null);
  const mobileParseAttachmentsRef = useRef(() => []);
  const moreButtonRef = useRef(null);
  const activeThreadIdRef = useRef(activeThreadId);
  const lastRuntimeBusyRef = useRef(false);
  const forcePasswordLoginRef = useRef(false);
  const sendInFlightRef = useRef(false);
  const pendingSubmittedMessageRef = useRef(null);
  const pendingHistoryRefreshTimerRef = useRef(null);
  const pendingOrphanRecoveryKeyRef = useRef(null);
  const draftSettledRefreshKeyRef = useRef(null);
  const memoryStatusRequestRef = useRef({ id: 0, controller: null });
  const mobileHistoryRequestRef = useRef({ generation: 0, controller: null });
  const drawerPresence = useAnimatedPresence(menuOpen, 220);
  const attachmentPresence = useAnimatedPresence(attachmentSheetOpen, 140);
  const moreMenuPresence = useAnimatedPresence(moreMenuOpen, 140);
  const handleMobileComposerHeightChange = useCallback((height) => {
    const nextInset = normalizeMobileComposerInset(height);
    setMobileComposerBottomInset((currentInset) =>
      currentInset === nextInset ? currentInset : nextInset
    );
  }, []);
  const chatDrafts = useChatThreadDrafts();
  useThreadActivitySnapshot();
  const fullscreenPresentation = presentation === "fullscreen";
  const sandboxedPresentation = !fullscreenPresentation;
  const [sandboxRoutePath, setSandboxRoutePath] = useState(() => {
    if (initialWorkspaceSlug && initialThreadSlug) {
      return paths.workspace.thread(initialWorkspaceSlug, initialThreadSlug);
    }
    if (initialWorkspaceSlug) return paths.workspace.chat(initialWorkspaceSlug);
    return "/settings/mobile-page-experiment";
  });
  const mobileFrameAddress = useMemo(() => {
    const path = sandboxRoutePath?.startsWith("/")
      ? sandboxRoutePath
      : `/${sandboxRoutePath || ""}`;
    return productionMode ? `athenallm.online${path}` : `athena.local${path}`;
  }, [productionMode, sandboxRoutePath]);
  const navigateMobilePath = useCallback(
    (path, options) => {
      if (!path) return;
      if (fullscreenPresentation) {
        navigate(path, options);
        return;
      }
      setSandboxRoutePath(path);
      mobileChatDebug("sandbox:navigate-contained", { path });
    },
    [fullscreenPresentation, navigate]
  );
  const navigateMobileThread = useCallback(
    (thread, options) => navigateMobilePath(mobileThreadRoute(thread), options),
    [navigateMobilePath]
  );
  const mobileViewportFrameStyle = useMobileViewportFrame(
    productionMode && fullscreenPresentation
  );

  const visibleDrawerThreads = useMemo(() => {
    const visibleThreads = drawerThreads.filter(isVisibleThreadItem);
    const sortedThreads = sortMobileDrawerThreadsForDisplay(
      visibleThreads,
      pinnedThreadIds,
      chatDrafts.hasThreadActivity
    );
    return sortedThreads.length
      ? sortedThreads
      : productionMode
        ? []
        : mockThreads;
  }, [
    chatDrafts.hasThreadActivity,
    drawerThreads,
    pinnedThreadIds,
    productionMode,
  ]);
  const selectableDrawerThreads = useMemo(
    () =>
      visibleDrawerThreads.filter(
        (thread) => !removingThreadIds.includes(thread.id)
      ),
    [removingThreadIds, visibleDrawerThreads]
  );

  const activeThread = useMemo(
    () =>
      selectableDrawerThreads.find((thread) => thread.id === activeThreadId) ||
      selectableDrawerThreads[0] ||
      (productionMode ? emptyProductionThread : mockThreads[0]),
    [activeThreadId, productionMode, selectableDrawerThreads]
  );
  const activeDraft = useChatDraft(
    activeThread?.workspaceSlug,
    activeThread?.threadSlug
  );
  const activeChatKey = useMemo(
    () =>
      chatDrafts.getChatKey(
        activeThread?.workspaceSlug,
        activeThread?.threadSlug
      ),
    [activeThread?.workspaceSlug, activeThread?.threadSlug, chatDrafts]
  );
  const activeThreadActivity = useThreadActivity(
    activeThread?.workspaceSlug,
    activeThread?.threadSlug
  );
  const draftMessages = useMemo(
    () => mobileDraftToMessages(activeDraft),
    [activeDraft]
  );
  const displayPendingSubmitted =
    pendingSubmittedMessageRef.current?.workspaceSlug ===
      activeThread?.workspaceSlug &&
    pendingSubmittedMessageRef.current?.threadSlug === activeThread?.threadSlug
      ? pendingSubmittedMessageRef.current
      : null;
  const displayMergeResult = useMemo(
    () =>
      mergeMobileMessagesWithDraft(messages, draftMessages, {
        pending: displayPendingSubmitted,
      }),
    [messages, draftMessages, displayPendingSubmitted]
  );
  const mutationCutoffChatId = Number(
    chatEditSession?.chatId || chatMutationView?.targetChatId || 0
  );
  const displayMessages = mutationCutoffChatId
    ? displayMergeResult.messages.filter((message) => {
        const chatId = Number(message.chatId || 0);
        return !chatId || chatId < mutationCutoffChatId;
      })
    : displayMergeResult.messages;
  const filteredDraftMessages = displayMergeResult.filteredDraftMessages;
  const filteredDraftMessagesKey = filteredDraftMessages
    .map(
      (message) =>
        `${message.role || "unknown"}:${message.chatId || message.publicChatId || message.id || "local"}:${message.sentAt || "na"}`
    )
    .join("|");
  const activeLocalRuntimeActivity = useMemo(() => {
    if (!localRuntimeActivity) return null;
    return localRuntimeActivity.threadId === activeThread?.id
      ? localRuntimeActivity
      : null;
  }, [activeThread?.id, localRuntimeActivity]);
  const draftRuntimeActivity = useMemo(
    () => mobileRuntimeActivity(activeDraft),
    [activeDraft]
  );
  const mobileRuntimeBusy =
    mobileDraftHasRuntimeActivity(activeDraft) || !!activeLocalRuntimeActivity;
  const runtimeActivity = draftRuntimeActivity || activeLocalRuntimeActivity;
  const pendingRuntimeApproval = activeDraft?.pendingApproval || null;
  const pendingRuntimeClarification = activeDraft?.pendingClarification || null;
  const hasPendingRuntimeIntervention = !!(
    pendingRuntimeApproval || pendingRuntimeClarification
  );
  const pendingRuntimeKey = mobileRuntimeRequestKey({
    pendingApproval: pendingRuntimeApproval,
    pendingClarification: pendingRuntimeClarification,
    activeToolCall: activeDraft?.activeToolCall || null,
  });
  const activeThreadIsOverview =
    !activeThread?.threadSlug || isOverviewThreadItem(activeThread);
  const hasProductionThread =
    !productionMode ||
    (!!activeThread?.workspaceSlug &&
      activeThread.workspaceSlug !== FALLBACK_WORKSPACE_SLUG &&
      visibleDrawerThreads.length > 0);
  const mobileUploadWorkspace = useMemo(
    () => ({
      slug: activeThread?.workspaceSlug,
      name: activeThread?.workspace || activeThread?.workspaceSlug,
    }),
    [activeThread?.workspace, activeThread?.workspaceSlug]
  );
  const mobileAccountUser = mobileSessionUser || auth?.store?.user || null;
  const mobileAccountPfp = mobileSessionUser
    ? mobileSessionPfp
    : currentAccountPfp;
  const handleSyncedThreadDeleted = useCallback(
    (event) => {
      setDrawerThreads((current) =>
        current.filter(
          (thread) =>
            !(
              thread.workspaceSlug === event.workspaceSlug &&
              thread.threadSlug === event.threadSlug
            )
        )
      );
      if (activeThread?.threadSlug === event.threadSlug && productionMode) {
        navigateMobilePath(paths.workspace.chat(event.workspaceSlug), {
          replace: true,
        });
      }
    },
    [activeThread?.threadSlug, navigateMobilePath, productionMode]
  );

  useWorkspaceSyncEvents({
    workspaceSlug: activeThread?.workspaceSlug,
    activeThreadSlug: activeThread?.threadSlug || null,
    enabled:
      productionMode &&
      !!activeThread?.workspaceSlug &&
      activeThread.workspaceSlug !== FALLBACK_WORKSPACE_SLUG,
    onThreadDeleted: handleSyncedThreadDeleted,
  });

  useEffect(() => {
    function handleChatTurnDebug(event) {
      const detail = event?.detail || {};
      mobileChatDebug(`provider:${detail.label || "event"}`, {
        at: detail.at || null,
        ...(detail.payload || {}),
      });
    }

    window.addEventListener("athena:chat-turn-debug", handleChatTurnDebug);
    return () => {
      window.removeEventListener("athena:chat-turn-debug", handleChatTurnDebug);
    };
  }, []);

  useEffect(() => {
    function handlePastedAttachmentEvent(event) {
      const detail = event?.detail || {};
      const files = Array.from(detail.files || []);
      mobileChatDebug("attachment:event-paste-observed", {
        source: detail.source || null,
        count: files.length,
        items: files.map(mobileFileDebugPayload),
      });
    }

    function handleAttachmentsProcessingEvent() {
      mobileChatDebug("attachment:event-processing-observed");
    }

    function handleAttachmentsProcessedEvent() {
      mobileChatDebug("attachment:event-processed-observed");
    }

    window.addEventListener(
      PASTE_ATTACHMENT_EVENT,
      handlePastedAttachmentEvent
    );
    window.addEventListener(
      ATTACHMENTS_PROCESSING_EVENT,
      handleAttachmentsProcessingEvent
    );
    window.addEventListener(
      ATTACHMENTS_PROCESSED_EVENT,
      handleAttachmentsProcessedEvent
    );
    return () => {
      window.removeEventListener(
        PASTE_ATTACHMENT_EVENT,
        handlePastedAttachmentEvent
      );
      window.removeEventListener(
        ATTACHMENTS_PROCESSING_EVENT,
        handleAttachmentsProcessingEvent
      );
      window.removeEventListener(
        ATTACHMENTS_PROCESSED_EVENT,
        handleAttachmentsProcessedEvent
      );
    };
  }, []);

  useEffect(() => {
    mobileChatDebug("debug:mobile-page-mounted", {
      uploadEnabled: mobileClientDebugUploadEnabled(),
      apiBase: API_BASE,
      path: window.location.pathname,
    });
  }, []);

  useEffect(() => {
    if (!mobileSessionSignedOut) return;
    let cancelled = false;

    async function loadPreferredQuickLogin() {
      try {
        const device = await getPreferredLocalZkDevice();
        if (cancelled) return;
        setMobileLoginAccountHint(
          buildMobileLoginAccountHint(
            device,
            mobileAccountUser,
            mobileAccountPfp
          )
        );
        if (device && !forcePasswordLoginRef.current) {
          setMobileLoginInitialMode("quick");
        } else if (!device && mobileLoginInitialMode === "quick") {
          setMobileLoginInitialMode("password");
        }
      } catch {
        if (cancelled) return;
        setMobileLoginAccountHint(
          buildMobileLoginAccountHint(null, mobileAccountUser, mobileAccountPfp)
        );
        if (mobileLoginInitialMode === "quick") {
          setMobileLoginInitialMode("password");
        }
      }
    }

    loadPreferredQuickLogin();
    return () => {
      cancelled = true;
    };
  }, [
    mobileAccountPfp,
    mobileAccountUser,
    mobileAuthRevision,
    mobileLoginInitialMode,
    mobileSessionSignedOut,
  ]);

  const composerDisabledReason = activeThreadIsOverview
    ? "overview"
    : loadingData || loadingThreadHistory
      ? "loading"
      : streaming || mobileRuntimeBusy
        ? "streaming"
        : null;
  const composerDisabled = !!composerDisabledReason;

  function abortActiveMobileHistoryRequest() {
    mobileHistoryRequestRef.current.controller?.abort();
    mobileHistoryRequestRef.current = {
      generation: mobileHistoryRequestRef.current.generation,
      controller: null,
    };
  }

  function beginMobileHistoryRequest(
    thread = activeThread,
    externalSignal = null
  ) {
    abortActiveMobileHistoryRequest();
    const controller = new AbortController();
    const generation = mobileHistoryRequestRef.current.generation + 1;
    mobileHistoryRequestRef.current = { generation, controller };

    const abortFromExternalSignal = () => controller.abort();
    if (externalSignal?.aborted) {
      controller.abort();
    } else if (externalSignal) {
      externalSignal.addEventListener("abort", abortFromExternalSignal, {
        once: true,
      });
    }

    mobileChatDebug("history:mobile-load-start", {
      generation,
      threadId: thread?.id || null,
      workspaceSlug: thread?.workspaceSlug || null,
      threadSlug: thread?.threadSlug || null,
    });

    return {
      generation,
      signal: controller.signal,
      cleanup: () => {
        externalSignal?.removeEventListener?.("abort", abortFromExternalSignal);
        if (mobileHistoryRequestRef.current.controller === controller) {
          mobileHistoryRequestRef.current = { generation, controller: null };
        }
      },
    };
  }

  function mobileHistoryRequestIsCurrent(context, thread = activeThread) {
    return (
      !!context &&
      !context.signal?.aborted &&
      mobileHistoryRequestRef.current.generation === context.generation &&
      (!thread?.id || activeThreadIdRef.current === thread.id)
    );
  }

  function throwIfMobileHistoryAborted(signal = null) {
    if (!signal?.aborted) return;
    const error = new Error("Mobile history request aborted");
    error.name = "AbortError";
    throw error;
  }

  async function hydrateMobileHistory(thread, targets, signal = null) {
    if (!targets?.needsHydration) {
      return { history: [], hydratedChatIds: [], hydratedPublicChatIds: [] };
    }

    const options = {
      signal,
      publicChatIds: targets.publicChatIds,
    };
    return thread.threadSlug
      ? await Workspace.threads.chatHistoryHydration(
          thread.workspaceSlug,
          thread.threadSlug,
          targets.chatIds,
          options
        )
      : await Workspace.chatHistoryHydration(
          thread.workspaceSlug,
          targets.chatIds,
          options
        );
  }

  async function fetchThreadHistoryMessages(
    thread = activeThread,
    signal = null,
    options = {}
  ) {
    if (
      !thread?.workspaceSlug ||
      thread.workspaceSlug === FALLBACK_WORKSPACE_SLUG
    )
      return null;

    const startedAt = performance.now();
    const historyOptions = mobileHistoryRequestOptions({
      limit: options.limit || MOBILE_HISTORY_BOOTSTRAP_LIMIT,
      signal,
    });
    const payload = thread.threadSlug
      ? await Workspace.threads.chatBootstrap(
          thread.workspaceSlug,
          thread.threadSlug,
          historyOptions
        )
      : await Workspace.chatBootstrap(thread.workspaceSlug, historyOptions);
    throwIfMobileHistoryAborted(signal);

    let history = Array.isArray(payload?.history) ? payload.history : [];
    const hydrationTargets = mobileHistoryHydrationTargets(history);
    mobileChatDebug("history:mobile-full-fetch", {
      marker: "mobile-pwa-history-full-request",
      threadId: thread.id,
      workspaceSlug: thread.workspaceSlug,
      threadSlug: thread.threadSlug,
      detail: historyOptions.detail,
      surface: "mobile",
      priorityWindow: historyOptions.priorityWindow,
      historyCount: history.length,
      lightCount: hydrationTargets.lightCount,
      emptyContentCount: hydrationTargets.emptyContentCount,
      durationMs: Math.round(performance.now() - startedAt),
    });

    if (hydrationTargets.needsHydration) {
      const hydrateStartedAt = performance.now();
      const hydration = await hydrateMobileHistory(
        thread,
        hydrationTargets,
        signal
      );
      throwIfMobileHistoryAborted(signal);
      if (Array.isArray(hydration?.history) && hydration.history.length > 0) {
        history = mergeMobileHydratedHistory(history, hydration.history);
      }
      mobileChatDebug(MOBILE_PWA_HISTORY_HYDRATE_MARKER, {
        threadId: thread.id,
        workspaceSlug: thread.workspaceSlug,
        threadSlug: thread.threadSlug,
        requestedChatIds: hydrationTargets.chatIds,
        requestedPublicChatIds: hydrationTargets.publicChatIds,
        hydratedChatIds: hydration?.hydratedChatIds || [],
        hydratedPublicChatIds: hydration?.hydratedPublicChatIds || [],
        hydratedHistoryCount: hydration?.history?.length || 0,
        mergedHistoryCount: history.length,
        durationMs: Math.round(performance.now() - hydrateStartedAt),
      });
    }

    if (Array.isArray(history) && history.length > 0) {
      const pending = currentPendingSubmittedMessage(thread);
      chatDrafts.mergeServerHistory({
        workspaceSlug: thread.workspaceSlug,
        threadSlug: thread.threadSlug,
        history,
        pruneServerBackedItemsOutsideHistory: true,
        preserveTurnIds: [pending?.clientTurnId].filter(Boolean),
      });
    }
    const messages = historyToMessages(history, {
      fallbackToInitial: !productionMode,
      ...options,
    });
    mobileChatDebug("history:mobile-messages-ready", {
      threadId: thread.id,
      workspaceSlug: thread.workspaceSlug,
      threadSlug: thread.threadSlug,
      ...mobileHistoryPayloadSummary(history, messages),
    });
    return messages;
  }

  function currentPendingSubmittedMessage(thread = activeThread) {
    const pending = pendingSubmittedMessageRef.current;
    if (
      pending?.workspaceSlug === thread?.workspaceSlug &&
      pending?.threadSlug === thread?.threadSlug
    ) {
      return pending;
    }

    const stored = readStoredPendingSubmittedMessage(thread);
    if (stored) pendingSubmittedMessageRef.current = stored;
    return stored;
  }

  function localThinkingActivity(thread = activeThread, pending = null) {
    return {
      key: `local-thinking:${thread?.id || "thread"}:${pending?.submittedAt || Date.now()}`,
      threadId: thread?.id,
      label: "正在思考",
      startedAt: Date.now(),
    };
  }

  function clearLocalRuntimeActivity(thread = activeThread) {
    setLocalRuntimeActivity((current) =>
      current?.threadId === thread?.id ? null : current
    );
  }

  function applyThreadHistoryMessages(
    thread = activeThread,
    nextMessages = null,
    { force = false, reason = "history-apply" } = {}
  ) {
    if (!nextMessages) return null;

    const pending = currentPendingSubmittedMessage(thread);
    const protectsPendingRuntime =
      thread?.id === activeThreadIdRef.current && hasPendingRuntimeIntervention;
    const historyIncludesPending = pending
      ? historyIncludesSubmittedMessage(
          nextMessages,
          pending.text,
          pending.submittedAt,
          {
            clientTurnId: pending.clientTurnId || null,
            hasAttachments: pendingSubmittedHasAttachments(pending),
          }
        )
      : false;
    const historyHasPendingAssistant =
      pending && historyIncludesPending
        ? historyHasAssistantAfterSubmitted(
            nextMessages,
            pending.text,
            pending.submittedAt,
            pending.clientTurnId || null,
            { hasAttachments: pendingSubmittedHasAttachments(pending) }
          )
        : false;
    const weakPendingAssistantMessages =
      pending && historyIncludesPending
        ? weakAssistantMessagesForPending(nextMessages, pending)
        : [];
    const latestServerAssistant =
      latestIdentifiedAssistantMessage(nextMessages);
    const activeDraftAssistant = mobileActiveAssistantTurn(activeDraft);
    const activeDraftAssistantIdentity =
      activeDraftAssistant?.publicChatId ||
      activeDraftAssistant?.chatId ||
      null;
    const latestServerAssistantIdentity = messageIdentity(
      latestServerAssistant
    );
    const latestServerMatchesPending =
      pending && latestServerAssistant
        ? messageWithinSubmittedWindow(
            latestServerAssistant,
            pending.submittedAt
          )
        : null;

    if (
      pending &&
      latestServerAssistant &&
      (!latestServerMatchesPending ||
        (activeDraftAssistantIdentity &&
          latestServerAssistantIdentity &&
          activeDraftAssistantIdentity !== latestServerAssistantIdentity &&
          latestServerMatchesPending))
    ) {
      mobileChatDebug("turn-identity-mismatch", {
        threadId: thread?.id || null,
        reason,
        pending: {
          submittedAt: pending.submittedAt,
          textLength: normalizedText(pending.text).length,
        },
        activeDraftAssistant: activeDraftAssistant
          ? {
              turnId: activeDraftAssistant.turnId || null,
              status: activeDraftAssistant.status || null,
              chatId: activeDraftAssistant.chatId || null,
              publicChatId: activeDraftAssistant.publicChatId || null,
              createdAt: sentAtFromTurnTimestamp(
                activeDraftAssistant.createdAt
              ),
            }
          : null,
        latestServerAssistant: {
          id: latestServerAssistant.id || null,
          chatId: latestServerAssistant.chatId || null,
          publicChatId: latestServerAssistant.publicChatId || null,
          sentAt: latestServerAssistant.sentAt || null,
          matchesPendingWindow: latestServerMatchesPending,
        },
      });
    }

    mobileChatDebug("history:apply", {
      threadId: thread?.id || null,
      force,
      reason,
      nextCount: nextMessages.length,
      pending: pending
        ? {
            submittedAt: pending.submittedAt,
            attempts: pending.attempts || 0,
            persisted: !!pending.persisted,
            hasMessageId: !!pending.messageId,
            textLength: normalizedText(pending.text).length,
          }
        : null,
      historyIncludesPending,
      historyHasPendingAssistant,
      weakPendingAssistantCount: weakPendingAssistantMessages.length,
      protectsPendingRuntime,
      latestServerAssistant: latestServerAssistant
        ? {
            ...assistantPayloadSummary(latestServerAssistant),
            matchesPendingWindow: latestServerMatchesPending,
          }
        : null,
      activeDraftAssistant: activeDraftAssistant
        ? {
            turnId: activeDraftAssistant.turnId || null,
            status: activeDraftAssistant.status || null,
            chatId: activeDraftAssistant.chatId || null,
            publicChatId: activeDraftAssistant.publicChatId || null,
          }
        : null,
    });

    if (pending && historyIncludesPending) {
      if (historyHasPendingAssistant) {
        setMessages(nextMessages);
        mobileChatDebug("history:server-payload-replaced-draft", {
          threadId: thread?.id || null,
          submittedAt: pending.submittedAt,
          clientTurnId: pending.clientTurnId || null,
          hasAttachments: pendingSubmittedHasAttachments(pending),
          reason,
          assistant: latestServerAssistant
            ? assistantPayloadSummary(latestServerAssistant)
            : null,
        });
        mobileChatDebug("pending:clear-server-confirmed", {
          threadId: thread?.id || null,
          submittedAt: pending.submittedAt,
          clientTurnId: pending.clientTurnId || null,
          reason,
        });
        mobileChatDebug("pending:server-confirmed-window", {
          threadId: thread?.id || null,
          submittedAt: pending.submittedAt,
          clientTurnId: pending.clientTurnId || null,
          hasAttachments: pendingSubmittedHasAttachments(pending),
          reason,
        });
        mobileChatDebug("history:server-confirmed-after-draft", {
          threadId: thread?.id || null,
          submittedAt: pending.submittedAt,
          reason,
          nextCount: nextMessages.length,
        });
        clearPendingSubmittedMessage(thread);
        clearLocalRuntimeActivity(thread);
        return nextMessages;
      } else {
        const displaySafeMessages = removeWeakAssistantMessagesForPending(
          nextMessages,
          pending
        );
        setMessages(displaySafeMessages);
        if (weakPendingAssistantMessages.length) {
          mobileChatDebug("history:weak-server-payload-preserved-draft", {
            threadId: thread?.id || null,
            submittedAt: pending.submittedAt,
            clientTurnId: pending.clientTurnId || null,
            hasAttachments: pendingSubmittedHasAttachments(pending),
            reason,
            weakAssistants: weakPendingAssistantMessages.map(
              assistantPayloadSummary
            ),
          });
          mobileChatDebug("history:refresh-skipped-weaker-than-draft", {
            threadId: thread?.id || null,
            submittedAt: pending.submittedAt,
            clientTurnId: pending.clientTurnId || null,
            reason,
            displayCount: displaySafeMessages.length,
            originalCount: nextMessages.length,
          });
        }
        const nextPending = { ...pending, persisted: true };
        pendingSubmittedMessageRef.current = nextPending;
        storePendingSubmittedMessage(nextPending);
        if (!draftRuntimeActivity && !activeLocalRuntimeActivity) {
          setLocalRuntimeActivity(localThinkingActivity(thread, nextPending));
        }
        if (
          (pending.attempts || 0) < MOBILE_PENDING_HISTORY_MAX_ATTEMPTS &&
          activeThreadIdRef.current === thread.id
        ) {
          schedulePendingHistoryRefresh(thread, 900);
        }
        return displaySafeMessages;
      }
    }

    if (!force && protectsPendingRuntime) return null;

    const mergedMessages = pending
      ? mergePendingSubmittedMessage(nextMessages, pending)
      : nextMessages;
    mobileChatDebug("history:set-messages", {
      threadId: thread?.id || null,
      reason,
      pendingMerged: !!pending,
      mergedCount: mergedMessages.length,
    });
    setMessages(mergedMessages);
    return mergedMessages;
  }

  async function loadThreadHistory(thread = activeThread, signal = null) {
    const historyContext = beginMobileHistoryRequest(thread, signal);
    if (thread?.id && activeThreadIdRef.current === thread.id) {
      setLoadingThreadHistory(true);
    }
    try {
      const nextMessages = await fetchThreadHistoryMessages(
        thread,
        historyContext.signal
      );
      if (!mobileHistoryRequestIsCurrent(historyContext, thread)) return null;
      const appliedMessages = applyThreadHistoryMessages(thread, nextMessages, {
        reason: "load-thread-history",
      });
      const pending = currentPendingSubmittedMessage(thread);
      if (
        pending &&
        nextMessages &&
        !historyIncludesSubmittedMessage(
          nextMessages,
          pending.text,
          pending.submittedAt,
          {
            clientTurnId: pending.clientTurnId || null,
            hasAttachments: pendingSubmittedHasAttachments(pending),
          }
        )
      ) {
        schedulePendingHistoryRefresh(thread, 900);
      }
      return appliedMessages || nextMessages;
    } finally {
      historyContext.cleanup();
      if (thread?.id && activeThreadIdRef.current === thread.id) {
        setLoadingThreadHistory(false);
      }
    }
  }

  function schedulePendingHistoryRefresh(thread = activeThread, delay = 900) {
    if (!thread?.id) return;
    clearTimeout(pendingHistoryRefreshTimerRef.current);
    mobileChatDebug("history:schedule-pending-refresh", {
      threadId: thread.id,
      delay,
    });
    pendingHistoryRefreshTimerRef.current = window.setTimeout(() => {
      if (activeThreadIdRef.current !== thread.id) return;
      refreshThreadHistoryAfterRuntime(thread, {
        reason: "pending-history-refresh",
      }).catch(() => {});
    }, delay);
  }

  function updatePendingSubmittedAttempts(thread = activeThread, attempts = 0) {
    const pending = currentPendingSubmittedMessage(thread);
    if (!pending) return null;
    const nextPending = { ...pending, attempts };
    pendingSubmittedMessageRef.current = nextPending;
    storePendingSubmittedMessage(nextPending);
    return nextPending;
  }

  function clearPendingSubmittedMessage(thread = activeThread) {
    const pending = pendingSubmittedMessageRef.current;
    const matchesPending =
      pending?.workspaceSlug === thread?.workspaceSlug &&
      pending?.threadSlug === thread?.threadSlug;
    if (matchesPending) {
      pendingSubmittedMessageRef.current = null;
      clearStoredPendingSubmittedMessage(pending);
    }
    clearStoredPendingSubmittedMessage(thread);
    clearLocalRuntimeActivity(thread);
    if (thread?.workspaceSlug) {
      if (matchesPending && pending?.clientTurnId) {
        const cleared = chatDrafts.clearConfirmedLocalTurn?.({
          workspaceSlug: thread.workspaceSlug,
          threadSlug: thread.threadSlug,
          turnId: pending.clientTurnId,
        });
        mobileChatDebug("draft:orphan-runtime-cleared", {
          threadId: thread?.id || null,
          workspaceSlug: thread.workspaceSlug,
          threadSlug: thread.threadSlug,
          clientTurnId: pending.clientTurnId,
          cleared: !!cleared,
        });
      }
      chatDrafts.clearThreadActivity(thread.workspaceSlug, thread.threadSlug);
    }
    clearTimeout(pendingHistoryRefreshTimerRef.current);
  }

  function markPendingStreamStalled(
    thread = activeThread,
    pending = null,
    details = {}
  ) {
    if (
      !pendingSubmittedMatchesTurn(
        currentPendingSubmittedMessage(thread),
        pending
      )
    )
      return;

    const reason = "实时连接暂时中断，正在恢复已提交的回复。";
    mobileChatDebug("pending:stream-stalled", {
      threadId: thread?.id || null,
      workspaceSlug: thread?.workspaceSlug || null,
      threadSlug: thread?.threadSlug || null,
      submittedAt: pending?.submittedAt || null,
      clientTurnId: pending?.clientTurnId || null,
      ageMs: pending ? Date.now() - pendingSubmittedCreatedAtMs(pending) : null,
      recoveryMessage: reason,
      ...details,
    });

    setStreaming(false);
    sendInFlightRef.current = false;
    setActionError(null);
    const reconnectingPending = {
      ...pending,
      attempts: 0,
      reconnectingAtMs: Date.now(),
    };
    pendingSubmittedMessageRef.current = reconnectingPending;
    storePendingSubmittedMessage(reconnectingPending);
    setLocalRuntimeActivity({
      ...localThinkingActivity(thread, reconnectingPending),
      label: "正在恢复回复",
    });
    schedulePendingHistoryRefresh(thread, 250);
  }

  async function refreshThreadHistoryAfterRuntime(
    thread = activeThread,
    { force = false, reason = "runtime-idle" } = {}
  ) {
    if (
      !force &&
      thread?.id === activeThreadIdRef.current &&
      hasPendingRuntimeIntervention
    ) {
      return null;
    }

    const pending = currentPendingSubmittedMessage(thread);
    const nextMessages = await fetchThreadHistoryMessages(thread);
    if (thread?.id && activeThreadIdRef.current !== thread.id) return null;
    if (!nextMessages) return null;
    mobileChatDebug("history:refresh-after-runtime", {
      threadId: thread?.id || null,
      force,
      reason,
      nextCount: nextMessages.length,
      pending: pending
        ? {
            submittedAt: pending.submittedAt,
            attempts: pending.attempts || 0,
            persisted: !!pending.persisted,
            textLength: normalizedText(pending.text).length,
          }
        : null,
    });

    if (!pending) {
      applyThreadHistoryMessages(thread, nextMessages, { force, reason });
      return nextMessages;
    }

    if (
      historyIncludesSubmittedMessage(
        nextMessages,
        pending.text,
        pending.submittedAt,
        {
          clientTurnId: pending.clientTurnId || null,
          hasAttachments: pendingSubmittedHasAttachments(pending),
        }
      )
    ) {
      applyThreadHistoryMessages(thread, nextMessages, {
        force: true,
        reason,
      });
      if (
        historyHasAssistantAfterSubmitted(
          nextMessages,
          pending.text,
          pending.submittedAt,
          pending.clientTurnId || null,
          { hasAttachments: pendingSubmittedHasAttachments(pending) }
        )
      ) {
        mobileChatDebug("history:server-confirmed-after-draft", {
          threadId: thread?.id || null,
          submittedAt: pending.submittedAt,
          clientTurnId: pending.clientTurnId || null,
          reason,
          nextCount: nextMessages.length,
        });
        mobileChatDebug("pending:server-confirmed-window", {
          threadId: thread?.id || null,
          submittedAt: pending.submittedAt,
          clientTurnId: pending.clientTurnId || null,
          hasAttachments: pendingSubmittedHasAttachments(pending),
          reason,
        });
        clearPendingSubmittedMessage(thread);
        clearLocalRuntimeActivity(thread);
        return nextMessages;
      }
    }

    applyThreadHistoryMessages(thread, nextMessages, { force: true, reason });

    if (
      (pending.attempts || 0) >= MOBILE_PENDING_HISTORY_MAX_ATTEMPTS ||
      activeThreadIdRef.current !== thread.id
    ) {
      return nextMessages;
    }

    const nextAttempts = (pending.attempts || 0) + 1;
    updatePendingSubmittedAttempts(thread, nextAttempts);
    schedulePendingHistoryRefresh(
      thread,
      Math.min(
        MOBILE_PENDING_HISTORY_MAX_DELAY_MS,
        MOBILE_PENDING_HISTORY_BASE_DELAY_MS + nextAttempts * 700
      )
    );

    return nextMessages;
  }

  async function refreshMemoryStatus(thread = activeThread) {
    memoryStatusRequestRef.current.controller?.abort();

    if (
      !thread?.workspaceSlug ||
      !thread?.threadSlug ||
      thread.workspaceSlug === FALLBACK_WORKSPACE_SLUG
    ) {
      setMemoryStatus(null);
      setMemoryLoading(false);
      setMemoryUnavailable(true);
      return;
    }

    const controller = new AbortController();
    const requestId = memoryStatusRequestRef.current.id + 1;
    memoryStatusRequestRef.current = { id: requestId, controller };
    setMemoryLoading(true);
    setMemoryUnavailable(false);

    try {
      const result = await Workspace.threads.compactionStatus(
        thread.workspaceSlug,
        thread.threadSlug,
        { signal: controller.signal }
      );
      if (memoryStatusRequestRef.current.id !== requestId) return;
      setMemoryStatus(result?.success ? result.status || null : null);
      setMemoryUnavailable(false);
    } catch (error) {
      if (error?.name === "AbortError") return;
      if (memoryStatusRequestRef.current.id !== requestId) return;
      setMemoryStatus(null);
      setMemoryUnavailable(false);
    } finally {
      if (memoryStatusRequestRef.current.id === requestId) {
        setMemoryLoading(false);
      }
    }
  }

  const scrollMobileTailIntoView = useCallback(
    ({ focusRuntimeSheet = false, force = false } = {}) => {
      if (typeof window === "undefined") return;
      if (!force && !mobileShouldFollowRef.current) {
        setMobileHasNewMessages(true);
        return;
      }
      mobileShouldFollowRef.current = true;
      setMobileHasNewMessages(false);

      const scrollOnce = () => {
        const chatPane = chatPaneRef.current;
        if (chatPane) {
          chatPane.scrollTo({
            top: chatPane.scrollHeight,
            behavior: "auto",
          });
        } else {
          messagesEndRef.current?.scrollIntoView({
            block: "end",
            inline: "nearest",
          });
        }
        if (focusRuntimeSheet) {
          runtimeSheetRef.current?.focus?.({ preventScroll: true });
        }
      };

      window.requestAnimationFrame(() => {
        scrollOnce();
        window.setTimeout(scrollOnce, 120);
      });
    },
    []
  );

  const handleMobileChatScroll = useCallback((event) => {
    const element = event.currentTarget;
    const nextScrollTop = element.scrollTop;
    const bottomGap =
      element.scrollHeight - nextScrollTop - element.clientHeight;
    const movedUp = nextScrollTop < mobileLastScrollTopRef.current - 1;
    if (bottomGap <= 48) {
      mobileShouldFollowRef.current = true;
      setMobileHasNewMessages(false);
    } else if (movedUp) {
      mobileShouldFollowRef.current = false;
    }
    mobileLastScrollTopRef.current = nextScrollTop;
  }, []);

  const leaveMobileFollow = useCallback(() => {
    mobileShouldFollowRef.current = false;
  }, []);

  const mobileTailSignature = useMemo(() => {
    const tail = displayMessages[displayMessages.length - 1];
    return [
      tail?.id || "empty",
      tail?.role || "",
      tail?.text?.length || 0,
      runtimeActivity?.key || "",
    ].join(":");
  }, [displayMessages, runtimeActivity?.key]);

  useEffect(() => {
    const tail = displayMessages[displayMessages.length - 1];
    scrollMobileTailIntoView({ force: tail?.role === "user" });
  }, [mobileTailSignature, scrollMobileTailIntoView]);

  useEffect(() => {
    if (!filteredDraftMessages.length) return;
    mobileChatDebug("mobile:filtered-stale-draft-messages", {
      threadId: activeThread?.id || null,
      filteredCount: filteredDraftMessages.length,
      filteredDraftMessages,
      persistedCount: messages.length,
      draftCount: draftMessages.length,
      displayCount: displayMessages.length,
    });
  }, [
    activeThread?.id,
    displayMessages.length,
    draftMessages.length,
    filteredDraftMessages,
    filteredDraftMessagesKey,
    messages.length,
  ]);

  useEffect(() => {
    const pending = currentPendingSubmittedMessage(activeThread);
    if (!pending) return;
    const displayConfirmed = displayHasConfirmedAssistantAfterSubmitted(
      displayMessages,
      pending.text,
      pending.submittedAt,
      pending.clientTurnId || null,
      { hasAttachments: pendingSubmittedHasAttachments(pending) }
    );
    const draftSettledAssistant = mobileDraftSettledAssistantAfterSubmitted(
      activeDraft,
      pending
    );
    const shouldClearVisualRuntime =
      !hasPendingRuntimeIntervention &&
      (displayConfirmed || !!draftSettledAssistant);
    mobileChatDebug("pending:display-check", {
      threadId: activeThread?.id || null,
      submittedAt: pending.submittedAt,
      clientTurnId: pending.clientTurnId || null,
      displayCount: displayMessages.length,
      filteredDraftCount: filteredDraftMessages.length,
      displayConfirmed,
      shouldClearVisualRuntime,
      hasLocalRuntime: !!activeLocalRuntimeActivity,
      hasDraftRuntime: !!draftRuntimeActivity,
      hasPendingRuntimeIntervention,
      draft: {
        activeTurnId: activeDraft?.activeTurnId || null,
        isStreaming: !!activeDraft?.isStreaming,
        isAgentRunning: !!activeDraft?.isAgentRunning,
        tailHydrationSeq: activeDraft?.tailHydration?.seq || null,
        persistError: activeDraft?.persistError || null,
        settledAssistant: draftSettledAssistant,
        assistantSummaries: mobileAssistantTurns(activeDraft)
          .slice(-3)
          .map(mobileAssistantTurnSummary),
      },
      assistantSummaries: displayMessages
        .filter((message) => message.role === "assistant")
        .slice(-3)
        .map((message) => ({
          id: message.id,
          status: message.status || null,
          chatId: message.chatId || null,
          publicChatId: message.publicChatId || null,
          hasChatIdentity: messageHasChatIdentity(message),
          hasPayload: messageHasAssistantPayload(message),
          textLength: normalizedText(message.text).length,
          timelineLength: message.timeline?.length || 0,
          outputCount: message.outputs?.length || 0,
          clarificationCount: message.clarifyingQuestions?.length || 0,
          error: message.error ? String(message.error).slice(0, 160) : null,
        })),
    });
    if (!shouldClearVisualRuntime) return;

    mobileChatDebug("pending:clear-local-runtime-display-confirmed", {
      threadId: activeThread?.id || null,
      submittedAt: pending.submittedAt,
      clientTurnId: pending.clientTurnId || null,
      source: displayConfirmed ? "display" : "draft",
      draftSettledAssistant,
    });
    clearLocalRuntimeActivity(activeThread);
    if (displayConfirmed) {
      mobileChatDebug("pending:server-confirmed-window", {
        threadId: activeThread?.id || null,
        submittedAt: pending.submittedAt,
        clientTurnId: pending.clientTurnId || null,
        hasAttachments: pendingSubmittedHasAttachments(pending),
        reason: "display-confirmed",
      });
      clearPendingSubmittedMessage(activeThread);
    }
  }, [
    activeLocalRuntimeActivity,
    activeDraft,
    activeThread,
    activeThread.id,
    displayMessages,
    draftRuntimeActivity,
    filteredDraftMessages.length,
    hasPendingRuntimeIntervention,
  ]);

  useEffect(() => {
    const pending = currentPendingSubmittedMessage(activeThread);
    if (!pending) return undefined;

    function emitPendingHeartbeat() {
      const currentPending = currentPendingSubmittedMessage(activeThread);
      if (!currentPending) return;
      mobileChatDebug("pending:heartbeat", {
        threadId: activeThread?.id || null,
        workspaceSlug: activeThread?.workspaceSlug || null,
        threadSlug: activeThread?.threadSlug || null,
        submittedAt: currentPending.submittedAt,
        attempts: currentPending.attempts || 0,
        persisted: !!currentPending.persisted,
        displayCount: displayMessages.length,
        filteredDraftCount: filteredDraftMessages.length,
        hasLocalRuntime: !!activeLocalRuntimeActivity,
        hasDraftRuntime: !!draftRuntimeActivity,
        mobileRuntimeBusy,
        streaming,
        sendInFlight: !!sendInFlightRef.current,
        draft: {
          activeTurnId: activeDraft?.activeTurnId || null,
          isStreaming: !!activeDraft?.isStreaming,
          isAgentRunning: !!activeDraft?.isAgentRunning,
          activeToolCall: activeDraft?.activeToolCall
            ? mobileRuntimeToolKey(activeDraft.activeToolCall) || "active"
            : null,
          pendingApproval: activeDraft?.pendingApproval?.requestId || null,
          pendingClarification:
            activeDraft?.pendingClarification?.requestId || null,
          tailHydrationSeq: activeDraft?.tailHydration?.seq || null,
          tailCleanupSeq: activeDraft?.tailCleanup?.seq || null,
          persistError: activeDraft?.persistError || null,
          assistantSummaries: mobileAssistantTurns(activeDraft)
            .slice(-3)
            .map(mobileAssistantTurnSummary),
        },
        latestMessages: displayMessages.slice(-5).map((message) => ({
          id: message.id,
          role: message.role,
          status: message.status || null,
          chatId: message.chatId || null,
          publicChatId: message.publicChatId || null,
          sentAt: message.sentAt || null,
          textLength: normalizedText(message.text).length,
          timelineLength: message.timeline?.length || 0,
          outputCount: message.outputs?.length || 0,
          clarificationCount: message.clarifyingQuestions?.length || 0,
        })),
      });
    }

    emitPendingHeartbeat();
    const interval = window.setInterval(emitPendingHeartbeat, 3_000);
    return () => window.clearInterval(interval);
  }, [
    activeDraft,
    activeLocalRuntimeActivity,
    activeThread,
    activeThread.id,
    displayMessages,
    filteredDraftMessages.length,
    draftRuntimeActivity,
    mobileRuntimeBusy,
    streaming,
  ]);

  useEffect(() => {
    const pending = currentPendingSubmittedMessage(activeThread);
    if (
      !pending ||
      pending.reconnectingAtMs ||
      activeThreadIsOverview ||
      hasPendingRuntimeIntervention ||
      sendInFlightRef.current
    ) {
      return undefined;
    }

    const displayConfirmed = displayHasConfirmedAssistantAfterSubmitted(
      displayMessages,
      pending.text,
      pending.submittedAt,
      pending.clientTurnId || null,
      { hasAttachments: pendingSubmittedHasAttachments(pending) }
    );
    if (displayConfirmed) return undefined;

    const hasDraftRuntime =
      mobileDraftHasRuntimeActivity(activeDraft) || !!draftRuntimeActivity;
    if (hasDraftRuntime) return undefined;

    const recoveryKey = `${activeThread?.id || "thread"}:${pending.clientTurnId || pending.submittedAt}`;
    const activityMatchesPending =
      !!pending.clientTurnId &&
      activeThreadActivity?.turnId === pending.clientTurnId;
    const acceptedByServer =
      activityMatchesPending && !!activeThreadActivity?.acceptedByServer;

    if (
      activityMatchesPending &&
      pendingOrphanRecoveryKeyRef.current !== recoveryKey
    ) {
      pendingOrphanRecoveryKeyRef.current = recoveryKey;
      const restored = chatDrafts.restoreRunningTurnSnapshot?.({
        workspaceSlug: activeThread.workspaceSlug,
        threadSlug: activeThread.threadSlug,
        turnId: pending.clientTurnId,
      });
      mobileChatDebug("pending:orphaned-running-turn", {
        threadId: activeThread?.id || null,
        submittedAt: pending.submittedAt,
        clientTurnId: pending.clientTurnId || null,
        acceptedByServer,
        action: restored ? "restored" : "restore-unavailable",
      });
      if (restored) return undefined;
    }

    const ageMs = Date.now() - pendingSubmittedCreatedAtMs(pending);
    const stallLimitMs = acceptedByServer
      ? MOBILE_PENDING_ORPHAN_STALL_MS
      : MOBILE_PENDING_UNACCEPTED_STALL_MS;
    const remainingMs = stallLimitMs - ageMs;

    if (remainingMs <= 0) {
      markPendingStreamStalled(activeThread, pending, {
        acceptedByServer,
        reason: acceptedByServer
          ? "accepted_without_active_draft_or_history"
          : "unaccepted_without_active_draft_or_history",
      });
      return undefined;
    }

    const timeout = window.setTimeout(
      () => {
        if (activeThreadIdRef.current !== activeThread.id) return;

        refreshThreadHistoryAfterRuntime(activeThread, {
          force: true,
          reason: "pending-orphan-stall-check",
        }).finally(() => {
          const latestPending = currentPendingSubmittedMessage(activeThread);
          if (!pendingSubmittedMatchesTurn(latestPending, pending)) return;

          const latestDraft = chatDrafts.getDraft(
            activeThread.workspaceSlug,
            activeThread.threadSlug
          );
          if (
            latestDraft?.pendingApproval ||
            latestDraft?.pendingClarification ||
            mobileDraftHasRuntimeActivity(latestDraft)
          ) {
            return;
          }

          const latestActivity = chatDrafts.getThreadActivity(
            activeThread.workspaceSlug,
            activeThread.threadSlug
          );
          if (
            latestPending?.clientTurnId &&
            latestActivity?.turnId === latestPending.clientTurnId
          ) {
            const restored = chatDrafts.restoreRunningTurnSnapshot?.({
              workspaceSlug: activeThread.workspaceSlug,
              threadSlug: activeThread.threadSlug,
              turnId: latestPending.clientTurnId,
            });
            mobileChatDebug("pending:orphaned-running-turn", {
              threadId: activeThread?.id || null,
              submittedAt: latestPending.submittedAt,
              clientTurnId: latestPending.clientTurnId || null,
              acceptedByServer: !!latestActivity.acceptedByServer,
              action: restored
                ? "restored-after-refresh"
                : "restore-unavailable",
            });
            if (restored) return;
          }

          const latestAgeMs =
            Date.now() - pendingSubmittedCreatedAtMs(latestPending);
          const latestAccepted =
            latestPending?.clientTurnId &&
            latestActivity?.turnId === latestPending.clientTurnId &&
            !!latestActivity.acceptedByServer;
          const latestLimitMs = latestAccepted
            ? MOBILE_PENDING_ORPHAN_STALL_MS
            : MOBILE_PENDING_UNACCEPTED_STALL_MS;
          if (latestAgeMs < latestLimitMs) return;

          markPendingStreamStalled(activeThread, latestPending, {
            acceptedByServer: !!latestAccepted,
            reason: latestAccepted
              ? "accepted_without_active_draft_or_history_after_refresh"
              : "unaccepted_without_active_draft_or_history_after_refresh",
          });
        });
      },
      Math.max(250, remainingMs)
    );

    return () => window.clearTimeout(timeout);
  }, [
    activeDraft,
    activeThread,
    activeThread.id,
    activeThread.workspaceSlug,
    activeThread.threadSlug,
    activeThreadActivity,
    activeThreadIsOverview,
    chatDrafts,
    displayMessages,
    draftRuntimeActivity,
    hasPendingRuntimeIntervention,
  ]);

  useEffect(() => {
    const pending = currentPendingSubmittedMessage(activeThread);
    if (!pending) return;

    const settledAssistant = mobileDraftSettledAssistantAfterSubmitted(
      activeDraft,
      pending
    );
    const tailHydrationSeq = Number(activeDraft?.tailHydration?.seq || 0);
    if (!settledAssistant && !tailHydrationSeq) return;

    const refreshKey = [
      activeThread?.id || "thread",
      pending.submittedAt || "pending",
      settledAssistant?.turnId || "tail-hydration",
      settledAssistant?.status || "pending",
      settledAssistant?.chatId ||
        settledAssistant?.publicChatId ||
        "no-chat-id",
      settledAssistant?.textLength || 0,
      settledAssistant?.timelineLength || 0,
      tailHydrationSeq,
    ].join(":");
    if (draftSettledRefreshKeyRef.current === refreshKey) return;
    draftSettledRefreshKeyRef.current = refreshKey;

    const reason = settledAssistant ? "draft-settled" : "draft-tail-hydration";
    mobileChatDebug("draft:settled-refresh", {
      threadId: activeThread?.id || null,
      submittedAt: pending.submittedAt,
      reason,
      tailHydrationSeq: tailHydrationSeq || null,
      settledAssistant,
    });

    if (settledAssistant) clearLocalRuntimeActivity(activeThread);
    if (pending.attempts) updatePendingSubmittedAttempts(activeThread, 0);
    refreshThreadHistoryAfterRuntime(activeThread, {
      force: true,
      reason,
    }).catch(() => {});
  }, [activeDraft, activeThread, activeThread.id]);

  useEffect(() => {
    if (!pendingRuntimeKey) return;
    scrollMobileTailIntoView({
      focusRuntimeSheet: hasPendingRuntimeIntervention,
    });
  }, [
    hasPendingRuntimeIntervention,
    pendingRuntimeKey,
    scrollMobileTailIntoView,
  ]);

  useEffect(() => {
    if (selectableDrawerThreads.some((thread) => thread.id === activeThreadId))
      return;
    setActiveThreadId(
      selectableDrawerThreads[0]?.id ||
        (productionMode ? null : mockThreads[0].id)
    );
  }, [activeThreadId, productionMode, selectableDrawerThreads]);

  useEffect(() => {
    activeThreadIdRef.current = activeThread.id;
  }, [activeThread.id]);

  useEffect(() => {
    const wasBusy = lastRuntimeBusyRef.current;
    lastRuntimeBusyRef.current = mobileRuntimeBusy;
    if (
      !wasBusy ||
      mobileRuntimeBusy ||
      activeThreadIsOverview ||
      activeThread.workspaceSlug === FALLBACK_WORKSPACE_SLUG
    ) {
      return undefined;
    }

    const timeout = window.setTimeout(() => {
      if (activeThreadIdRef.current !== activeThread.id) return;
      refreshThreadHistoryAfterRuntime(activeThread).catch(() => {});
      refreshMemoryStatus(activeThread).catch(() => {});
    }, 650);

    return () => window.clearTimeout(timeout);
  }, [
    activeThread,
    activeThread.id,
    activeThread.workspaceSlug,
    activeThreadIsOverview,
    mobileRuntimeBusy,
  ]);

  useEffect(() => {
    refreshMemoryStatus(activeThread);
    return () => {
      memoryStatusRequestRef.current.controller?.abort();
    };
  }, [activeThread.id]);

  useEffect(() => {
    if (!activeThreadIsOverview) return;
    setInput("");
    setQuizMode(false);
    setRecording(false);
    setAttachmentSheetOpen(false);
  }, [activeThreadIsOverview, activeThread.id]);

  useEffect(() => {
    setChatEditSession(null);
    setChatMutationView(null);
    setMessageActionBusy(null);
    setCopiedMessageId(null);
    setSpeakingMessageId(null);
    setAttachmentSheetOpen(false);
    const storedPending = readStoredPendingSubmittedMessage(activeThread);
    pendingSubmittedMessageRef.current = storedPending;
    if (storedPending) {
      setLocalRuntimeActivity(
        localThinkingActivity(activeThread, storedPending)
      );
    } else {
      clearTimeout(pendingHistoryRefreshTimerRef.current);
      clearLocalRuntimeActivity(activeThread);
    }
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
  }, [activeThread.id, activeThread.threadSlug, activeThread.workspaceSlug]);

  useEffect(() => {
    return () => {
      if (mobileSessionPfp) URL.revokeObjectURL(mobileSessionPfp);
    };
  }, [mobileSessionPfp]);

  useEffect(() => {
    return () => {
      clearTimeout(copiedTimerRef.current);
      clearTimeout(pendingHistoryRefreshTimerRef.current);
      if (typeof window !== "undefined" && window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    async function loadRealData() {
      setLoadingData(true);
      setLoadingThreadHistory(false);
      setDataError(null);
      try {
        const workspaces = await Workspace.all();
        const loadedWorkspaceSlugs = new Set();
        const loadVisibleWorkspaceThreads = async (workspace) => {
          if (!workspace?.slug) return [];
          const { threads = [] } = await Workspace.threads.all(workspace.slug);
          loadedWorkspaceSlugs.add(workspace.slug);
          return threads
            .filter((thread) => thread?.slug)
            .map((thread) => threadToDrawerItem(workspace, thread))
            .filter(isVisibleThreadItem);
        };

        const preferredWorkspace =
          workspaces.find(
            (workspace) => workspace?.slug === initialWorkspaceSlug
          ) || workspaces[0];
        let visibleThreads = preferredWorkspace
          ? await loadVisibleWorkspaceThreads(preferredWorkspace)
          : [];

        if (!visibleThreads.length) {
          for (const workspace of workspaces) {
            if (!workspace?.slug || loadedWorkspaceSlugs.has(workspace.slug))
              continue;
            const workspaceThreads =
              await loadVisibleWorkspaceThreads(workspace);
            visibleThreads = [...visibleThreads, ...workspaceThreads];
            if (visibleThreads.length) break;
          }
        }

        window.setTimeout(async () => {
          for (const workspace of workspaces) {
            if (
              controller.signal.aborted ||
              !workspace?.slug ||
              loadedWorkspaceSlugs.has(workspace.slug)
            ) {
              continue;
            }

            const workspaceThreads =
              await loadVisibleWorkspaceThreads(workspace);
            if (controller.signal.aborted || !workspaceThreads.length) continue;
            setDrawerThreads((current) => {
              const byId = new Map(
                current.map((thread) => [thread.id, thread])
              );
              for (const thread of workspaceThreads)
                byId.set(thread.id, thread);
              return Array.from(byId.values());
            });
          }
        }, 0);

        if (!visibleThreads.length) {
          setDrawerThreads(productionMode ? [] : mockThreads);
          setActiveThreadId(productionMode ? null : mockThreads[0].id);
          setMessages(productionMode ? [] : initialMessages);
          setDataError("当前账号暂无可展示的 workspace/thread。");
          return;
        }

        const nextThread =
          findInitialMobileThread(
            visibleThreads,
            initialWorkspaceSlug,
            initialThreadSlug
          ) || visibleThreads[0];

        setDrawerThreads(visibleThreads);
        activeThreadIdRef.current = nextThread.id;
        setActiveThreadId(nextThread.id);
        navigateMobileThread(nextThread, { replace: true });
        setMessages([]);
        await loadThreadHistory(nextThread, controller.signal);
        await refreshMemoryStatus(nextThread);
      } catch (error) {
        if (error?.name === "AbortError") return;
        setDrawerThreads(productionMode ? [] : mockThreads);
        setActiveThreadId(productionMode ? null : mockThreads[0].id);
        setMessages(productionMode ? [] : initialMessages);
        setDataError(
          productionMode
            ? "真实数据加载失败，请稍后重试。"
            : "真实数据加载失败，已临时回退到本地示例。"
        );
      } finally {
        setLoadingData(false);
      }
    }

    loadRealData();

    return () => {
      controller.abort();
      mobileHistoryRequestRef.current.controller?.abort();
      clearTimeout(replyTimerRef.current);
      clearTimeout(pendingHistoryRefreshTimerRef.current);
    };
  }, [
    initialThreadSlug,
    initialWorkspaceSlug,
    mobileAuthRevision,
    navigateMobileThread,
    productionMode,
  ]);

  useEffect(() => {
    if (!productionMode || !activeThread?.workspaceSlug) return;

    async function refreshMobileWorkspaceThreads(event) {
      const guard = guardGlobalRefresh({
        detail: event?.detail || {},
        path: "workspaceThreadsRefresh",
        source: "mobile-page-experiment",
      });
      if (!guard.allowed) return;
      const workspaceSlug = event?.detail?.workspaceSlug;
      if (!workspaceSlug || workspaceSlug !== activeThread.workspaceSlug)
        return;

      const workspace = await Workspace.bySlug(workspaceSlug);
      if (!workspace?.slug) return;
      const { threads = [] } = await Workspace.threads.all(workspace.slug);
      const nextWorkspaceThreads = threads
        .filter((thread) => thread?.slug)
        .map((thread) => threadToDrawerItem(workspace, thread))
        .filter(isVisibleThreadItem);
      const sortedNextWorkspaceThreads = sortMobileDrawerThreadsForDisplay(
        nextWorkspaceThreads,
        pinnedThreadIds,
        chatDrafts.hasThreadActivity
      );

      setDrawerThreads((current) => {
        const otherThreads = current.filter(
          (thread) => thread.workspaceSlug !== workspace.slug
        );
        return [...otherThreads, ...nextWorkspaceThreads];
      });

      const activeStillExists = nextWorkspaceThreads.some(
        (thread) => thread.id === activeThread.id
      );
      if (!activeStillExists && sortedNextWorkspaceThreads.length) {
        const nextThread = sortedNextWorkspaceThreads[0];
        activeThreadIdRef.current = nextThread.id;
        setActiveThreadId(nextThread.id);
        navigateMobileThread(nextThread, { replace: true });
        if (sandboxedPresentation) {
          setMessages([]);
          await loadThreadHistory(nextThread).catch(() => {});
          await refreshMemoryStatus(nextThread).catch(() => {});
        }
      }
    }

    window.addEventListener(
      "workspaceThreadsRefresh",
      refreshMobileWorkspaceThreads
    );
    return () =>
      window.removeEventListener(
        "workspaceThreadsRefresh",
        refreshMobileWorkspaceThreads
      );
  }, [
    activeThread,
    chatDrafts.hasThreadActivity,
    navigateMobileThread,
    pinnedThreadIds,
    productionMode,
    sandboxedPresentation,
  ]);

  async function switchThread(threadId) {
    cancelEditMessage();
    const nextThread =
      visibleDrawerThreads.find((thread) => thread.id === threadId) ||
      activeThread;
    activeThreadIdRef.current = nextThread.id;
    setActiveThreadId(nextThread.id);
    setQuizMode(false);
    setMenuOpen(false);
    if (
      productionMode &&
      nextThread?.workspaceSlug &&
      nextThread.workspaceSlug !== FALLBACK_WORKSPACE_SLUG
    ) {
      navigateMobileThread(nextThread);
    }
    setMessages([]);
    setLoadingThreadHistory(true);
    try {
      await loadThreadHistory(nextThread);
      await refreshMemoryStatus(nextThread);
      setDataError(null);
    } catch (error) {
      if (error?.name !== "AbortError")
        setDataError("当前 thread 历史加载失败。");
    } finally {
      setLoadingThreadHistory(false);
    }
  }

  async function renameDrawerThread(thread) {
    if (!thread?.workspaceSlug || !thread?.threadSlug) return;
    const nextName = window.prompt("请输入新的线程名称", thread.title)?.trim();
    if (!nextName) return;

    const { message } = await Workspace.threads.update(
      thread.workspaceSlug,
      thread.threadSlug,
      { name: nextName }
    );
    if (message) {
      showToast(`线程更新失败：${message}`, "error", { clear: true });
      return;
    }

    setDrawerThreads((current) =>
      current.map((item) =>
        item.id === thread.id ? { ...item, title: nextName } : item
      )
    );
    setDataError(null);
    showToast("线程已重命名。", "success", { clear: true });
  }

  function pinDrawerThread(thread) {
    if (!thread?.id) return;
    setPinnedThreadIds((current) => [
      thread.id,
      ...current.filter((id) => id !== thread.id),
    ]);
    showToast("线程已置顶。", "success", { clear: true });
  }

  async function deleteDrawerThread(thread) {
    if (!thread?.workspaceSlug || !thread?.threadSlug) return;
    if (!window.confirm("删除此线程？此操作无法撤销。")) return;
    const deletingActiveThread = activeThreadId === thread.id;
    const nextActiveThread = deletingActiveThread
      ? findThreadAfterDeletion(thread, visibleDrawerThreads)
      : null;

    const success = await Workspace.threads.delete(
      thread.workspaceSlug,
      thread.threadSlug
    );
    if (!success) {
      showToast("线程删除失败。", "error", { clear: true });
      return;
    }

    setRemovingThreadIds((current) =>
      current.includes(thread.id) ? current : [...current, thread.id]
    );
    showToast("线程已删除。", "success", { clear: true });

    window.setTimeout(() => {
      setDrawerThreads((current) =>
        current.filter((item) => item.id !== thread.id)
      );
      setPinnedThreadIds((current) => current.filter((id) => id !== thread.id));
      setRemovingThreadIds((current) =>
        current.filter((id) => id !== thread.id)
      );
    }, MOBILE_THREAD_DELETE_ANIMATION_MS);

    if (deletingActiveThread) {
      const nextThread =
        nextActiveThread || (productionMode ? null : mockThreads[0]);
      if (!nextThread) {
        setActiveThreadId(null);
        setMessages([]);
        setMemoryStatus(null);
        setMemoryUnavailable(true);
        return;
      }
      setActiveThreadId(nextThread.id);
      await loadThreadHistory(nextThread).catch(() => {});
      await refreshMemoryStatus(nextThread).catch(() => {});
    }
  }

  async function handleMobileSessionSignOut() {
    const confirmed = await confirmSignOut();
    if (!confirmed) return;

    if (productionMode && fullscreenPresentation) {
      auth?.actions?.unsetUser?.();
      window.location.assign(paths.login());
      return;
    }

    forcePasswordLoginRef.current = false;
    setMobileLoginInitialMode("quick");
    setMobileSessionSignedOut(true);
    setMenuOpen(false);
    setMoreMenuOpen(false);
    setAttachmentSheetOpen(false);
    setRecording(false);
    setQuizMode(false);
    setInput("");
  }

  function persistMobileAuthenticatedUser(user, token) {
    if (!user || !token) return false;
    if (auth?.actions?.updateUser) {
      auth.actions.updateUser(user, token);
    } else {
      setStoredAuthUser(user);
      setAuthToken(token);
      setLoginUserActionNow();
    }
    return true;
  }

  async function restoreMobileAuthenticatedSession(user, token) {
    if (!persistMobileAuthenticatedUser(user, token)) return false;
    const nextPfp = user?.id ? await System.fetchPfp(user.id) : null;
    setMobileSessionUser(user);
    setMobileSessionPfp(nextPfp);
    setMobileSessionSignedOut(false);
    forcePasswordLoginRef.current = false;
    setMobileLoginInitialMode("quick");
    setMobileAuthRevision((current) => current + 1);
    return true;
  }

  async function handleMobileQuickAccountSwitch(device) {
    try {
      const result = await AccountSettingsApi.loginWithZkDevice(device);
      if (result?.valid && result?.token && result?.user) {
        await restoreMobileAuthenticatedSession(result.user, result.token);
        showToast("已切换账号。", "success", { clear: true });
        return { success: true };
      }

      const error = result?.message || "快速切换失败，请重新登录。";
      showToast(error, "error", { clear: true });
      return { success: false, error };
    } catch {
      const error = "快速切换凭证读取失败，请重新登录。";
      showToast(error, "error", { clear: true });
      return { success: false, error };
    }
  }

  function handleMobileAddAccount() {
    forcePasswordLoginRef.current = true;
    setMobileLoginInitialMode("password");
    setMobileSessionSignedOut(true);
    setMenuOpen(false);
    setMoreMenuOpen(false);
    setAttachmentSheetOpen(false);
    setRecording(false);
    setQuizMode(false);
    setInput("");
  }

  async function handleMobileQuickLogin() {
    try {
      const zkDevice = await getPreferredLocalZkDevice();
      if (zkDevice) {
        setMobileLoginAccountHint(
          buildMobileLoginAccountHint(
            zkDevice,
            mobileAccountUser,
            mobileAccountPfp
          )
        );
        const result = await AccountSettingsApi.loginWithZkDevice(zkDevice);
        if (result?.valid && result?.token && result?.user) {
          await restoreMobileAuthenticatedSession(result.user, result.token);
          return { success: true };
        }
        showToast(
          result?.message || "快速登录失败，请使用账号密码登录。",
          "error",
          {
            clear: true,
          }
        );
        return { success: false, error: result?.message };
      }
    } catch {
      showToast("快速登录凭证读取失败，请使用账号密码登录。", "error", {
        clear: true,
      });
      return { success: false, error: "快速登录凭证读取失败。" };
    }

    if (auth?.store?.user && auth?.store?.authToken) {
      await restoreMobileAuthenticatedSession(
        auth.store.user,
        auth.store.authToken
      );
      return { success: true };
    }

    showToast("当前浏览器没有可用的快速登录凭证。", "error", {
      clear: true,
    });
    return { success: false, error: "当前浏览器没有可用的快速登录凭证。" };
  }

  async function handleMobilePasswordLogin({ identifier, password }) {
    const result = await System.requestToken({
      identifier,
      password,
    });

    if (!result?.valid || !result?.token || !result?.user) {
      return {
        success: false,
        error:
          result?.message === "账号已被禁用"
            ? result.message
            : "账号或密码不正确",
      };
    }

    await restoreMobileAuthenticatedSession(result.user, result.token);
    return { success: true };
  }

  async function handleMobilePasskeyLogin() {
    const capability = detectAuthCapability();
    if (!capability.showPasskey) {
      return {
        success: false,
        error: passkeyCapabilityDescription(capability),
      };
    }

    const result = await AccountSettingsApi.loginWithPasskey().catch(
      (error) => {
        if (isMobilePasskeyCancel(error)) {
          return { valid: false, cancelled: true };
        }
        return { valid: false, message: error.message };
      }
    );

    if (result.cancelled) {
      showToast("已取消通行密钥验证。", "info", { clear: true });
      return { success: false, error: "已取消通行密钥验证。" };
    }

    if (result.valid && result.token && result.user) {
      await restoreMobileAuthenticatedSession(result.user, result.token);
      return { success: true };
    }

    const message = result.message || "无法验证通行密钥。";
    showToast(message, "error", { clear: true });
    return { success: false, error: message };
  }

  function resetConversation() {
    clearTimeout(replyTimerRef.current);
    loadThreadHistory(activeThread)
      .then(() => refreshMemoryStatus(activeThread))
      .catch(() => {
        setMessages(productionMode ? [] : initialMessages);
        setDataError("刷新真实历史失败。");
      });
    setInput("");
    setQuizMode(false);
    setRecording(false);
  }

  async function createThreadInCurrentWorkspace() {
    const workspaceSlug = activeThread?.workspaceSlug;
    if (!workspaceSlug || workspaceSlug === FALLBACK_WORKSPACE_SLUG) {
      resetConversation();
      return;
    }

    setDataError(null);
    setLoadingData(true);
    try {
      const { thread, error } = await Workspace.threads.new(workspaceSlug);
      if (error || !thread?.slug) {
        throw new Error(error || "新建线程失败。");
      }

      const createdAt = new Date().toISOString();
      const nextThread = threadToDrawerItem(
        {
          slug: workspaceSlug,
          name: activeThread.workspace,
        },
        {
          ...thread,
          createdAt: thread.createdAt || createdAt,
          lastUpdatedAt: thread.lastUpdatedAt || createdAt,
        }
      );
      setDrawerThreads((current) => [
        nextThread,
        ...current.filter((item) => item.id !== nextThread.id),
      ]);
      setActiveThreadId(nextThread.id);
      setMessages([]);
      setInput("");
      setQuizMode(false);
      setRecording(false);
      setAttachmentSheetOpen(false);
      clearPendingSubmittedMessage(activeThread);
      clearLocalRuntimeActivity(activeThread);
      await refreshMemoryStatus(nextThread).catch(() => {});

      if (productionMode) {
        navigateMobileThread(nextThread);
      }
    } catch (error) {
      setDataError(error?.message || "新建线程失败，请稍后重试。");
      showToast(error?.message || "新建线程失败，请稍后重试。", "error", {
        clear: true,
      });
    } finally {
      setLoadingData(false);
    }
  }

  function handleQuizMessageUpdate(messageId, nextQuiz, finalContent) {
    if (!messageId || !nextQuiz) return;
    setMessages((current) =>
      current.map((message) =>
        message.id === messageId
          ? {
              ...message,
              ...(finalContent !== undefined ? { text: finalContent } : {}),
              chatId: message.chatId || nextQuiz.id,
              sources: nextQuiz.sourceRefs || message.sources || [],
              outputs: [{ type: "QuizCard", payload: nextQuiz }],
            }
          : message
      )
    );
  }

  function messageChatId(message = {}) {
    return message.publicChatId || message.chatId || null;
  }

  function canWriteMessage(message = {}) {
    return (
      !!messageChatId(message) &&
      !!activeThread?.workspaceSlug &&
      !!activeThread?.threadSlug &&
      activeThread.workspaceSlug !== FALLBACK_WORKSPACE_SLUG
    );
  }

  function setActionError(message = "移动端操作失败，请稍后再试。") {
    setDataError(message);
  }

  async function handleCopyMessage(message) {
    const text = message?.text || "";
    if (!text.trim()) return;

    try {
      await writeClipboardText(text);
      setCopiedMessageId(message.id);
      clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => {
        setCopiedMessageId((current) =>
          current === message.id ? null : current
        );
      }, 1400);
      setDataError(null);
    } catch {
      setActionError("复制失败，当前浏览器没有开放剪贴板权限。");
    }
  }

  function startEditMessage(message) {
    const chatId = Number(message?.chatId);
    const targetIndex = messages.findIndex((item) => item.id === message.id);
    if (!canWriteMessage(message) || chatId <= 0 || targetIndex < 0) return;
    setChatEditSession({
      chatId,
      sourceMessageId: message.id,
      originalMessages: [...messages],
      prefixMessages: messages.slice(0, targetIndex),
      previousDraft: input,
      attachments: message.attachments || [],
    });
    setMessages(messages.slice(0, targetIndex));
    setInput(message.text || "");
  }

  function cancelEditMessage() {
    if (!chatEditSession) return;
    setMessages(chatEditSession.originalMessages);
    setInput(chatEditSession.previousDraft || "");
    setChatEditSession(null);
    setChatMutationView(null);
  }

  function handleSpeakMessage(message) {
    const text = message?.text || "";
    if (!text.trim()) return;
    if (typeof window === "undefined" || !window.speechSynthesis) {
      setActionError("当前浏览器不支持语音朗读。");
      return;
    }

    if (speakingMessageId === message.id) {
      window.speechSynthesis.cancel();
      setSpeakingMessageId(null);
      return;
    }

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "zh-CN";
    utterance.onend = () =>
      setSpeakingMessageId((current) =>
        current === message.id ? null : current
      );
    utterance.onerror = () =>
      setSpeakingMessageId((current) =>
        current === message.id ? null : current
      );
    setSpeakingMessageId(message.id);
    window.speechSynthesis.speak(utterance);
  }

  function previousUserMessage(messageId) {
    const messageIndex = messages.findIndex(
      (message) => message.id === messageId
    );
    if (messageIndex < 0) return null;
    for (let index = messageIndex - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === "user") return messages[index];
    }
    return null;
  }

  async function handleRegenerateMessage(message) {
    const chatId = Number(message?.chatId);
    const sourceUser = previousUserMessage(message.id);
    const latestAssistant = [...messages]
      .reverse()
      .find((item) => item.role === "assistant" && Number(item.chatId) > 0);
    if (
      !canWriteMessage(message) ||
      chatId <= 0 ||
      latestAssistant?.id !== message.id ||
      !sourceUser?.text?.trim()
    ) {
      setActionError("无法重新回应：缺少可用的真实消息记录。");
      return;
    }

    setMessageActionBusy(`${message.id}:regenerate`);
    const userIndex = messages.findIndex((item) => item.id === sourceUser.id);
    if (userIndex < 0) {
      setMessageActionBusy(null);
      setActionError("无法重新回应：原用户消息已不在当前历史中。");
      return;
    }
    const sourceActionId = createTurnId();
    const mutationSession = {
      kind: "regenerate",
      sourceActionId,
      originalMessages: [...messages],
      prefixMessages: messages.slice(0, userIndex),
    };
    setMessages(mutationSession.prefixMessages);
    await sendMessage({
      text: sourceUser.text,
      attachments: sourceUser.attachments || [],
      regenerateContext: { targetChatId: chatId, sourceActionId },
      mutationSession,
    });
    setMessageActionBusy(null);
  }

  async function handleDeleteMessage(message) {
    const chatId = Number(message?.chatId);
    if (!canWriteMessage(message)) {
      setActionError("无法删除：缺少可用的真实消息记录。");
      return;
    }

    setMessageActionBusy(`${message.id}:delete`);
    const snapshot = [...messages];
    try {
      if (!window.confirm("永久删除这一轮对话？此操作无法撤销。")) return;
      setMessages((current) =>
        current.filter((item) => Number(item.chatId) !== chatId)
      );
      const result = await Workspace.deleteChatTurn(
        activeThread.workspaceSlug,
        activeThread.threadSlug,
        message.publicChatId || chatId,
        { sourceActionId: createTurnId() }
      );
      if (result?.success === false || result?.error)
        throw new Error(result?.error || "delete failed");
      setDataError(null);
    } catch {
      setMessages(snapshot);
      setActionError("删除失败，真实历史未更新。");
    } finally {
      setMessageActionBusy(null);
    }
  }

  async function handleForkMessage(message) {
    const chatId = messageChatId(message);
    if (!canWriteMessage(message)) {
      setActionError("无法分叉：缺少可用的真实消息记录。");
      return;
    }

    setMessageActionBusy(`${message.id}:fork`);
    try {
      const result = await Workspace.forkThread(
        activeThread.workspaceSlug,
        activeThread.threadSlug,
        chatId,
        { returnFull: true }
      );
      const newThread = result?.newThread || null;
      const newThreadSlug = newThread?.slug || result?.newThreadSlug;
      if (!newThreadSlug || result?.error) {
        throw new Error(result?.error || "fork failed");
      }

      const nextThread = threadToDrawerItem(
        {
          slug: activeThread.workspaceSlug,
          name: activeThread.workspace,
        },
        newThread || {
          slug: newThreadSlug,
          name: result?.title || "分支对话",
        }
      );
      setDrawerThreads((current) => [
        nextThread,
        ...current.filter((thread) => thread.id !== nextThread.id),
      ]);
      setActiveThreadId(nextThread.id);
      setMenuOpen(false);
      setDataError(null);
      await loadThreadHistory(nextThread);
      await refreshMemoryStatus(nextThread);
    } catch {
      setActionError("分叉失败，当前 thread 保持不变。");
    } finally {
      setMessageActionBusy(null);
    }
  }

  async function sendMessage(options = {}) {
    mobileChatDebug("send:entry", {
      valueLength:
        typeof options === "string"
          ? options.trim().length
          : String(options?.text ?? input ?? "").trim().length,
      attachmentCount: mobileAttachments.length,
      processedAttachmentCount: mobileAttachments.filter(
        (attachment) =>
          attachment.type === "attachment" &&
          !!attachment.contentString &&
          attachment.status !== "failed"
      ).length,
      activeThreadId: activeThread?.id || null,
      workspaceSlug: activeThread?.workspaceSlug || null,
      threadSlug: activeThread?.threadSlug || null,
    });

    let hasOverrideAttachments = false;
    let overrideText = null;
    let overrideAttachments = [];
    let text = "";
    let hasSendableAttachments = false;
    let promptText = "";
    let threadAtSend = activeThread;
    let quizModeAtSend = quizMode;
    let submittedAt = null;
    let optimisticMessageId = null;
    let pendingSubmitted = null;
    let streamTurnScheduled = false;
    let shouldRestoreComposerOnEarlyFailure = true;
    let mutationSession =
      typeof options === "object" ? options?.mutationSession || null : null;
    let editContext =
      typeof options === "object" ? options?.editContext || null : null;
    let regenerateContext =
      typeof options === "object" ? options?.regenerateContext || null : null;
    const mutationState = { committed: false, aborted: false };

    try {
      hasOverrideAttachments =
        typeof options === "object" && Array.isArray(options?.attachments);
      overrideText =
        typeof options === "string" ? options : options?.text || null;
      overrideAttachments = hasOverrideAttachments
        ? options.attachments
        : mobileParseAttachmentsRef.current?.() || [];
      text = String(overrideText ?? input ?? "").trim();
      hasSendableAttachments = overrideAttachments.length > 0;
      promptText = text || "请分析这张图片。";
      threadAtSend = activeThread;
      quizModeAtSend = quizMode;
      shouldRestoreComposerOnEarlyFailure = !overrideText;
      if (chatEditSession && !mutationSession) {
        const sourceActionId = createTurnId();
        mutationSession = {
          ...chatEditSession,
          kind: "edit",
          sourceActionId,
        };
        editContext = {
          startingChatId: chatEditSession.chatId,
          sourceActionId,
        };
      }
      if (mutationSession) {
        setChatMutationView({
          kind: mutationSession.kind,
          targetChatId:
            mutationSession.chatId || regenerateContext?.targetChatId,
        });
      }

      const pendingAtSend = currentPendingSubmittedMessage(threadAtSend);
      const runtimeBusyAtSend =
        mobileDraftHasRuntimeActivity(activeDraft) ||
        !!activeLocalRuntimeActivity ||
        !!pendingAtSend;
      const guardReasons = {
        emptyPayload: !text && !hasSendableAttachments,
        attachmentsProcessing: !!mobileAttachmentsProcessing,
        sendInFlight: !!sendInFlightRef.current,
        streaming: !!streaming,
        runtimeBusy: !!runtimeBusyAtSend,
        missingThread:
          !threadAtSend?.workspaceSlug || !threadAtSend?.threadSlug,
        overviewThread: threadAtSend?.workspaceSlug === FALLBACK_WORKSPACE_SLUG,
      };
      if (Object.values(guardReasons).some(Boolean)) {
        mobileChatDebug("send:guard-blocked", {
          ...guardReasons,
          threadId: threadAtSend?.id || null,
          workspaceSlug: threadAtSend?.workspaceSlug || null,
          threadSlug: threadAtSend?.threadSlug || null,
          textLength: text.length,
          attachmentCount: overrideAttachments.length,
          imageOnly: !text && hasSendableAttachments,
        });
        return;
      }

      mobileChatDebug("send:preflight-ok", {
        threadId: threadAtSend.id,
        workspaceSlug: threadAtSend.workspaceSlug,
        threadSlug: threadAtSend.threadSlug,
        textLength: text.length,
        attachmentCount: overrideAttachments.length,
        imageOnly: !text && hasSendableAttachments,
      });
      sendInFlightRef.current = true;
      clearTimeout(replyTimerRef.current);
      submittedAt = Math.floor(Date.now() / 1000);
      if (!overrideText) setInput("");
      if (mutationSession?.kind === "edit") setChatEditSession(null);
      setStreaming(true);
      touchDrawerThreadActivity(
        threadAtSend,
        new Date(submittedAt * 1000).toISOString()
      );
    } catch (error) {
      mobileChatDebug("send:preflight-error", {
        message: error?.message || String(error),
        stack: error?.stack || null,
        threadId: threadAtSend?.id || null,
        workspaceSlug: threadAtSend?.workspaceSlug || null,
        threadSlug: threadAtSend?.threadSlug || null,
      });
      setActionError(error?.message || "发送前检查失败，请重试。");
      sendInFlightRef.current = false;
      setStreaming(false);
      return;
    }

    const isStillActiveThread = () =>
      activeThreadIdRef.current === threadAtSend.id;

    try {
      if (quizModeAtSend) {
        const turnClientId = Date.now();
        const assistantId = `a-${turnClientId}`;
        setMessages((current) => [
          ...current,
          {
            id: `u-${turnClientId}`,
            role: "user",
            text,
            time: "现在",
            sentAt: submittedAt,
            attachments: overrideAttachments,
            workspaceSlug: threadAtSend.workspaceSlug,
            threadSlug: threadAtSend.threadSlug,
          },
          {
            id: assistantId,
            role: "assistant",
            text: "",
            time: "",
            runtimeActivity: {
              key: `quiz-generating:${turnClientId}`,
              label: "正在生成测试题",
            },
            runtimeOnly: true,
            workspaceSlug: threadAtSend.workspaceSlug,
            threadSlug: threadAtSend.threadSlug,
          },
        ]);

        const replaceAssistant = (updates = {}) => {
          if (!isStillActiveThread()) return;
          setMessages((current) =>
            current.map((message) =>
              message.id === assistantId
                ? {
                    ...message,
                    ...updates,
                    runtimeActivity: null,
                    runtimeOnly: false,
                    time: "现在",
                  }
                : message
            )
          );
        };

        try {
          const result = await Workspace.generateQuiz(
            threadAtSend.workspaceSlug,
            {
              message: promptText,
              threadSlug: threadAtSend.threadSlug,
            }
          );
          const historyMessages = result?.history
            ? historyToMessages(result.history, { fallbackToInitial: false })
            : [];
          if (
            isStillActiveThread() &&
            historyIncludesSubmittedMessage(historyMessages, text, submittedAt)
          ) {
            setMessages(historyMessages);
          } else if (result?.success) {
            const quiz = result.quiz || {};
            replaceAssistant({
              chatId: result.quizId || quiz.id,
              text: quiz.analysis || quiz.title || "测试题已生成。",
              sources: quiz.sourceRefs || [],
              outputs: [{ type: "QuizCard", payload: quiz }],
            });
          } else {
            replaceAssistant({
              text: result?.error || "测试题生成失败。",
              outputs: [],
            });
          }
        } catch (error) {
          replaceAssistant({
            text: error?.message || "测试题生成失败。",
            outputs: [],
          });
        } finally {
          setQuizMode(false);
          await refreshMemoryStatus(threadAtSend).catch(() => {});
        }
        return;
      }

      setDataError(null);
      optimisticMessageId = `u-local-${Date.now()}`;
      const clientTurnId = createTurnId();
      pendingSubmitted = {
        messageId: optimisticMessageId,
        clientTurnId,
        threadId: threadAtSend.id,
        workspaceSlug: threadAtSend.workspaceSlug,
        threadSlug: threadAtSend.threadSlug,
        text: promptText,
        displayText: text,
        submittedAt,
        createdAtMs: Date.now(),
        attachments: overrideAttachments,
        attempts: 0,
      };
      pendingSubmittedMessageRef.current = pendingSubmitted;
      storePendingSubmittedMessage(pendingSubmitted);
      mobileChatDebug("send:pending-created", {
        threadId: threadAtSend.id,
        workspaceSlug: threadAtSend.workspaceSlug,
        threadSlug: threadAtSend.threadSlug,
        optimisticMessageId,
        clientTurnId,
        submittedAt,
        textLength: text.length,
        attachmentCount: overrideAttachments.length,
        imageOnly: !text && hasSendableAttachments,
      });
      setLocalRuntimeActivity(
        localThinkingActivity(threadAtSend, pendingSubmitted)
      );
      clearTimeout(pendingHistoryRefreshTimerRef.current);
      setMessages((current) => [
        ...current,
        {
          id: optimisticMessageId,
          role: "user",
          clientTurnId,
          text,
          displayText: text,
          time: "现在",
          sentAt: submittedAt,
          attachments: overrideAttachments,
          workspaceSlug: threadAtSend.workspaceSlug,
          threadSlug: threadAtSend.threadSlug,
        },
      ]);
      if (!hasOverrideAttachments) {
        mobileChatDebug("attachment:composer-cleared-after-send", {
          threadId: threadAtSend.id,
          optimisticMessageId,
          clientTurnId,
          attachmentCount: overrideAttachments.length,
        });
        window.dispatchEvent(new CustomEvent(CLEAR_ATTACHMENTS_EVENT));
        setMobileAttachments([]);
      }

      const mutationTargetChatId = Number(
        mutationSession?.chatId || regenerateContext?.targetChatId || 0
      );
      const mutationDraftItems = Array.isArray(activeDraft?.items)
        ? activeDraft.items
        : [];
      const mutationDraftIndex = mutationTargetChatId
        ? mutationDraftItems.findIndex(
            (item) => Number(item.chatId) === mutationTargetChatId
          )
        : -1;
      const streamResult = await chatDrafts.startStream({
        workspaceSlug: threadAtSend.workspaceSlug,
        threadSlug: threadAtSend.threadSlug,
        prompt: promptText,
        displayPrompt: text,
        attachments: overrideAttachments,
        history: [],
        parseAttachments: mobileParseAttachmentsRef.current,
        clientGeneratedTurnId: clientTurnId,
        editContext,
        regenerateContext,
        onMutationEvent: (streamEvent) => {
          if (
            streamEvent?.type === "editHistoryTruncated" ||
            streamEvent?.type === "regenerateTurnDeleted"
          ) {
            mutationState.committed = true;
          }
          if (streamEvent?.type === "abort") mutationState.aborted = true;
        },
        mutationBaseItems:
          mutationDraftIndex >= 0
            ? mutationDraftItems.slice(0, mutationDraftIndex)
            : mutationSession
              ? []
              : null,
      });
      mobileChatDebug("send:start-stream-result", {
        threadId: threadAtSend.id,
        ok: streamResult?.ok ?? null,
        chatKey: streamResult?.chatKey || null,
        turnId: streamResult?.turnId || null,
        turnScheduled: streamResult?.turnScheduled ?? null,
        routedToExistingAgent: streamResult?.routedToExistingAgent ?? null,
        completedChatId: streamResult?.completedChatId || null,
        reason: streamResult?.reason || null,
      });
      streamTurnScheduled = streamResult?.turnScheduled !== false;
      if (mutationState.aborted && !mutationState.committed) {
        streamTurnScheduled = false;
        throw new Error(streamResult?.reason || "会话修改未提交。");
      }
      if (streamResult && streamResult.ok === false && !streamTurnScheduled) {
        throw new Error(streamResult.reason || "回复生成失败。");
      }
      schedulePendingHistoryRefresh(threadAtSend, 900);
      await refreshMemoryStatus(threadAtSend).catch(() => {});
    } catch (error) {
      mobileChatDebug("send:stream-error", {
        message: error?.message || String(error),
        stack: error?.stack || null,
        threadId: threadAtSend?.id || null,
        workspaceSlug: threadAtSend?.workspaceSlug || null,
        threadSlug: threadAtSend?.threadSlug || null,
        optimisticMessageId,
        turnScheduled: streamTurnScheduled,
      });
      setActionError(error?.message || "回复生成失败。");
      if (mutationSession && !mutationState.committed) {
        setMessages(mutationSession.originalMessages || []);
        if (pendingSubmitted?.clientTurnId) {
          chatDrafts.clearConfirmedLocalTurn({
            workspaceSlug: threadAtSend.workspaceSlug,
            threadSlug: threadAtSend.threadSlug,
            turnId: pendingSubmitted.clientTurnId,
          });
        }
        clearLocalRuntimeActivity(threadAtSend);
        if (mutationSession.kind === "edit") {
          setChatEditSession(mutationSession);
          setInput(text);
        }
        if (pendingSubmitted) clearPendingSubmittedMessage(threadAtSend);
      } else if (!streamTurnScheduled) {
        if (shouldRestoreComposerOnEarlyFailure) setInput(text);
        if (pendingSubmitted) clearPendingSubmittedMessage(threadAtSend);
        if (optimisticMessageId) {
          setMessages((current) =>
            current.filter((message) => message.id !== optimisticMessageId)
          );
        }
      } else {
        clearLocalRuntimeActivity(threadAtSend);
        setMessages((current) => [
          ...current,
          {
            id: `a-local-error-${Date.now()}`,
            role: "assistant",
            text: error?.message || "回复生成失败，请检查网络后重试。",
            time: "现在",
            sentAt: Math.floor(Date.now() / 1000),
            workspaceSlug: threadAtSend.workspaceSlug,
            threadSlug: threadAtSend.threadSlug,
          },
        ]);
        schedulePendingHistoryRefresh(threadAtSend, 900);
      }
    } finally {
      setChatMutationView(null);
      setStreaming(false);
      sendInFlightRef.current = false;
    }
  }

  function touchDrawerThreadActivity(thread, activityAt = null) {
    if (!thread?.id) return;
    const timestamp = activityAt || new Date().toISOString();
    setDrawerThreads((current) =>
      current.map((item) =>
        item.id === thread.id
          ? {
              ...item,
              lastChatAt: timestamp,
              lastUpdatedAt: timestamp,
            }
          : item
      )
    );
  }

  function handleInputKeyDown(event) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  }

  function attachmentInputForSource(source = "files") {
    if (source === "camera") return cameraInputRef.current;
    if (source === "photos") return photoInputRef.current;
    return fileInputRef.current;
  }

  function requestMobileAttachmentPick(source = "files") {
    const input = attachmentInputForSource(source);
    const activeElement = document.activeElement;
    mobileChatDebug("attachment:picker-open", {
      source,
      hasInput: !!input,
      inputType: input?.type || null,
      accept: input?.accept || null,
      capture: input?.capture || null,
      multiple: !!input?.multiple,
      activeElement:
        activeElement?.tagName || activeElement?.nodeName || "unknown",
    });
    if (!input) {
      mobileChatDebug("attachment:picker-missing-input", { source });
      return;
    }

    try {
      input.click();
      mobileChatDebug("attachment:picker-click-dispatched", { source });
    } catch (error) {
      mobileChatDebug("attachment:picker-click-failed", {
        source,
        error: error?.message || String(error),
      });
    }
  }

  function handleMobileAttachmentFilesSelected(event, source = "files") {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    mobileChatDebug("attachment:files-selected", {
      source,
      count: files.length,
      items: files.map(mobileFileDebugPayload),
    });
    if (!files.length) {
      mobileChatDebug("attachment:files-selected-empty", { source });
      return;
    }
    window.dispatchEvent(
      new CustomEvent(PASTE_ATTACHMENT_EVENT, {
        detail: { files, source },
      })
    );
    mobileChatDebug("attachment:paste-event-dispatched", {
      source,
      count: files.length,
    });
    setAttachmentSheetOpen(false);
  }

  if (productionMode && fullscreenPresentation) {
    return (
      <div
        className="mobile-experiment-device-screen fixed inset-0 w-screen overflow-hidden bg-[#f6f9ff] text-slate-950"
        style={{
          ...mobileViewportFrameStyle,
          width: "100vw",
          overscrollBehavior: "none",
        }}
      >
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_22%_7%,rgba(125,211,252,0.30),transparent_32%),radial-gradient(circle_at_88%_12%,rgba(250,204,21,0.20),transparent_28%),linear-gradient(180deg,rgba(255,255,255,0.92),rgba(239,246,255,0.72)_46%,rgba(226,232,240,0.78))]" />
        <div className="relative flex h-full flex-col overflow-hidden">
          {mobileSessionSignedOut ? (
            <MobileLoginScreen
              user={mobileAccountUser}
              pfp={mobileAccountPfp}
              loginAccountHint={mobileLoginAccountHint}
              subtitle="手机端登录"
              initialMode={mobileLoginInitialMode}
              onQuickLogin={handleMobileQuickLogin}
              onPasswordLogin={handleMobilePasswordLogin}
              onPasskeyLogin={handleMobilePasskeyLogin}
            />
          ) : !hasProductionThread ? (
            <MobileProductionState
              loading={loadingData}
              error={dataError}
              onRetry={() => setMobileAuthRevision((current) => current + 1)}
            />
          ) : (
            <DnDFileUploaderProvider
              key={`mobile-upload:${activeThread.workspaceSlug}:${activeThread.threadSlug}`}
              workspace={mobileUploadWorkspace}
              threadSlug={activeThread.threadSlug}
            >
              <MobileAttachmentRuntimeBridge
                onFilesChange={setMobileAttachments}
                onProcessingChange={setMobileAttachmentsProcessing}
                parseAttachmentsRef={mobileParseAttachmentsRef}
              />
              <MobileAttachmentFileInputs
                cameraInputRef={cameraInputRef}
                photoInputRef={photoInputRef}
                fileInputRef={fileInputRef}
                onFilesSelected={handleMobileAttachmentFilesSelected}
              />
              <PhoneTopBar
                activeThread={activeThread}
                onOpenMenu={() => {
                  cancelEditMessage();
                  setMenuOpen(true);
                }}
                onNewConversation={createThreadInCurrentWorkspace}
                moreButtonRef={moreButtonRef}
                onOpenMore={() => setMoreMenuOpen((current) => !current)}
              />

              <div className="min-h-0 flex-1 overflow-hidden px-4 pb-0 pt-0">
                <ChatPane
                  chatPaneRef={chatPaneRef}
                  messages={displayMessages}
                  runtimeActivity={runtimeActivity}
                  workspaceName={activeThread.workspace}
                  workspaceSlug={activeThread.workspaceSlug}
                  threadSlug={activeThread.threadSlug}
                  loadingRecent={
                    loadingThreadHistory && displayMessages.length === 0
                  }
                  messagesEndRef={messagesEndRef}
                  hasNewMessages={mobileHasNewMessages}
                  composerBottomInset={mobileComposerBottomInset}
                  onScroll={handleMobileChatScroll}
                  onWheel={(event) => {
                    if (event.deltaY < 0) leaveMobileFollow();
                  }}
                  onTouchMove={leaveMobileFollow}
                  onJumpToLatest={() =>
                    scrollMobileTailIntoView({ force: true })
                  }
                  onQuizUpdate={handleQuizMessageUpdate}
                  copiedMessageId={copiedMessageId}
                  editingMessageId={null}
                  editingText=""
                  messageActionBusy={messageActionBusy}
                  speakingMessageId={speakingMessageId}
                  onCancelEdit={cancelEditMessage}
                  onChangeEdit={() => {}}
                  onCopyMessage={handleCopyMessage}
                  onDeleteMessage={handleDeleteMessage}
                  onForkMessage={handleForkMessage}
                  onRegenerateMessage={handleRegenerateMessage}
                  onSaveEdit={() => {}}
                  onSpeakMessage={handleSpeakMessage}
                  onStartEdit={startEditMessage}
                />
              </div>

              <MobileRuntimeSheet
                ref={runtimeSheetRef}
                chatKey={activeChatKey}
                pendingApproval={pendingRuntimeApproval}
                onToolApprovalResponse={chatDrafts.respondToApproval}
              />

              {pendingRuntimeClarification ? (
                <MobileClarificationSurveyDock
                  key={
                    pendingRuntimeClarification?.requestId ||
                    "clarification-dock"
                  }
                  ref={runtimeSheetRef}
                  chatKey={activeChatKey}
                  clarification={pendingRuntimeClarification}
                  onResponse={chatDrafts.respondToClarification}
                />
              ) : (
                <MobileComposer
                  value={input}
                  recording={recording}
                  quizMode={quizMode}
                  workspaceSlug={activeThread.workspaceSlug}
                  threadSlug={activeThread.threadSlug}
                  onChange={setInput}
                  onToggleQuizMode={() => setQuizMode((current) => !current)}
                  onKeyDown={handleInputKeyDown}
                  attachments={mobileAttachments}
                  attachmentsProcessing={mobileAttachmentsProcessing}
                  enableAttachments
                  attachmentButtonRef={attachmentButtonRef}
                  onAttach={() => setAttachmentSheetOpen((current) => !current)}
                  onToggleRecording={() => setRecording((current) => !current)}
                  onSend={sendMessage}
                  disabled={composerDisabled}
                  disabledReason={composerDisabledReason}
                  memoryScopeKey={activeThread.id}
                  memoryStatus={memoryStatus}
                  memoryLoading={memoryLoading}
                  memoryUnavailable={memoryUnavailable}
                  showExperimentalActions={false}
                  editMode={!!chatEditSession}
                  onCancelEdit={cancelEditMessage}
                  onHeightChange={handleMobileComposerHeightChange}
                />
              )}
            </DnDFileUploaderProvider>
          )}
        </div>

        {!mobileSessionSignedOut &&
          hasProductionThread &&
          drawerPresence.shouldRender && (
            <WorkspaceDrawer
              open={drawerPresence.isVisible}
              threads={visibleDrawerThreads}
              activeThreadId={activeThreadId}
              removingThreadIds={removingThreadIds}
              onClose={() => setMenuOpen(false)}
              onDeleteThread={deleteDrawerThread}
              onPinThread={pinDrawerThread}
              onRenameThread={renameDrawerThread}
              onSelectThread={switchThread}
              onSignOut={handleMobileSessionSignOut}
              sessionUser={mobileSessionUser}
              sessionPfp={mobileSessionPfp}
              onSwitchAccount={handleMobileQuickAccountSwitch}
              onAddAccount={handleMobileAddAccount}
            />
          )}

        {!mobileSessionSignedOut &&
          hasProductionThread &&
          attachmentPresence.shouldRender && (
            <AttachmentPopover
              open={attachmentPresence.isVisible}
              anchorRef={attachmentButtonRef}
              onPickCamera={() => requestMobileAttachmentPick("camera")}
              onPickPhotos={() => requestMobileAttachmentPick("photos")}
              onPickFiles={() => requestMobileAttachmentPick("files")}
              onClose={() => setAttachmentSheetOpen(false)}
            />
          )}

        {!mobileSessionSignedOut &&
          hasProductionThread &&
          moreMenuPresence.shouldRender && (
            <MoreActionSheet
              open={moreMenuPresence.isVisible}
              anchorRef={moreButtonRef}
              onClose={() => setMoreMenuOpen(false)}
            />
          )}
      </div>
    );
  }

  const shellTitle = productionMode ? "云端移动端实时预览" : "移动端隔离区";
  const shellDescription = productionMode
    ? "本地手机画布运行最新前端代码，数据请求通过代理连接真实云端。"
    : "以固定手机画布验证移动端布局，不影响桌面端运行状态。";
  const shellBadge = productionMode
    ? "Cloud Mobile Runtime"
    : "Isolated Mobile Prototype";

  return (
    <div className="mobile-isolation-zone h-full min-h-[calc(100vh-56px)] w-full overflow-y-auto rounded-[28px] bg-[#f3f6fb] p-4 text-slate-950 md:p-6">
      <div className="mx-auto flex w-full max-w-[1040px] flex-col pb-8">
        <div className="w-full border-b border-slate-200/80 pb-6">
          <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-full border border-sky-200 bg-sky-50 text-sky-600 shadow-[0_10px_28px_rgb(56_189_248_/_0.16)]">
                <Sparkle className="h-5 w-5" weight="fill" />
              </div>
              <div>
                <p className="text-lg font-bold leading-6 text-slate-950">
                  {shellTitle}
                </p>
                <p className="mt-1 text-xs leading-[18px] text-slate-500">
                  {shellDescription}
                </p>
              </div>
            </div>

            <div className="w-fit rounded-full border border-sky-200 bg-sky-50 px-4 py-2 text-xs font-bold text-sky-700">
              {shellBadge}
            </div>
          </div>
        </div>

        <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(260px,360px)_minmax(430px,1fr)]">
          <PrototypeControlPanel
            activeThread={activeThread}
            recording={recording}
            loadingData={loadingData}
            dataError={dataError}
            productionMode={productionMode}
            onReset={resetConversation}
            onOpenMenu={() => {
              cancelEditMessage();
              setMenuOpen(true);
            }}
          />

          <div className="min-w-0 overflow-x-auto pb-6">
            <div
              className="relative mx-auto shrink-0 rounded-[48px] border border-slate-300 bg-slate-950 p-[10px] shadow-[0_40px_100px_rgba(15,23,42,0.24)]"
              style={{ width: DEVICE_WIDTH, height: DEVICE_HEIGHT }}
            >
              <div className="absolute left-1/2 top-[14px] z-30 h-[30px] w-[128px] -translate-x-1/2 rounded-full bg-black shadow-[0_10px_24px_rgba(0,0,0,0.32)]" />
              <div className="mobile-experiment-device-screen relative h-full overflow-hidden rounded-[38px] border border-white/[.36] bg-[#f6f9ff] text-slate-950">
                <ChromeMobileShell address={mobileFrameAddress}>
                  <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_22%_7%,rgba(125,211,252,0.30),transparent_32%),radial-gradient(circle_at_88%_12%,rgba(250,204,21,0.20),transparent_28%),linear-gradient(180deg,rgba(255,255,255,0.92),rgba(239,246,255,0.72)_46%,rgba(226,232,240,0.78))]" />
                  <div className="relative flex h-full flex-col overflow-hidden">
                    {mobileSessionSignedOut ? (
                      <MobileLoginScreen
                        user={mobileAccountUser}
                        pfp={mobileAccountPfp}
                        loginAccountHint={mobileLoginAccountHint}
                        initialMode={mobileLoginInitialMode}
                        onQuickLogin={handleMobileQuickLogin}
                        onPasswordLogin={handleMobilePasswordLogin}
                        onPasskeyLogin={handleMobilePasskeyLogin}
                      />
                    ) : (
                      <>
                        <MobileAttachmentFileInputs
                          cameraInputRef={cameraInputRef}
                          photoInputRef={photoInputRef}
                          fileInputRef={fileInputRef}
                          onFilesSelected={handleMobileAttachmentFilesSelected}
                        />
                        <PhoneTopBar
                          activeThread={activeThread}
                          onOpenMenu={() => {
                            cancelEditMessage();
                            setMenuOpen(true);
                          }}
                          onNewConversation={createThreadInCurrentWorkspace}
                          moreButtonRef={moreButtonRef}
                          onOpenMore={() =>
                            setMoreMenuOpen((current) => !current)
                          }
                        />

                        <div className="min-h-0 flex-1 overflow-hidden px-4 pb-0 pt-0">
                          <ChatPane
                            chatPaneRef={chatPaneRef}
                            messages={displayMessages}
                            runtimeActivity={runtimeActivity}
                            workspaceName={activeThread.workspace}
                            workspaceSlug={activeThread.workspaceSlug}
                            threadSlug={activeThread.threadSlug}
                            loadingRecent={
                              loadingThreadHistory &&
                              displayMessages.length === 0
                            }
                            messagesEndRef={messagesEndRef}
                            hasNewMessages={mobileHasNewMessages}
                            composerBottomInset={mobileComposerBottomInset}
                            onScroll={handleMobileChatScroll}
                            onWheel={(event) => {
                              if (event.deltaY < 0) leaveMobileFollow();
                            }}
                            onTouchMove={leaveMobileFollow}
                            onJumpToLatest={() =>
                              scrollMobileTailIntoView({ force: true })
                            }
                            onQuizUpdate={handleQuizMessageUpdate}
                            copiedMessageId={copiedMessageId}
                            editingMessageId={null}
                            editingText=""
                            messageActionBusy={messageActionBusy}
                            speakingMessageId={speakingMessageId}
                            onCancelEdit={cancelEditMessage}
                            onChangeEdit={() => {}}
                            onCopyMessage={handleCopyMessage}
                            onDeleteMessage={handleDeleteMessage}
                            onForkMessage={handleForkMessage}
                            onRegenerateMessage={handleRegenerateMessage}
                            onSaveEdit={() => {}}
                            onSpeakMessage={handleSpeakMessage}
                            onStartEdit={startEditMessage}
                          />
                        </div>

                        <MobileRuntimeSheet
                          ref={runtimeSheetRef}
                          chatKey={activeChatKey}
                          pendingApproval={pendingRuntimeApproval}
                          onToolApprovalResponse={chatDrafts.respondToApproval}
                        />

                        {pendingRuntimeClarification ? (
                          <MobileClarificationSurveyDock
                            key={
                              pendingRuntimeClarification?.requestId ||
                              "clarification-dock"
                            }
                            ref={runtimeSheetRef}
                            chatKey={activeChatKey}
                            clarification={pendingRuntimeClarification}
                            onResponse={chatDrafts.respondToClarification}
                          />
                        ) : (
                          <MobileComposer
                            value={input}
                            recording={recording}
                            quizMode={quizMode}
                            workspaceSlug={activeThread.workspaceSlug}
                            threadSlug={activeThread.threadSlug}
                            onChange={setInput}
                            onToggleQuizMode={() =>
                              setQuizMode((current) => !current)
                            }
                            onKeyDown={handleInputKeyDown}
                            attachments={mobileAttachments}
                            attachmentsProcessing={mobileAttachmentsProcessing}
                            attachmentButtonRef={attachmentButtonRef}
                            onAttach={() =>
                              setAttachmentSheetOpen((current) => !current)
                            }
                            onToggleRecording={() =>
                              setRecording((current) => !current)
                            }
                            onSend={sendMessage}
                            disabled={composerDisabled}
                            disabledReason={composerDisabledReason}
                            memoryScopeKey={activeThread.id}
                            memoryStatus={memoryStatus}
                            memoryLoading={memoryLoading}
                            memoryUnavailable={memoryUnavailable}
                            showExperimentalActions
                            editMode={!!chatEditSession}
                            onCancelEdit={cancelEditMessage}
                            onHeightChange={handleMobileComposerHeightChange}
                          />
                        )}
                      </>
                    )}
                  </div>

                  {!mobileSessionSignedOut && drawerPresence.shouldRender && (
                    <WorkspaceDrawer
                      open={drawerPresence.isVisible}
                      threads={visibleDrawerThreads}
                      activeThreadId={activeThreadId}
                      removingThreadIds={removingThreadIds}
                      onClose={() => setMenuOpen(false)}
                      onDeleteThread={deleteDrawerThread}
                      onPinThread={pinDrawerThread}
                      onRenameThread={renameDrawerThread}
                      onSelectThread={switchThread}
                      onSignOut={handleMobileSessionSignOut}
                      sessionUser={mobileSessionUser}
                      sessionPfp={mobileSessionPfp}
                      onSwitchAccount={handleMobileQuickAccountSwitch}
                      onAddAccount={handleMobileAddAccount}
                    />
                  )}

                  {!mobileSessionSignedOut &&
                    attachmentPresence.shouldRender && (
                      <AttachmentPopover
                        open={attachmentPresence.isVisible}
                        anchorRef={attachmentButtonRef}
                        onPickCamera={() =>
                          requestMobileAttachmentPick("camera")
                        }
                        onPickPhotos={() =>
                          requestMobileAttachmentPick("photos")
                        }
                        onPickFiles={() => requestMobileAttachmentPick("files")}
                        onClose={() => setAttachmentSheetOpen(false)}
                      />
                    )}

                  {!mobileSessionSignedOut && moreMenuPresence.shouldRender && (
                    <MoreActionSheet
                      open={moreMenuPresence.isVisible}
                      anchorRef={moreButtonRef}
                      onClose={() => setMoreMenuOpen(false)}
                    />
                  )}
                </ChromeMobileShell>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function MobileProductionState({ loading = false, error = null, onRetry }) {
  return (
    <div className="relative flex h-full flex-col items-center justify-center px-8 text-center">
      <div className="rounded-[30px] border border-white/80 bg-white/72 px-6 py-7 shadow-[0_24px_72px_rgba(15,23,42,0.14)] backdrop-blur-2xl">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-sky-50 text-sky-500">
          {loading ? (
            <CircleNotch size={23} weight="bold" className="animate-spin" />
          ) : (
            <ChatsCircle size={23} weight="bold" />
          )}
        </div>
        <p className="mt-4 text-[17px] font-black text-slate-950">
          {loading ? "正在载入移动端" : "暂无可展示的对话"}
        </p>
        <p className="mt-2 text-sm font-semibold leading-5 text-slate-500">
          {error || "当前账号还没有可用的 workspace 或 thread。"}
        </p>
        {!loading && (
          <button
            type="button"
            onClick={onRetry}
            className="mt-5 rounded-full bg-sky-500 px-5 py-2 text-sm font-black text-white shadow-[0_12px_26px_rgba(14,165,233,0.24)] transition hover:bg-sky-600"
          >
            重新加载
          </button>
        )}
      </div>
    </div>
  );
}

function PrototypeControlPanel({
  activeThread,
  recording,
  loadingData,
  dataError,
  productionMode = false,
  onReset,
  onOpenMenu,
}) {
  return (
    <aside className="h-fit rounded-[22px] border border-white/10 bg-white/[.04] p-5 text-white shadow-[0_18px_44px_rgba(0,0,0,0.16)] backdrop-blur-xl light:border-slate-200 light:bg-white/80 light:text-slate-900">
      <p className="text-sm font-bold text-sky-200 light:text-sky-700">
        {productionMode ? "Cloud Runtime State" : "Prototype State"}
      </p>
      <div className="mt-4 space-y-3 text-sm text-white/70 light:text-slate-600">
        <StateRow
          label="尺寸基准"
          value={`${DEVICE_WIDTH} × ${DEVICE_HEIGHT}`}
        />
        <StateRow
          label="数据源"
          value={
            loadingData ? "加载中" : productionMode ? "云端实时" : "真实账号"
          }
        />
        <StateRow label="云端目标" value={CLOUD_MOBILE_APP_URL} />
        <StateRow label="Workspace" value={activeThread.workspace} />
        <StateRow label="Thread" value={activeThread.title} />
        <StateRow label="语音状态" value={recording ? "录音中" : "空闲"} />
      </div>
      <div className="mt-5 grid gap-2">
        <button
          type="button"
          onClick={onOpenMenu}
          className="rounded-2xl border border-white/10 bg-white/[.08] px-4 py-3 text-left text-sm font-bold text-white transition hover:bg-white/[.12] light:border-slate-200 light:bg-slate-50 light:text-slate-800 light:hover:bg-white"
        >
          {productionMode ? "打开云端工作区抽屉" : "打开真实工作区抽屉"}
        </button>
        <button
          type="button"
          onClick={onReset}
          className="rounded-2xl border border-sky-300/20 bg-sky-400/[.12] px-4 py-3 text-left text-sm font-bold text-sky-100 transition hover:bg-sky-400/[.18] light:border-sky-200 light:bg-sky-50 light:text-sky-700"
        >
          {productionMode ? "刷新云端历史" : "刷新当前真实历史"}
        </button>
      </div>
      <p className="mt-5 text-xs leading-5 text-white/[.45] light:text-slate-500">
        {productionMode
          ? "当前页面使用本地最新移动端代码，通过 /api 代理读取 athenallm.online 的真实账号、workspace、thread 与聊天历史。"
          : "本页已接入当前登录账号的 workspace、thread 与聊天历史。云端调试可使用 cloudMobile=proxy 或 cloudMobile=launch。"}
      </p>
      {dataError && (
        <p className="mt-3 rounded-2xl bg-amber-100 px-3 py-2 text-xs font-bold text-amber-700">
          {dataError}
        </p>
      )}
    </aside>
  );
}

function StateRow({ label, value }) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-2xl bg-white/[.045] px-3 py-2 light:bg-slate-100">
      <span className="shrink-0 text-xs font-semibold uppercase tracking-wide opacity-60">
        {label}
      </span>
      <span className="min-w-0 text-right text-xs font-bold">{value}</span>
    </div>
  );
}

function ChromeMobileShell({ children, address = "athena.local" }) {
  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-[#f8fbff] text-slate-950">
      <div className="relative z-30 border-b border-slate-200/80 bg-white/80 px-3 pb-2 pt-[52px] shadow-[0_10px_28px_rgba(15,23,42,0.08)] backdrop-blur-2xl">
        <div className="flex items-center gap-2">
          <ChromeLogo />
          <div className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-full border border-slate-200 bg-slate-100/90 px-3 shadow-inner">
            <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
            <span className="min-w-0 flex-1 truncate text-[12px] font-bold text-slate-700">
              {address}
            </span>
          </div>
          <button
            type="button"
            className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-100 text-slate-600"
            aria-label="Chrome 新建标签页"
          >
            <Plus size={18} weight="bold" />
          </button>
          <button
            type="button"
            className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-100 text-slate-600"
            aria-label="Chrome 更多"
          >
            <DotsThree size={20} weight="bold" />
          </button>
        </div>
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}

export function MobileLoginScreen({
  user,
  pfp,
  loginAccountHint = null,
  subtitle = "移动端模拟区已退出",
  initialMode = "quick",
  onQuickLogin,
  onPasswordLogin,
  onPasskeyLogin,
  allowPublicRegistration = false,
  onRegistrationSuccess,
}) {
  const accountName = loginAccountHint?.accountName || mobileAccountName(user);
  const accountPfp = loginAccountHint?.avatarUrl || pfp;
  const [mode, setMode] = useState(initialMode);
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [quickSubmitting, setQuickSubmitting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [passkeySubmitting, setPasskeySubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [authCapability, setAuthCapability] = useState(() =>
    detectAuthCapability()
  );

  useEffect(() => {
    setAuthCapability(detectAuthCapability());
  }, [mode]);

  useEffect(() => {
    setMode(initialMode);
    setError(null);
    setQuickSubmitting(false);
  }, [initialMode]);

  async function handlePasswordSubmit(event) {
    event.preventDefault();
    if (!identifier.trim() || !password || passkeySubmitting || quickSubmitting)
      return;

    setSubmitting(true);
    setError(null);
    const result = await onPasswordLogin?.({
      identifier: identifier.trim(),
      password,
    });
    setSubmitting(false);

    if (!result?.success) {
      setError(result?.error || "登录失败，请重试。");
    }
  }

  async function handlePasskeySubmit() {
    if (
      !authCapability.showPasskey ||
      submitting ||
      passkeySubmitting ||
      quickSubmitting
    )
      return;

    setPasskeySubmitting(true);
    setError(null);
    const result = await onPasskeyLogin?.();
    setPasskeySubmitting(false);

    if (!result?.success) {
      setError(result?.error || "通行密钥登录失败，请重试。");
    }
  }

  async function handleQuickSubmit() {
    if (quickSubmitting || submitting || passkeySubmitting) return;
    setQuickSubmitting(true);
    setError(null);
    const result = await onQuickLogin?.();
    setQuickSubmitting(false);

    if (!result?.success) {
      setError(result?.error || "快速登录失败，请使用账号密码登录。");
    }
  }

  return (
    <div className="relative flex h-full flex-col items-center justify-center px-7 text-center">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_25%_22%,rgba(125,211,252,0.28),transparent_34%),radial-gradient(circle_at_88%_18%,rgba(167,139,250,0.20),transparent_30%),linear-gradient(180deg,rgba(255,255,255,0.78),rgba(239,246,255,0.92))]" />
      <div className="mobile-login-card-animated relative w-full rounded-[32px] border border-white/80 bg-white/70 px-5 py-6 text-slate-950 shadow-[0_24px_72px_rgba(15,23,42,0.16)] backdrop-blur-2xl">
        <div key={mode} className="mobile-login-panel-animated">
          <div
            className="mobile-login-item mx-auto w-fit"
            style={{ "--mobile-login-item-delay": "20ms" }}
          >
            <MobileAccountAvatar pfp={accountPfp} className="h-16 w-16" />
          </div>
          <p
            className="mobile-login-item mt-5 text-[22px] font-black leading-7"
            style={{ "--mobile-login-item-delay": "55ms" }}
          >
            Athena
          </p>
          <p
            className="mobile-login-item mt-2 text-sm font-semibold text-slate-500"
            style={{ "--mobile-login-item-delay": "85ms" }}
          >
            {subtitle}
          </p>

          {mode === "quick" ? (
            <>
              <div
                className="mobile-login-item relative mt-6 rounded-[20px] border border-slate-200/80 bg-slate-100/70 px-4 pb-4 pt-5 text-left shadow-[inset_0_1px_0_rgba(255,255,255,0.78)]"
                style={{ "--mobile-login-item-delay": "120ms" }}
              >
                <p className="absolute -top-2 left-4 rounded-full bg-[#f8fbff] px-2 text-[11px] font-bold leading-4 text-slate-400">
                  快速登录账号
                </p>
                <p className="truncate text-[15px] font-black text-slate-950">
                  {accountName}
                </p>
              </div>

              <div
                className="mobile-login-item mt-5 flex justify-center"
                style={{ "--mobile-login-item-delay": "155ms" }}
              >
                <AppButton
                  type="button"
                  variant="primary"
                  size="md"
                  className="min-w-[132px]"
                  loading={quickSubmitting}
                  disabled={quickSubmitting || submitting || passkeySubmitting}
                  onClick={handleQuickSubmit}
                >
                  快速登录
                </AppButton>
              </div>
              {error && (
                <p
                  className="mobile-login-item mt-3 text-center text-xs font-semibold text-rose-500"
                  style={{ "--mobile-login-item-delay": "170ms" }}
                >
                  {error}
                </p>
              )}
              <div
                className="mobile-login-item mt-3 flex items-center justify-between gap-3"
                style={{ "--mobile-login-item-delay": "185ms" }}
              >
                {allowPublicRegistration ? (
                  <button
                    type="button"
                    onClick={() => {
                      setError(null);
                      setMode("register");
                    }}
                    className="text-xs font-bold text-sky-600 transition hover:text-sky-800"
                  >
                    创建账号
                  </button>
                ) : (
                  <span />
                )}
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setMode("password");
                  }}
                  className="text-xs font-bold text-slate-500 transition hover:text-slate-900"
                >
                  账号密码登录
                </button>
              </div>
            </>
          ) : mode === "register" ? (
            <MobileRegistrationForm
              onBack={() => {
                setError(null);
                setMode("password");
              }}
              onSuccess={onRegistrationSuccess}
            />
          ) : (
            <form className="mt-5 text-left" onSubmit={handlePasswordSubmit}>
              <p
                className="mobile-login-item text-center text-sm font-black text-slate-900"
                style={{ "--mobile-login-item-delay": "120ms" }}
              >
                账号密码登录
              </p>
              <label
                className="mobile-login-item group relative mt-4 block rounded-[18px] border border-slate-200/80 bg-slate-100/75 px-4 pb-3 pt-4 text-left shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] transition focus-within:border-sky-300 focus-within:bg-white/90 focus-within:ring-2 focus-within:ring-sky-400/20"
                style={{ "--mobile-login-item-delay": "150ms" }}
              >
                <span className="absolute -top-2 left-4 rounded-full bg-[#f8fbff] px-1.5 text-[11px] font-semibold leading-4 text-slate-500 transition group-focus-within:text-sky-600">
                  邮箱或用户名
                </span>
                <input
                  type="text"
                  value={identifier}
                  onChange={(event) => {
                    setError(null);
                    setIdentifier(event.target.value);
                  }}
                  autoComplete="username"
                  className="block h-8 w-full border-0 bg-transparent p-0 text-base font-semibold text-slate-900 outline-none placeholder:text-slate-400"
                />
              </label>
              <label
                className="mobile-login-item group relative mt-4 block rounded-[18px] border border-slate-200/80 bg-slate-100/75 px-4 pb-3 pt-4 text-left shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] transition focus-within:border-sky-300 focus-within:bg-white/90 focus-within:ring-2 focus-within:ring-sky-400/20"
                style={{ "--mobile-login-item-delay": "180ms" }}
              >
                <span className="absolute -top-2 left-4 rounded-full bg-[#f8fbff] px-1.5 text-[11px] font-semibold leading-4 text-slate-500 transition group-focus-within:text-sky-600">
                  密码
                </span>
                <input
                  type="password"
                  value={password}
                  onChange={(event) => {
                    setError(null);
                    setPassword(event.target.value);
                  }}
                  autoComplete="current-password"
                  className="block h-8 w-full border-0 bg-transparent p-0 text-base font-semibold text-slate-900 outline-none placeholder:text-slate-400"
                />
              </label>
              {error && (
                <p
                  className="mobile-login-item mt-3 text-center text-xs font-semibold text-rose-500"
                  style={{ "--mobile-login-item-delay": "205ms" }}
                >
                  {error}
                </p>
              )}
              <div
                className="mobile-login-item mt-5 flex justify-center"
                style={{ "--mobile-login-item-delay": "220ms" }}
              >
                <AppButton
                  type="submit"
                  variant="primary"
                  size="md"
                  loading={submitting}
                  disabled={
                    submitting ||
                    passkeySubmitting ||
                    quickSubmitting ||
                    !identifier.trim() ||
                    !password
                  }
                  className="w-[164px]"
                >
                  登录
                </AppButton>
              </div>
              <div
                className="mobile-login-item mt-3 flex justify-center"
                style={{ "--mobile-login-item-delay": "245ms" }}
              >
                <AppButton
                  type="button"
                  variant="secondary"
                  size="md"
                  loading={passkeySubmitting}
                  disabled={
                    submitting ||
                    passkeySubmitting ||
                    quickSubmitting ||
                    !authCapability.showPasskey
                  }
                  leftIcon={<Fingerprint size={17} weight="bold" />}
                  className="w-[164px]"
                  title={passkeyCapabilityDescription(authCapability)}
                  onClick={handlePasskeySubmit}
                >
                  {authCapability.showPasskey
                    ? "通行密钥登录"
                    : "通行密钥不可用"}
                </AppButton>
              </div>
              {!authCapability.showPasskey && (
                <p
                  className="mobile-login-item mt-2 text-center text-[11px] font-semibold leading-4 text-slate-400"
                  style={{ "--mobile-login-item-delay": "260ms" }}
                >
                  {passkeyCapabilityDescription(authCapability)}
                </p>
              )}
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setMode("quick");
                }}
                className="mobile-login-item mx-auto mt-3 block text-xs font-bold text-slate-500 transition hover:text-slate-900"
                style={{ "--mobile-login-item-delay": "275ms" }}
              >
                使用快速登录
              </button>
              {allowPublicRegistration ? (
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setMode("register");
                  }}
                  className="mobile-login-item mx-auto mt-3 block text-xs font-bold text-sky-600 transition hover:text-sky-800"
                  style={{ "--mobile-login-item-delay": "285ms" }}
                >
                  创建账号
                </button>
              ) : null}
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

function MobileRegistrationForm({ onBack, onSuccess }) {
  const [step, setStep] = useState("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [challengeId, setChallengeId] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [sendingCode, setSendingCode] = useState(false);
  const [resendRemaining, setResendRemaining] = useState(0);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (resendRemaining <= 0) return;
    const timer = setTimeout(
      () => setResendRemaining((current) => Math.max(0, current - 1)),
      1_000
    );
    return () => clearTimeout(timer);
  }, [resendRemaining]);

  const normalizedEmail = normalizeMobileRegistrationEmail(email);

  async function sendRegistrationCode({ clearError = false } = {}) {
    if (sendingCode || resendRemaining > 0 || !normalizedEmail) return false;
    setSendingCode(true);
    if (clearError) setError(null);
    const result = await System.requestRegistrationCode({
      email: normalizedEmail,
    });
    setSendingCode(false);

    if (!result?.success) {
      setError(result?.error || "无法发送注册验证码。");
      return false;
    }

    setEmail(result.email || normalizedEmail);
    setChallengeId(result.challengeId || "");
    setResendRemaining(Number(result.resendCooldownSeconds) || 60);
    return true;
  }

  async function handleEmailSubmit(event) {
    event.preventDefault();
    if (loading) return;
    if (!isValidMobileRegistrationEmail(normalizedEmail)) {
      setError("请输入有效邮箱地址。");
      return;
    }

    setLoading(true);
    setError(null);
    const check = await System.checkRegistrationEmail({
      email: normalizedEmail,
    });
    setLoading(false);

    if (!check?.success) {
      setError(check?.error || "该邮箱暂时无法注册。");
      return;
    }

    setEmail(check.email || normalizedEmail);
    setCode("");
    setChallengeId("");
    setStep("code");
    setResendRemaining(0);
    setTimeout(() => sendRegistrationCode({ clearError: true }), 0);
  }

  async function handleCodeSubmit(event) {
    event.preventDefault();
    if (loading) return;
    if (!/^\d{6}$/.test(code.trim())) {
      setError("请输入 6 位邮箱验证码。");
      return;
    }

    setLoading(true);
    setError(null);
    const result = await System.verifyRegistrationCode({
      email: normalizedEmail,
      code: code.trim(),
      challengeId,
    });
    setLoading(false);

    if (!result?.success) {
      setError(result?.error || "验证码不正确或已过期。");
      return;
    }

    setEmail(result.email || normalizedEmail);
    setChallengeId(result.challengeId || challengeId);
    setStep("password");
  }

  async function handleRegisterSubmit(event) {
    event.preventDefault();
    if (loading) return;
    if (password.length < 8) {
      setError("密码至少需要 8 位。");
      return;
    }
    if (password !== confirmPassword) {
      setError("两次输入的密码不一致。");
      return;
    }

    setLoading(true);
    setError(null);
    const result = await System.registerAccount({
      email: normalizedEmail,
      code: code.trim(),
      challengeId,
      password,
      confirmPassword,
    });
    setLoading(false);

    if (result?.success && result?.token && result?.user) {
      const loginResult = await onSuccess?.(result);
      if (!loginResult || loginResult.success) return;
      setError(loginResult.error || "注册成功，但自动登录失败，请手动登录。");
      return;
    }

    setError(result?.error || "无法完成注册，请检查信息后重试。");
  }

  if (step === "email") {
    return (
      <form className="mt-5 text-left" onSubmit={handleEmailSubmit}>
        <MobileLoginBackButton onClick={onBack} />
        <p className="mobile-login-item text-center text-sm font-black text-slate-900">
          创建账号
        </p>
        <p className="mobile-login-item mt-2 text-center text-xs font-semibold leading-5 text-slate-500">
          公开注册开启时，可通过邮箱验证码创建普通用户账号。
        </p>
        <MobileLoginTextField
          label="邮箱"
          type="email"
          value={email}
          inputMode="email"
          autoComplete="email"
          onChange={(event) => {
            setError(null);
            setEmail(normalizeMobileRegistrationEmail(event.target.value));
          }}
          delay="145ms"
        />
        <MobileLoginError error={error} />
        <div className="mobile-login-item mt-5 flex justify-center">
          <AppButton
            type="submit"
            variant="primary"
            size="md"
            loading={loading}
            disabled={loading || !normalizedEmail}
            className="w-[164px]"
          >
            继续
          </AppButton>
        </div>
      </form>
    );
  }

  if (step === "code") {
    return (
      <form className="mt-5 text-left" onSubmit={handleCodeSubmit}>
        <MobileLoginBackButton
          onClick={() => {
            setError(null);
            setCode("");
            setStep("email");
          }}
        />
        <p className="mobile-login-item text-center text-sm font-black text-slate-900">
          验证邮箱
        </p>
        <p className="mobile-login-item mt-2 text-center text-xs font-semibold leading-5 text-slate-500">
          输入发送到 {normalizedEmail || "邮箱"} 的 6 位验证码。
        </p>
        <MobileLoginTextField
          label="邮箱"
          type="email"
          value={email}
          readOnly
          delay="145ms"
        />
        <MobileLoginTextField
          label="邮箱验证码"
          type="text"
          value={code}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          onChange={(event) => {
            setError(null);
            setCode(event.target.value.replace(/\D/g, "").slice(0, 6));
          }}
          delay="175ms"
        />
        <MobileLoginError error={error} />
        <div className="mobile-login-item mt-5 flex justify-center">
          <AppButton
            type="submit"
            variant="primary"
            size="md"
            loading={loading}
            disabled={loading || sendingCode || !/^\d{6}$/.test(code)}
            className="w-[164px]"
          >
            验证并继续
          </AppButton>
        </div>
        <button
          type="button"
          disabled={sendingCode || resendRemaining > 0}
          onClick={() => sendRegistrationCode({ clearError: true })}
          className="mobile-login-item mx-auto mt-3 block text-xs font-bold text-slate-500 transition enabled:hover:text-slate-900 disabled:text-slate-300"
        >
          {resendRemaining > 0
            ? `${resendRemaining} 秒后可重新发送`
            : sendingCode
              ? "正在发送..."
              : "重新发送验证码"}
        </button>
      </form>
    );
  }

  return (
    <form className="mt-5 text-left" onSubmit={handleRegisterSubmit}>
      <MobileLoginBackButton
        onClick={() => {
          setError(null);
          setStep("code");
        }}
      />
      <p className="mobile-login-item text-center text-sm font-black text-slate-900">
        设置密码
      </p>
      <p className="mobile-login-item mt-2 text-center text-xs font-semibold leading-5 text-slate-500">
        邮箱已验证，创建后会自动登录移动端。
      </p>
      <MobileLoginTextField
        label="密码"
        type="password"
        value={password}
        autoComplete="new-password"
        onChange={(event) => {
          setError(null);
          setPassword(event.target.value);
        }}
        delay="145ms"
      />
      <MobileLoginTextField
        label="确认密码"
        type="password"
        value={confirmPassword}
        autoComplete="new-password"
        onChange={(event) => {
          setError(null);
          setConfirmPassword(event.target.value);
        }}
        delay="175ms"
      />
      <MobileLoginError error={error} />
      <div className="mobile-login-item mt-5 flex justify-center">
        <AppButton
          type="submit"
          variant="primary"
          size="md"
          loading={loading}
          disabled={loading || !password || !confirmPassword}
          className="w-[164px]"
        >
          注册
        </AppButton>
      </div>
    </form>
  );
}

function MobileLoginTextField({
  label,
  value,
  onChange,
  delay = "150ms",
  ...props
}) {
  return (
    <label
      className="mobile-login-item group relative mt-4 block rounded-[18px] border border-slate-200/80 bg-slate-100/75 px-4 pb-3 pt-4 text-left shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] transition focus-within:border-sky-300 focus-within:bg-white/90 focus-within:ring-2 focus-within:ring-sky-400/20"
      style={{ "--mobile-login-item-delay": delay }}
    >
      <span className="absolute -top-2 left-4 rounded-full bg-[#f8fbff] px-1.5 text-[11px] font-semibold leading-4 text-slate-500 transition group-focus-within:text-sky-600">
        {label}
      </span>
      <input
        {...props}
        value={value}
        onChange={onChange}
        className="block h-8 w-full border-0 bg-transparent p-0 text-base font-semibold text-slate-900 outline-none placeholder:text-slate-400 disabled:text-slate-500"
      />
    </label>
  );
}

function MobileLoginBackButton({ onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mobile-login-item mb-3 text-xs font-bold text-slate-500 transition hover:text-slate-900"
    >
      返回登录
    </button>
  );
}

function MobileLoginError({ error }) {
  if (!error) return null;
  return (
    <p className="mobile-login-item mt-3 text-center text-xs font-semibold text-rose-500">
      {error}
    </p>
  );
}

function normalizeMobileRegistrationEmail(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function isValidMobileRegistrationEmail(value = "") {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function ChromeLogo() {
  return (
    <div
      className="relative h-9 w-9 shrink-0 rounded-full border border-white shadow-[0_8px_20px_rgba(15,23,42,0.14)]"
      aria-hidden="true"
      style={{
        background:
          "conic-gradient(from 35deg, #ea4335 0 33%, #fbbc05 0 66%, #34a853 0 83%, #4285f4 0)",
      }}
    >
      <div className="absolute left-1/2 top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-sky-500" />
    </div>
  );
}

function PhoneTopBar({
  activeThread,
  moreButtonRef,
  onOpenMenu,
  onNewConversation,
  onOpenMore,
}) {
  return (
    <header className="pointer-events-none absolute left-0 right-0 top-0 z-20 px-4 pb-2 pt-3">
      <GlassCard
        className="liquid-glass-composer-card pointer-events-auto overflow-hidden rounded-[26px]"
        displacementScale={18}
        blurAmount={0.015}
        cornerRadius={26}
        padding="0px"
        shadowMode={false}
        style={{
          "--composer-glass-tint": "rgb(255 255 255 / 0.42)",
          "--composer-glass-shadow": "0 14px 34px rgb(15 23 42 / 0.13)",
          "--composer-glass-focus-shadow": "0 14px 38px rgb(14 165 233 / 0.18)",
          borderRadius: "26px",
        }}
      >
        <div className="liquid-glass-composer-content flex min-h-[58px] items-center gap-2 px-2 py-2">
          <button
            type="button"
            onClick={onOpenMenu}
            className="flex h-10 w-10 items-center justify-center rounded-full text-slate-700 transition hover:bg-slate-950/[.045] active:bg-slate-950/[.07]"
            aria-label="打开菜单"
          >
            <List size={21} weight="regular" />
          </button>
          <div className="min-w-0 flex-1 px-1">
            <p className="truncate text-xs font-medium text-sky-600">
              {activeThread.workspace}
            </p>
            <p className="truncate text-[15px] font-semibold leading-5 text-slate-950">
              {activeThread.title}
            </p>
          </div>
          <button
            type="button"
            onClick={onNewConversation}
            className="flex h-10 w-10 items-center justify-center rounded-full text-slate-700 transition hover:bg-slate-950/[.045] active:bg-slate-950/[.07]"
            aria-label="新建对话"
          >
            <NotePencil size={21} weight="regular" />
          </button>
          <button
            ref={moreButtonRef}
            type="button"
            onClick={onOpenMore}
            className="flex h-10 w-10 items-center justify-center rounded-full text-slate-700 transition hover:bg-slate-950/[.045] active:bg-slate-950/[.07]"
            aria-label="更多操作"
          >
            <DotsThree size={22} weight="regular" />
          </button>
        </div>
      </GlassCard>
    </header>
  );
}

function ChatPane({
  chatPaneRef,
  messages,
  runtimeActivity = null,
  workspaceName = "",
  workspaceSlug,
  threadSlug,
  loadingRecent = false,
  messagesEndRef,
  hasNewMessages = false,
  composerBottomInset = MOBILE_COMPOSER_FALLBACK_INSET,
  onScroll,
  onWheel,
  onTouchMove,
  onJumpToLatest,
  onQuizUpdate,
  copiedMessageId,
  editingMessageId,
  editingText,
  messageActionBusy,
  speakingMessageId,
  onCancelEdit,
  onChangeEdit,
  onCopyMessage,
  onDeleteMessage,
  onForkMessage,
  onRegenerateMessage,
  onSaveEdit,
  onSpeakMessage,
  onStartEdit,
}) {
  const latestUserIndex = runtimeActivity
    ? messages.reduce(
        (latestIndex, message, index) =>
          message.role === "user" ? index : latestIndex,
        -1
      )
    : -1;
  const latestAssistantIndex = runtimeActivity
    ? messages.reduce(
        (latestIndex, message, index) =>
          message.role === "assistant" && index > latestUserIndex
            ? index
            : latestIndex,
        -1
      )
    : -1;
  const runtimeOnlyMessage =
    runtimeActivity && latestAssistantIndex < 0
      ? {
          id: `runtime-${runtimeActivity.key || "active"}`,
          role: "assistant",
          text: "",
          time: "",
        }
      : null;
  const showLoadingSkeleton =
    loadingRecent && !runtimeActivity && messages.length === 0;
  const showEmptyWelcome =
    !showLoadingSkeleton && !runtimeActivity && messages.length === 0;

  return (
    <div
      ref={chatPaneRef}
      onScroll={onScroll}
      onWheel={onWheel}
      onTouchMove={onTouchMove}
      data-mobile-chat-pane="true"
      className="no-scroll -mr-4 flex h-full flex-col gap-3 overflow-y-auto pr-4 pt-[92px]"
      style={{
        paddingBottom: mobileChatPanePaddingBottom(composerBottomInset),
        overscrollBehavior: "contain",
      }}
    >
      {showEmptyWelcome && (
        <MobileEmptyThreadWelcome workspaceName={workspaceName} />
      )}
      {showLoadingSkeleton && <MobileThreadHistorySkeleton />}
      {messages.map((message, index) => (
        <MessageBubble
          key={message.id}
          message={message}
          runtimeActivity={
            message.runtimeActivity ||
            (index === latestAssistantIndex ? runtimeActivity : null)
          }
          runtimeOnly={!!message.runtimeOnly}
          workspaceSlug={workspaceSlug}
          threadSlug={threadSlug}
          onQuizUpdate={onQuizUpdate}
          copied={copiedMessageId === message.id}
          editing={editingMessageId === message.id}
          editingText={editingText}
          busy={messageActionBusy?.startsWith(`${message.id}:`)}
          speaking={speakingMessageId === message.id}
          onCancelEdit={onCancelEdit}
          onChangeEdit={onChangeEdit}
          onCopyMessage={onCopyMessage}
          onDeleteMessage={onDeleteMessage}
          onForkMessage={onForkMessage}
          onRegenerateMessage={onRegenerateMessage}
          onSaveEdit={onSaveEdit}
          onSpeakMessage={onSpeakMessage}
          onStartEdit={onStartEdit}
        />
      ))}
      {runtimeOnlyMessage && (
        <MessageBubble
          key={runtimeOnlyMessage.id}
          message={runtimeOnlyMessage}
          runtimeActivity={runtimeActivity}
          runtimeOnly
          workspaceSlug={workspaceSlug}
          threadSlug={threadSlug}
          onQuizUpdate={onQuizUpdate}
          copied={false}
          editing={false}
          editingText=""
          busy={false}
          speaking={false}
          onCancelEdit={onCancelEdit}
          onChangeEdit={onChangeEdit}
          onCopyMessage={onCopyMessage}
          onDeleteMessage={onDeleteMessage}
          onForkMessage={onForkMessage}
          onRegenerateMessage={onRegenerateMessage}
          onSaveEdit={onSaveEdit}
          onSpeakMessage={onSpeakMessage}
          onStartEdit={onStartEdit}
        />
      )}
      {hasNewMessages && (
        <button
          type="button"
          onClick={onJumpToLatest}
          data-mobile-new-messages-button="true"
          className="sticky z-20 self-end rounded-full border border-sky-200/80 bg-white/90 px-4 py-2 text-xs font-black text-sky-700 shadow-lg backdrop-blur-xl"
          style={{
            bottom: mobileNewMessageButtonBottom(composerBottomInset),
          }}
        >
          新消息
        </button>
      )}
      <div ref={messagesEndRef} />
    </div>
  );
}

function MobileThreadHistorySkeleton() {
  return (
    <div className="flex flex-col gap-5 px-1 pt-1" aria-label="加载聊天记录">
      <div className="ml-auto h-24 w-[76%] animate-pulse rounded-[28px] bg-white/70 shadow-[0_18px_42px_rgba(148,163,184,0.16)]" />
      <div className="flex flex-col gap-3">
        <div className="h-4 w-24 animate-pulse rounded-full bg-slate-200/80" />
        <div className="h-4 w-[86%] animate-pulse rounded-full bg-white/80" />
        <div className="h-4 w-[72%] animate-pulse rounded-full bg-white/80" />
        <div className="h-4 w-[58%] animate-pulse rounded-full bg-white/70" />
      </div>
      <div className="ml-auto h-20 w-[68%] animate-pulse rounded-[28px] bg-white/70 shadow-[0_18px_42px_rgba(148,163,184,0.14)]" />
    </div>
  );
}

function MobileEmptyThreadWelcome({ workspaceName = "" }) {
  const name = normalizedText(workspaceName) || "这个工作区";

  return (
    <div className="flex min-h-[52vh] flex-1 items-center justify-center px-5 text-center">
      <div className="max-w-[320px]">
        <p className="text-[25px] font-black leading-[1.35] text-slate-950">
          欢迎来到{name}
        </p>
        <p className="mt-2 text-[19px] font-semibold leading-[1.5] text-slate-500">
          想聊点什么呢？
        </p>
      </div>
    </div>
  );
}

const MobileRuntimeSheet = React.forwardRef(function MobileRuntimeSheet(
  { chatKey, pendingApproval, onToolApprovalResponse },
  ref
) {
  if (!pendingApproval) return null;

  return (
    <div
      className="pointer-events-none absolute inset-x-3 z-40 transition-[bottom] duration-150 ease-out"
      style={{
        bottom: "calc(144px + var(--mobile-keyboard-inset, 0px))",
      }}
    >
      <div
        ref={ref}
        tabIndex={-1}
        className="mobile-runtime-sheet pointer-events-auto max-h-[58%] overflow-y-auto rounded-[26px] border border-slate-200/80 bg-white/95 p-2 shadow-[0_18px_44px_rgba(15,23,42,0.14)] outline-none backdrop-blur-2xl focus-visible:ring-2 focus-visible:ring-sky-300"
      >
        <MobileAgentInterventionArea
          chatKey={chatKey}
          pendingApproval={pendingApproval}
          onToolApprovalResponse={onToolApprovalResponse}
        />
      </div>
    </div>
  );
});

function MobileAgentInterventionArea({
  chatKey,
  pendingApproval,
  onToolApprovalResponse,
}) {
  if (!pendingApproval) return null;

  return (
    <div className="space-y-2">
      <MobileToolApprovalCard
        key={pendingApproval?.requestId || "approval"}
        chatKey={chatKey}
        approval={pendingApproval}
        onResponse={onToolApprovalResponse}
      />
    </div>
  );
}

function MobileToolApprovalCard({ chatKey, approval, onResponse }) {
  const [alwaysAllow, setAlwaysAllow] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const skillName = mobileToolName(approval);
  const disabled = !chatKey || !approval?.requestId || submitting;

  useEffect(() => {
    setAlwaysAllow(false);
    setSubmitting(false);
    setError(null);
  }, [approval?.requestId]);

  async function respond(approved) {
    if (disabled) return;
    setSubmitting(true);
    setError(null);
    try {
      if (approved && alwaysAllow) {
        await AgentSkillWhitelist.addToWhitelist(skillName);
      }
      const result = await onResponse?.(chatKey, approval.requestId, approved);
      if (result?.ok === false) throw new Error(result.reason || "failed");
    } catch {
      setError("响应失败，请重试。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="rounded-[22px] border border-slate-200/80 bg-white p-3 text-slate-950 shadow-[0_10px_26px_rgba(15,23,42,0.08)]">
      <div className="flex items-center gap-2">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-50 text-amber-600">
          <Shield size={16} weight="regular" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-[17px] font-semibold leading-[1.45]">
            批准工具调用
          </p>
          <p className="mt-0.5 truncate text-[15px] font-normal leading-[1.45] text-slate-500">
            {skillName}
          </p>
        </div>
      </div>

      {approval?.allowAlwaysAllow !== false && (
        <label className="mt-3 flex items-center gap-2 rounded-2xl bg-slate-50 px-3 py-2 text-xs font-normal text-slate-600">
          <input
            type="checkbox"
            checked={alwaysAllow}
            onChange={(event) => setAlwaysAllow(event.target.checked)}
            className="h-3.5 w-3.5 rounded border-slate-300"
          />
          <span className="min-w-0 truncate">始终允许此工具</span>
        </label>
      )}

      {error && (
        <p className="mt-2 text-xs font-normal text-rose-500">{error}</p>
      )}

      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          disabled={disabled}
          onClick={() => respond(false)}
          className="flex h-9 items-center gap-1.5 rounded-full px-3 text-xs font-semibold text-slate-600 transition hover:bg-white disabled:opacity-50"
        >
          <X size={14} weight="regular" />
          拒绝
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => respond(true)}
          className="flex h-9 items-center gap-1.5 rounded-full bg-slate-950 px-4 text-xs font-semibold text-white shadow-[0_8px_18px_rgba(15,23,42,0.16)] transition hover:bg-slate-800 disabled:opacity-50"
        >
          <Check size={14} weight="regular" />
          批准
        </button>
      </div>
    </div>
  );
}

const MobileClarificationSurveyDock = React.forwardRef(
  function MobileClarificationSurveyDock(
    { chatKey, clarification, onResponse },
    ref
  ) {
    const questions = useMemo(
      () => arrayPayload(clarification?.questions).slice(0, 3),
      [clarification?.questions]
    );
    const timeoutMs = Number(clarification?.timeoutMs || 0);
    const progressPercent = useTimeoutProgress(timeoutMs, {
      active: !!timeoutMs && !!clarification?.requestId,
      intervalMs: 250,
    });
    const remainingMs = mobileTimeoutRemainingMs(
      timeoutMs,
      null,
      progressPercent
    );
    const total = questions.length;
    const [currentIndex, setCurrentIndex] = useState(0);
    const [answers, setAnswers] = useState(() =>
      questions.map(() => ({ selected: "", otherText: "" }))
    );
    const [customText, setCustomText] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState(null);
    const [sentSignature, setSentSignature] = useState(null);
    const disabled = !chatKey || !clarification?.requestId || submitting;
    const currentQuestion = questions[currentIndex] || null;
    const currentAnswer = answers[currentIndex] || {};
    const currentOptions = arrayPayload(currentQuestion?.options).slice(0, 3);

    useEffect(() => {
      setAnswers(questions.map(() => ({ selected: "", otherText: "" })));
      setCurrentIndex(0);
      setCustomText("");
      setSubmitting(false);
      setError(null);
      setSentSignature(null);
    }, [clarification?.requestId, questions]);

    useEffect(() => {
      setCustomText(answers[currentIndex]?.otherText || "");
    }, [answers, currentIndex]);

    function answerText(answer = {}) {
      return answer.otherText?.trim() || answer.selected || "";
    }

    const answeredCount = answers.filter(
      (answer) => !!answerText(answer)
    ).length;
    const isFirst = currentIndex <= 0;
    const isLast = currentIndex >= total - 1;
    const allAnswered = (nextAnswers = answers) =>
      total > 0 &&
      questions.every((_, index) => !!answerText(nextAnswers[index]));
    const answerSignature = (nextAnswers = answers) =>
      JSON.stringify(nextAnswers.map((answer) => answerText(answer)));

    async function submitAnswers(nextAnswers = answers) {
      if (disabled) return;
      if (!allAnswered(nextAnswers)) return;
      const signature = answerSignature(nextAnswers);
      if (sentSignature === signature) return;
      const answerCount = questions.length;
      setSubmitting(true);
      setError(null);
      mobileChatDebug("clarification:submit-start", {
        chatKey,
        requestId: clarification.requestId,
        answerCount,
      });
      try {
        const result = await onResponse?.(chatKey, clarification.requestId, {
          skipped: false,
          answers: questions.map((_, index) => ({
            skipped: false,
            answer: answerText(nextAnswers[index]),
          })),
        });
        if (result?.ok === false) throw new Error(result.reason || "failed");
        mobileChatDebug("clarification:submit-success", {
          chatKey,
          requestId: clarification.requestId,
          answerCount,
          transport: result?.transport || null,
          fallbackAttempted: !!result?.fallbackAttempted,
          websocketReason: result?.websocketReason || null,
        });
        setSentSignature(signature);
      } catch (error) {
        mobileChatDebug("clarification:submit-failure", {
          chatKey,
          requestId: clarification.requestId,
          answerCount,
          reason: error?.message || "failed",
        });
        setError("发送选择失败，请重试。");
      } finally {
        setSubmitting(false);
      }
    }

    function nextUnansweredIndex(nextAnswers, fromIndex) {
      for (let offset = 1; offset <= total; offset += 1) {
        const nextIndex = (fromIndex + offset) % total;
        if (!answerText(nextAnswers[nextIndex])) return nextIndex;
      }
      return -1;
    }

    function continueAfterAnswer(nextAnswers, fromIndex) {
      if (allAnswered(nextAnswers)) {
        submitAnswers(nextAnswers);
        return;
      }
      const nextIndex = nextUnansweredIndex(nextAnswers, fromIndex);
      if (nextIndex >= 0) setCurrentIndex(nextIndex);
    }

    function setAnswerAt(index, patch, { autoAdvance = true } = {}) {
      if (disabled || index < 0 || index >= total) return null;
      const nextAnswers = answers.map((answer, answerIndex) =>
        answerIndex === index ? { ...answer, ...patch } : answer
      );
      setAnswers(nextAnswers);
      setError(null);
      setSentSignature(null);
      if (autoAdvance) continueAfterAnswer(nextAnswers, index);
      return nextAnswers;
    }

    function selectOption(option) {
      setCustomText("");
      setAnswerAt(currentIndex, { selected: option, otherText: "" });
    }

    function confirmCustomAnswer({ autoAdvance = true } = {}) {
      const value = customText.trim();
      if (!value) return null;
      return setAnswerAt(
        currentIndex,
        {
          selected: "",
          otherText: value,
        },
        { autoAdvance }
      );
    }

    function goPrevious() {
      if (disabled || isFirst) return;
      setError(null);
      setCurrentIndex((index) => Math.max(0, index - 1));
    }

    function goNext() {
      if (disabled) return;
      if (customText.trim()) {
        const nextAnswers = confirmCustomAnswer({ autoAdvance: !isLast });
        if (!isLast) return;
        submitAnswers(nextAnswers || answers);
        return;
      }
      setError(null);
      if (!isLast) {
        setCurrentIndex((index) => Math.min(total - 1, index + 1));
        return;
      }
      submitAnswers(answers);
    }

    function handleCustomKeyDown(event) {
      if (event.key !== "Enter" || event.nativeEvent?.isComposing) return;
      event.preventDefault();
      confirmCustomAnswer();
    }

    if (!questions.length) return null;

    return (
      <div
        className="pointer-events-none absolute left-0 right-0 z-40 px-4 pb-4 pt-2 transition-[bottom] duration-150 ease-out"
        style={{
          bottom: "var(--mobile-keyboard-inset, 0px)",
        }}
      >
        <div className="mobile-runtime-sheet pointer-events-auto overflow-hidden rounded-[28px] border border-slate-200/80 bg-white/95 shadow-[0_18px_44px_rgba(15,23,42,0.14)] backdrop-blur-2xl">
          <div ref={ref} tabIndex={-1} className="outline-none">
            <div className="px-3 pb-3 pt-3 text-slate-950">
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-violet-50 text-violet-600 shadow-[0_6px_14px_rgba(124,58,237,0.10)]">
                  <Question size={16} weight="regular" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold">补充选择</p>
                  <p className="mt-0.5 text-[11px] font-normal text-slate-500">
                    {currentIndex + 1} / {total} · 已回答 {answeredCount}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <MobileSurveyIconButton
                    label="上一题"
                    icon={CaretLeft}
                    disabled={disabled || isFirst}
                    onClick={goPrevious}
                  />
                  <MobileSurveyIconButton
                    label="下一题"
                    icon={CaretRight}
                    disabled={
                      disabled ||
                      (isLast && !allAnswered(answers) && !customText.trim())
                    }
                    onClick={goNext}
                  />
                </div>
              </div>

              {!!timeoutMs && (
                <div className="mt-3">
                  <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className="h-full rounded-full bg-violet-500 transition-none"
                      style={{ width: `${progressPercent}%` }}
                    />
                  </div>
                  <p className="mt-1.5 text-[11px] font-normal text-violet-600">
                    请在 {formatMobileTimeout(remainingMs)}{" "}
                    内选择，超时后会自动继续。
                  </p>
                </div>
              )}

              <div className="mt-3 rounded-[22px] border border-slate-200/80 bg-white p-3 shadow-[0_8px_22px_rgba(15,23,42,0.06)]">
                <p className="text-sm font-semibold leading-5 text-slate-800">
                  {currentQuestion?.question}
                </p>
                <div className="mt-3 space-y-1.5">
                  {currentOptions.map((option) => {
                    const selected = currentAnswer.selected === option;
                    return (
                      <button
                        key={option}
                        type="button"
                        disabled={disabled}
                        onClick={() => selectOption(option)}
                        className={`flex w-full items-center gap-2 rounded-2xl px-3 py-2 text-left text-xs font-medium transition disabled:opacity-50 ${
                          selected
                            ? "bg-violet-50 text-slate-950 ring-1 ring-violet-300 shadow-[0_7px_18px_rgba(124,58,237,0.10)]"
                            : "bg-slate-50 text-slate-600 hover:bg-slate-100"
                        }`}
                      >
                        <span
                          className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                            selected ? "bg-violet-500" : "bg-slate-300"
                          }`}
                        />
                        <span className="min-w-0 flex-1 truncate">
                          {option}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="mt-2 rounded-[22px] border border-slate-200/80 bg-white px-3 py-2 shadow-[0_8px_22px_rgba(15,23,42,0.05)]">
                <input
                  type="text"
                  disabled={disabled}
                  value={customText}
                  onChange={(event) => {
                    setError(null);
                    setCustomText(event.target.value);
                  }}
                  onKeyDown={handleCustomKeyDown}
                  placeholder="自定义回答"
                  className="h-9 w-full bg-transparent text-base font-normal text-slate-900 outline-none placeholder:text-slate-400"
                />
              </div>

              <div className="mt-2 flex items-center justify-center gap-1.5">
                {questions.map((question, index) => {
                  const answered = !!answerText(answers[index]);
                  const active = index === currentIndex;
                  return (
                    <span
                      key={`${question.question}-${index}`}
                      className={`h-1.5 rounded-full transition-all ${
                        active
                          ? "w-5 bg-violet-500"
                          : answered
                            ? "w-2 bg-violet-300"
                            : "w-2 bg-slate-300"
                      }`}
                    />
                  );
                })}
              </div>

              {error && (
                <p className="mt-2 text-center text-xs font-normal text-rose-500">
                  {error}
                </p>
              )}
              {submitting && (
                <p className="mt-2 text-center text-xs font-normal text-slate-500">
                  正在发送选择...
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }
);

function MobileSurveyIconButton({
  label,
  icon: Icon,
  disabled = false,
  onClick,
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/70 text-slate-700 transition hover:bg-white disabled:bg-white/35 disabled:text-slate-300"
      aria-label={label}
      title={label}
    >
      <Icon size={15} weight="bold" />
    </button>
  );
}

function MobileAgentTimelineSummary({
  timeline = [],
  clarifyingQuestions = [],
  className = "mb-3",
}) {
  const rows = useMemo(() => {
    const events = mobileTimelineEvents(timeline);
    const toolNames = [
      ...new Set(
        events
          .filter((event) => event?.type === "tool_call")
          .map(mobileToolName)
          .filter(Boolean)
      ),
    ];
    const approvalNames = [
      ...new Set(
        events
          .filter((event) => event?.type === "approval_request")
          .map(mobileToolName)
          .filter(Boolean)
      ),
    ];
    const hasClarification =
      events.some((event) => event?.type === "clarification_request") ||
      arrayPayload(clarifyingQuestions).length > 0;

    return [
      ...toolNames.map((name) => ({
        key: `tool:${name}`,
        label: `已调用 ${name}`,
      })),
      ...approvalNames.map((name) => ({
        key: `approval:${name}`,
        label: `曾请求批准 ${name}`,
      })),
      ...(hasClarification
        ? [
            {
              key: "clarification",
              label: "已收集补充选择",
            },
          ]
        : []),
    ].slice(0, 4);
  }, [timeline, clarifyingQuestions]);

  if (!rows.length) return null;

  return (
    <div className={`space-y-1 ${className}`}>
      {rows.map((row) => (
        <MobileAgentActivityText key={row.key} label={row.label} />
      ))}
    </div>
  );
}

function MobileAgentActivityIcon({ label = "", running = false }) {
  const iconProps = {
    size: 18,
    weight: "bold",
    className: "mobile-agent-activity-icon mt-[4px] shrink-0 text-current",
    "aria-hidden": "true",
  };

  if (label.includes("批准")) return <Shield {...iconProps} />;
  if (label.includes("补充") || label.includes("选择"))
    return <Question {...iconProps} />;
  if (label.includes("测试题") || label.includes("生成"))
    return running ? <BookOpen {...iconProps} /> : <Check {...iconProps} />;
  if (label.includes("调用"))
    return running ? <GearSix {...iconProps} /> : <Check {...iconProps} />;
  if (label.includes("思考"))
    return running ? <Sparkle {...iconProps} /> : <Check {...iconProps} />;
  return running ? <CircleNotch {...iconProps} /> : <Check {...iconProps} />;
}

function MobileAgentActivityText({ label, running = false, className = "" }) {
  if (!label) return null;

  return (
    <div
      className={[
        "mobile-agent-activity-text flex max-w-full items-start gap-2 text-[17px] font-normal leading-[1.62] text-slate-500",
        running ? "mobile-agent-activity-shimmer" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <MobileAgentActivityIcon label={label} running={running} />
      <span className="mobile-agent-activity-label min-w-0 flex-1">
        {label}
      </span>
    </div>
  );
}

function MobileMessageAttachments({ attachments = [] }) {
  const images = arrayPayload(attachments).filter(
    (attachment) => attachment?.contentString
  );
  if (!images.length) return null;

  return (
    <div className="mb-2 flex flex-wrap justify-end gap-2">
      {images.map((attachment, index) => (
        <button
          key={`${attachment.name || "image"}-${index}`}
          type="button"
          onClick={() => openImageLightbox(images, index)}
          className="overflow-hidden rounded-[18px] border border-white/60 bg-white/55 shadow-[0_8px_22px_rgba(15,23,42,0.08)]"
          aria-label={`查看图片附件 ${attachment.name || index + 1}`}
        >
          <img
            src={attachment.contentString}
            alt={attachment.name || "图片附件"}
            className="h-24 w-24 object-cover"
          />
        </button>
      ))}
    </div>
  );
}

function MessageBubble({
  message,
  runtimeActivity = null,
  runtimeOnly = false,
  workspaceSlug = null,
  threadSlug = null,
  onQuizUpdate = null,
  copied = false,
  editing = false,
  editingText = "",
  busy = false,
  speaking = false,
  onCancelEdit,
  onChangeEdit,
  onCopyMessage,
  onDeleteMessage,
  onForkMessage,
  onRegenerateMessage,
  onSaveEdit,
  onSpeakMessage,
  onStartEdit,
}) {
  const isUser = message.role === "user";
  const [expanded, setExpanded] = useState(false);
  const actionChatId = message.publicChatId || message.chatId;
  const canUseRealActions = !!workspaceSlug && !!threadSlug && !!actionChatId;
  const hasText = !!message.text?.trim();
  const isStreamingAssistant =
    !isUser && (message.status === "running" || !!runtimeActivity);
  const userMessageChars = useMemo(
    () => Array.from(message.text || ""),
    [message.text]
  );
  const shouldCollapseUserMessage =
    isUser && userMessageChars.length > USER_MESSAGE_COLLAPSE_LENGTH;
  const visibleUserText =
    shouldCollapseUserMessage && !expanded
      ? `${userMessageChars.slice(0, USER_MESSAGE_COLLAPSE_LENGTH).join("")}...`
      : message.text;

  if (!isUser) {
    const hasAssistantText = hasText;
    const hasAgentTimeline =
      mobileTimelineEvents(message.timeline).length > 0 ||
      arrayPayload(message.clarifyingQuestions).length > 0;
    const hasRuntimeActivity = !!runtimeActivity?.label;

    return (
      <div className="flex w-full justify-start">
        <div className="w-full px-2 py-2">
          <MobileMessageOutputs
            outputs={message.outputs}
            workspaceSlug={workspaceSlug}
            chatId={message.chatId}
            messageId={message.id}
            onQuizUpdate={onQuizUpdate}
            className={hasAssistantText ? "mb-3 space-y-3" : "space-y-3"}
          />
          {hasAgentTimeline && (
            <MobileAgentTimelineSummary
              timeline={message.timeline}
              clarifyingQuestions={message.clarifyingQuestions}
              className={hasAssistantText ? "mb-3" : "mb-1"}
            />
          )}
          {hasAssistantText && (
            <StreamingMarkdown
              content={message.text}
              isStreaming={isStreamingAssistant}
              className="mobile-experiment-markdown markdown break-words text-[17px] font-normal leading-[1.72] text-slate-900 [&_*]:!text-slate-900 [&_a]:!text-sky-700 [&_code]:rounded-md [&_code]:bg-slate-100 [&_code]:px-1 [&_code]:!text-slate-800 [&_h1]:!text-[22px] [&_h2]:!text-[20px] [&_h3]:!text-[18px] [&_li::marker]:!text-slate-500 [&_strong]:!font-black [&_table]:!text-sm"
            />
          )}
          {hasRuntimeActivity && (
            <MobileAgentActivityText
              key={runtimeActivity.key}
              label={runtimeActivity.label}
              running
              className={[
                hasAssistantText || hasAgentTimeline ? "mt-3" : "",
                runtimeOnly ? "mb-1" : "",
              ]
                .filter(Boolean)
                .join(" ")}
            />
          )}
          {isStreamingAssistant &&
            message.streamConnectionState === "reconnecting" && (
              <p className="mt-2 text-xs font-bold text-slate-500">正在重连…</p>
            )}
          {!runtimeOnly && (
            <>
              <p className="mt-2 text-[10px] font-black uppercase tracking-wide text-slate-400">
                {message.time}
              </p>
              <MobileMessageActionBar
                align="left"
                actions={[
                  {
                    label: speaking ? "停止朗读" : "语音朗读",
                    icon: speaking ? SpeakerSlash : SpeakerHigh,
                    active: speaking,
                    disabled: !hasText,
                    onClick: () => onSpeakMessage?.(message),
                  },
                  {
                    label: copied ? "已复制" : "复制",
                    icon: copied ? Check : Copy,
                    active: copied,
                    disabled: !hasText,
                    onClick: () => onCopyMessage?.(message),
                  },
                  {
                    label: "重新回应",
                    icon: ArrowsClockwise,
                    disabled: busy || !canUseRealActions,
                    onClick: () => onRegenerateMessage?.(message),
                  },
                  {
                    label: "分叉",
                    icon: GitFork,
                    disabled: busy || !canUseRealActions,
                    onClick: () => onForkMessage?.(message),
                  },
                  {
                    label: "删除",
                    icon: Trash,
                    disabled: busy || !canUseRealActions,
                    danger: true,
                    onClick: () => onDeleteMessage?.(message),
                  },
                ]}
              />
            </>
          )}
        </div>
      </div>
    );
  }

  if (editing) {
    return (
      <div className="flex w-full justify-end">
        <div className="mobile-experiment-user-message-frame">
          <GlassCard
            className="liquid-glass-composer-card mobile-experiment-user-message-card overflow-hidden rounded-[24px] rounded-br-[8px]"
            displacementScale={18}
            blurAmount={0.015}
            cornerRadius={24}
            padding="0px"
            shadowMode={false}
            style={{
              "--composer-glass-tint": "rgb(255 255 255 / 0.58)",
              "--composer-glass-shadow": "0 14px 34px rgb(15 23 42 / 0.13)",
              "--composer-glass-focus-shadow":
                "0 14px 34px rgb(15 23 42 / 0.15)",
              borderRadius: "24px 24px 8px 24px",
            }}
          >
            <div className="liquid-glass-composer-content px-3 py-3">
              <textarea
                value={editingText}
                onChange={(event) => onChangeEdit?.(event.target.value)}
                rows={3}
                className="max-h-[160px] min-h-[84px] w-full resize-none rounded-[18px] border border-slate-200/70 bg-white/[.5] px-3 py-2 text-sm font-semibold leading-6 text-slate-900 outline-none focus:border-sky-300"
              />
              <div className="mt-2 flex justify-end gap-1">
                <MobileMessageActionIcon
                  label="取消编辑"
                  icon={X}
                  onClick={onCancelEdit}
                />
                <MobileMessageActionIcon
                  label="保存编辑"
                  icon={Check}
                  active
                  disabled={busy || !editingText.trim()}
                  onClick={() => onSaveEdit?.(message)}
                />
              </div>
            </div>
          </GlassCard>
        </div>
      </div>
    );
  }

  return (
    <div className="flex w-full justify-end">
      <div className="mobile-experiment-user-message-frame">
        <GlassCard
          className={[
            "liquid-glass-composer-card mobile-experiment-user-message-card overflow-hidden rounded-[24px] rounded-br-[8px]",
          ].join(" ")}
          displacementScale={18}
          blurAmount={0.015}
          cornerRadius={24}
          padding="0px"
          shadowMode={false}
          style={{
            "--composer-glass-tint": "rgb(255 255 255 / 0.52)",
            "--composer-glass-shadow": "0 14px 34px rgb(15 23 42 / 0.13)",
            "--composer-glass-focus-shadow": "0 14px 34px rgb(15 23 42 / 0.15)",
            borderRadius: "24px 24px 8px 24px",
          }}
        >
          <div className="liquid-glass-composer-content mobile-experiment-user-message-content px-4 py-3 text-[17px] font-semibold leading-[1.62] text-slate-900">
            <MobileMessageAttachments attachments={message.attachments} />
            <p className="mobile-experiment-user-message-text whitespace-pre-wrap break-words">
              {visibleUserText}
            </p>
            {shouldCollapseUserMessage && (
              <button
                type="button"
                onClick={() => setExpanded((current) => !current)}
                className="mt-2 text-xs font-black text-sky-700"
              >
                {expanded ? "收起" : "点击查看全部"}
              </button>
            )}
            <p className="mt-2 text-[10px] font-black uppercase tracking-wide text-slate-400">
              {message.time}
            </p>
          </div>
        </GlassCard>
        <MobileMessageActionBar
          align="right"
          actions={[
            {
              label: copied ? "已复制" : "复制",
              icon: copied ? Check : Copy,
              active: copied,
              disabled: !hasText,
              onClick: () => onCopyMessage?.(message),
            },
            {
              label: "编辑",
              icon: PencilSimple,
              disabled: busy || !canUseRealActions,
              onClick: () => onStartEdit?.(message),
            },
          ]}
        />
      </div>
    </div>
  );
}

function MobileMessageActionBar({ align = "left", actions = [] }) {
  const alignment = align === "right" ? "justify-end" : "justify-start";

  return (
    <div className={`mt-1 flex items-center gap-1 ${alignment}`}>
      {actions.map((action) => (
        <MobileMessageActionIcon key={action.label} {...action} />
      ))}
    </div>
  );
}

function MobileMessageActionIcon({
  label,
  icon: Icon,
  active = false,
  danger = false,
  disabled = false,
  onClick,
}) {
  const tone = danger
    ? "text-rose-500 hover:bg-rose-50"
    : active
      ? "bg-sky-100 text-sky-600"
      : "text-slate-500 hover:bg-slate-950/[.055] hover:text-slate-800";

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition ${tone} disabled:cursor-not-allowed disabled:bg-transparent disabled:text-slate-300`}
      aria-label={label}
      title={label}
    >
      <Icon size={15} weight={active ? "bold" : "regular"} />
    </button>
  );
}

function MobileMessageOutputs({
  outputs = [],
  workspaceSlug = null,
  chatId,
  messageId,
  onQuizUpdate = null,
  className = "mt-3 space-y-3",
}) {
  const quizOutputs = useMemo(
    () => arrayPayload(outputs).filter((output) => output?.type === "QuizCard"),
    [outputs]
  );
  const workspace = useMemo(
    () => (workspaceSlug ? { slug: workspaceSlug } : null),
    [workspaceSlug]
  );

  if (!workspace || quizOutputs.length === 0) return null;

  return (
    <div className={className}>
      {quizOutputs.map((output, index) => (
        <QuizCard
          key={`${output.type}-${output.payload?.id || chatId || index}`}
          quiz={output.payload}
          workspace={workspace}
          onQuizUpdate={(nextQuiz, finalContent) =>
            onQuizUpdate?.(messageId, nextQuiz, finalContent)
          }
        />
      ))}
    </div>
  );
}

const MOBILE_COMPOSER_TEXTAREA_MIN_HEIGHT = 44;
const MOBILE_COMPOSER_TEXTAREA_MAX_HEIGHT = 88;

function MobileAttachmentRuntimeBridge({
  onFilesChange,
  onProcessingChange,
  parseAttachmentsRef,
}) {
  const { files = [], parseAttachments = () => [] } =
    useContext(DndUploaderContext);
  const previousFileCountRef = useRef(0);

  useEffect(() => {
    onFilesChange?.(files);
    if (files.length > previousFileCountRef.current) {
      mobileChatDebug("attachment:provider-queued", {
        count: files.length,
        addedCount: files.length - previousFileCountRef.current,
        items: files.map((file) => ({
          name: file.file?.name || null,
          type: file.file?.type || null,
          status: file.status || null,
          attachmentType: file.type || null,
          hasPreviewUrl: !!file.previewUrl,
          hasContentString: !!file.contentString,
        })),
      });
    } else if (files.length < previousFileCountRef.current) {
      mobileChatDebug("attachment:provider-count-decreased", {
        count: files.length,
        previousCount: previousFileCountRef.current,
      });
    } else if (files.length) {
      mobileChatDebug("attachment:provider-files-updated", {
        count: files.length,
        items: files.map((file) => ({
          name: file.file?.name || null,
          type: file.file?.type || null,
          status: file.status || null,
          attachmentType: file.type || null,
          hasPreviewUrl: !!file.previewUrl,
          hasContentString: !!file.contentString,
        })),
      });
    }
    previousFileCountRef.current = files.length;
  }, [files, onFilesChange]);

  useEffect(() => {
    parseAttachmentsRef.current = parseAttachments;
  }, [parseAttachments, parseAttachmentsRef]);

  useEffect(() => {
    return () => {
      mobileChatDebug("attachment:bridge-unmount-cleared");
      parseAttachmentsRef.current = () => [];
      onFilesChange?.([]);
      onProcessingChange?.(false);
    };
  }, [onFilesChange, onProcessingChange, parseAttachmentsRef]);

  useEffect(() => {
    function onProcessing() {
      mobileChatDebug("attachment:runtime-processing");
      onProcessingChange?.(true);
    }

    function onProcessed() {
      mobileChatDebug("attachment:runtime-processed");
      onProcessingChange?.(false);
    }

    window.addEventListener(ATTACHMENTS_PROCESSING_EVENT, onProcessing);
    window.addEventListener(ATTACHMENTS_PROCESSED_EVENT, onProcessed);
    return () => {
      window.removeEventListener(ATTACHMENTS_PROCESSING_EVENT, onProcessing);
      window.removeEventListener(ATTACHMENTS_PROCESSED_EVENT, onProcessed);
      onProcessingChange?.(false);
    };
  }, [onProcessingChange]);

  return null;
}

function MobileAttachmentFileInputs({
  cameraInputRef,
  photoInputRef,
  fileInputRef,
  onFilesSelected,
}) {
  const stableInputClass = "absolute -left-[9999px] top-0 h-px w-px opacity-0";

  useEffect(() => {
    mobileChatDebug("attachment:stable-inputs-mounted", {
      hasCameraInput: !!cameraInputRef.current,
      hasPhotoInput: !!photoInputRef.current,
      hasFileInput: !!fileInputRef.current,
    });
  }, [cameraInputRef, fileInputRef, photoInputRef]);

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        tabIndex={-1}
        className={stableInputClass}
        onChange={(event) => onFilesSelected?.(event, "camera")}
      />
      <input
        ref={photoInputRef}
        type="file"
        accept="image/*"
        multiple
        tabIndex={-1}
        className={stableInputClass}
        onChange={(event) => onFilesSelected?.(event, "photos")}
      />
      <input
        ref={fileInputRef}
        type="file"
        multiple
        tabIndex={-1}
        className={stableInputClass}
        onChange={(event) => onFilesSelected?.(event, "files")}
      />
    </div>
  );
}

function mobileAttachmentStatusLabel(attachment = {}) {
  if (attachment.status === "in_progress") return "处理中";
  if (attachment.status === "failed") return attachment.error || "处理失败";
  if (attachment.status === "embedded") return "已嵌入";
  if (attachment.status === "added_context") return "已作为上下文";
  if (attachment.type === "attachment") return "随消息发送";
  return "已就绪";
}

function MobileAttachmentPreview({ attachments = [], disabled = false }) {
  const debugSignatureRef = useRef(null);

  useEffect(() => {
    const signature = mobileAttachmentDebugSignature(attachments, {
      disabled,
    });
    if (debugSignatureRef.current === signature) return;
    debugSignatureRef.current = signature;
    mobileChatDebug("attachment:preview-props", {
      count: attachments.length,
      disabled,
      items: mobileAttachmentDebugItems(attachments),
    });
  }, [attachments, disabled]);

  if (!attachments.length) return null;

  const imageAttachments = attachments
    .filter((attachment) => attachment.type === "attachment")
    .filter((attachment) => attachment.contentString)
    .map((attachment) => ({
      contentString: attachment.contentString,
      name: attachment.file?.name || "image",
    }));

  function removeAttachment(attachment) {
    window.dispatchEvent(
      new CustomEvent(REMOVE_ATTACHMENT_EVENT, {
        detail: {
          uid: attachment.uid,
          document: attachment.document,
        },
      })
    );
  }

  function openAttachmentImage(attachment) {
    const imageIndex = imageAttachments.findIndex(
      (image) => image.name === attachment.file?.name
    );
    if (imageIndex >= 0) openImageLightbox(imageAttachments, imageIndex);
  }

  return (
    <div className="no-scroll mb-2 flex gap-2 overflow-x-auto px-1 pb-1.5 pt-0.5">
      {attachments.map((attachment) => {
        const isImage = attachment.type === "attachment";
        const previewSrc = attachment.contentString || attachment.previewUrl;
        const failed = attachment.status === "failed";
        if (isImage) {
          return (
            <div
              key={attachment.uid}
              className="relative h-[84px] w-[84px] shrink-0 overflow-visible"
            >
              <button
                type="button"
                disabled={!attachment.contentString}
                onClick={() => openAttachmentImage(attachment)}
                className={`h-[84px] w-[84px] overflow-hidden rounded-[18px] border border-white/80 bg-slate-100 shadow-[0_10px_28px_rgba(15,23,42,0.12)] ${
                  attachment.contentString ? "cursor-pointer" : "cursor-default"
                }`}
                aria-label={
                  attachment.contentString ? "查看图片附件" : "图片附件处理中"
                }
              >
                {previewSrc ? (
                  <img
                    src={previewSrc}
                    alt={attachment.file?.name || "附件图片"}
                    className={`h-full w-full object-cover ${
                      failed ? "opacity-60" : ""
                    }`}
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-slate-400">
                    <ImageSquare size={24} weight="bold" />
                  </div>
                )}
              </button>
              {attachment.status === "in_progress" && (
                <div className="absolute inset-0 flex items-center justify-center rounded-[18px] bg-white/45 backdrop-blur-[1px]">
                  <CircleNotch
                    size={22}
                    className="animate-spin text-slate-700"
                    weight="bold"
                  />
                </div>
              )}
              {failed && (
                <div className="absolute inset-x-1 bottom-1 rounded-full bg-rose-500/90 px-2 py-0.5 text-center text-[9px] font-black text-white">
                  处理失败
                </div>
              )}
              <button
                type="button"
                disabled={disabled}
                onClick={() => removeAttachment(attachment)}
                className="absolute -right-2 -top-2 flex h-7 w-7 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-950 shadow-[0_6px_18px_rgba(15,23,42,0.18)] disabled:opacity-50"
                aria-label="移除图片附件"
              >
                <X size={14} weight="bold" />
              </button>
            </div>
          );
        }

        return (
          <div
            key={attachment.uid}
            className={`relative flex min-w-[142px] max-w-[180px] shrink-0 items-center gap-2 rounded-[18px] border px-2 py-2 text-left shadow-[0_8px_22px_rgba(15,23,42,0.06)] ${
              failed
                ? "border-rose-200 bg-rose-50 text-rose-700"
                : "border-slate-200/80 bg-white/70 text-slate-700"
            }`}
          >
            <button
              type="button"
              disabled
              className={`flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-[14px] ${
                failed ? "bg-rose-100" : "bg-slate-100"
              }`}
              aria-label="附件"
            >
              {attachment.status === "in_progress" ? (
                <CircleNotch size={18} className="animate-spin" />
              ) : (
                <FileIcon size={18} weight="bold" />
              )}
            </button>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-black">
                {attachment.file?.name || "附件"}
              </p>
              <p className="mt-0.5 truncate text-[10px] font-semibold opacity-70">
                {mobileAttachmentStatusLabel(attachment)}
              </p>
            </div>
            <button
              type="button"
              disabled={disabled}
              onClick={() => removeAttachment(attachment)}
              className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-white text-slate-500 shadow-[0_4px_12px_rgba(15,23,42,0.16)] disabled:opacity-50"
              aria-label="移除附件"
            >
              <X size={11} weight="bold" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function MobileComposer({
  value,
  recording,
  quizMode,
  attachments = [],
  attachmentsProcessing = false,
  enableAttachments = true,
  disabled,
  disabledReason,
  workspaceSlug,
  threadSlug,
  memoryScopeKey,
  memoryStatus,
  memoryLoading,
  memoryUnavailable,
  onChange,
  onKeyDown,
  attachmentButtonRef,
  onAttach,
  onToggleQuizMode,
  onToggleRecording,
  onSend,
  showExperimentalActions = true,
  editMode = false,
  onCancelEdit = null,
  onHeightChange = null,
}) {
  const inputPlaceholder =
    disabledReason === "overview"
      ? "总览页不可发送消息"
      : disabledReason === "loading"
        ? "正在加载..."
        : attachmentsProcessing
          ? "附件处理中..."
          : disabledReason === "streaming"
            ? "正在回复中..."
            : recording
              ? "正在录音..."
              : "发送消息";
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const composerFrameRef = useRef(null);
  const composerRef = useRef(null);
  const inputAreaRef = useRef(null);
  const textareaRef = useRef(null);
  const internalPointerDownRef = useRef(false);
  const sendPointerHandledRef = useRef(false);
  const attachmentPointerHandledRef = useRef(false);
  const composerAttachmentDebugSignatureRef = useRef(null);
  const hasSendableAttachment = attachments.some(
    (attachment) =>
      attachment.type === "attachment" &&
      !!attachment.contentString &&
      attachment.status !== "failed"
  );
  const canSubmit =
    !disabled &&
    !attachmentsProcessing &&
    (hasSendableAttachment || !!value.trim());
  const toolbarVisible = toolsExpanded || attachments.length > 0;

  useEffect(() => {
    const signature = mobileAttachmentDebugSignature(attachments, {
      attachmentsProcessing,
      disabled: !!disabled,
      disabledReason: disabledReason || null,
      hasSendableAttachment,
      canSubmit,
    });
    if (composerAttachmentDebugSignatureRef.current === signature) return;
    composerAttachmentDebugSignatureRef.current = signature;
    mobileChatDebug("attachment:composer-props", {
      count: attachments.length,
      attachmentsProcessing,
      disabled: !!disabled,
      disabledReason: disabledReason || null,
      hasSendableAttachment,
      canSubmit,
      items: mobileAttachmentDebugItems(attachments),
    });
  }, [
    attachments,
    attachmentsProcessing,
    canSubmit,
    disabled,
    disabledReason,
    hasSendableAttachment,
  ]);

  const syncTextareaHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.style.height = `${MOBILE_COMPOSER_TEXTAREA_MIN_HEIGHT}px`;
    const contentHeight = textarea.scrollHeight;
    const nextHeight = Math.min(
      Math.max(contentHeight, MOBILE_COMPOSER_TEXTAREA_MIN_HEIGHT),
      MOBILE_COMPOSER_TEXTAREA_MAX_HEIGHT
    );

    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY =
      contentHeight > MOBILE_COMPOSER_TEXTAREA_MAX_HEIGHT ? "auto" : "hidden";
  }, []);

  const focusTextarea = useCallback(() => {
    if (disabled) return;
    try {
      textareaRef.current?.focus({ preventScroll: true });
    } catch {
      textareaRef.current?.focus();
    }
  }, [disabled]);

  useLayoutEffect(() => {
    syncTextareaHeight();
  }, [syncTextareaHeight, value]);

  useLayoutEffect(() => {
    const composerFrame = composerFrameRef.current;
    if (!composerFrame || typeof onHeightChange !== "function") return;

    let animationFrameId = null;
    const measure = () => {
      if (animationFrameId !== null) {
        window.cancelAnimationFrame(animationFrameId);
      }
      animationFrameId = window.requestAnimationFrame(() => {
        animationFrameId = null;
        onHeightChange(composerFrame.getBoundingClientRect().height);
      });
    };

    measure();
    const resizeObserver =
      typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    resizeObserver?.observe(composerFrame);
    window.addEventListener("resize", measure);

    return () => {
      if (animationFrameId !== null) {
        window.cancelAnimationFrame(animationFrameId);
      }
      resizeObserver?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [onHeightChange]);

  function handleComposerPointerDown(event) {
    internalPointerDownRef.current = true;
    setToolsExpanded(true);
    const target = event.target;
    if (target instanceof Node && inputAreaRef.current?.contains(target)) {
      focusTextarea();
      window.requestAnimationFrame(syncTextareaHeight);
    }
  }

  function handleComposerBlur(event) {
    const nextTarget = event.relatedTarget;
    if (nextTarget && composerRef.current?.contains(nextTarget)) return;
    if (internalPointerDownRef.current) {
      window.requestAnimationFrame(() => {
        internalPointerDownRef.current = false;
        if (composerRef.current?.contains(document.activeElement)) return;
        setToolsExpanded(false);
      });
      return;
    }
    setToolsExpanded(false);
  }

  function requestSend() {
    if (!canSubmit) {
      mobileChatDebug("send:request-blocked", sendActionDebugPayload());
      return;
    }
    mobileChatDebug("send:request-dispatched", sendActionDebugPayload());
    try {
      const result = onSend?.();
      if (result && typeof result.catch === "function") {
        result.catch((error) => {
          mobileChatDebug("send:on-send-error", {
            message: error?.message || String(error),
            stack: error?.stack || null,
            ...sendActionDebugPayload(),
          });
        });
      }
    } catch (error) {
      mobileChatDebug("send:on-send-error", {
        message: error?.message || String(error),
        stack: error?.stack || null,
        ...sendActionDebugPayload(),
      });
    }
  }

  function handleSendPointerDown(event) {
    mobileChatDebug("send:action-pointer", sendActionDebugPayload());
    if (!canSubmit) return;
    event.preventDefault();
    sendPointerHandledRef.current = true;
    requestSend();
    window.setTimeout(() => {
      sendPointerHandledRef.current = false;
    }, 350);
  }

  function handleSendClick(event) {
    if (sendPointerHandledRef.current) {
      event.preventDefault();
      mobileChatDebug("send:action-click-deduped", sendActionDebugPayload());
      return;
    }
    mobileChatDebug("send:action-click", sendActionDebugPayload());
    requestSend();
  }

  function sendActionDebugPayload() {
    return {
      canSubmit,
      disabled: !!disabled,
      disabledReason: disabledReason || null,
      attachmentCount: attachments.length,
      processedAttachmentCount: attachments.filter(
        (attachment) =>
          attachment.type === "attachment" &&
          !!attachment.contentString &&
          attachment.status !== "failed"
      ).length,
      hasSendableAttachment,
      attachmentsProcessing,
      valueLength: value.trim().length,
      toolsExpanded,
      toolbarVisible,
      items: mobileAttachmentDebugItems(attachments),
    };
  }

  function keepComposerFocused(event) {
    if (disabled) return;
    event.preventDefault();
    internalPointerDownRef.current = true;
    setToolsExpanded(true);
    focusTextarea();
  }

  function openAttachmentSheetFromPointer(event) {
    if (disabled) return;
    event.preventDefault();
    internalPointerDownRef.current = true;
    attachmentPointerHandledRef.current = true;
    setToolsExpanded(true);
    focusTextarea();
    mobileChatDebug("attachment:action-pointer", {
      disabled: !!disabled,
      expanded: true,
    });
    onAttach?.();
    window.setTimeout(() => {
      attachmentPointerHandledRef.current = false;
    }, 350);
  }

  function openAttachmentSheetFromClick(event) {
    if (attachmentPointerHandledRef.current) {
      event.preventDefault();
      mobileChatDebug("attachment:action-click-deduped");
      return;
    }
    mobileChatDebug("attachment:action-click", {
      disabled: !!disabled,
    });
    onAttach?.();
  }

  return (
    <div
      ref={composerFrameRef}
      data-mobile-composer-frame="true"
      className="pointer-events-none absolute left-0 right-0 z-20 px-4 pb-4 pt-2 transition-[bottom] duration-150 ease-out"
      style={{
        bottom: "var(--mobile-keyboard-inset, 0px)",
      }}
    >
      <GlassCard
        className="liquid-glass-composer-card pointer-events-auto overflow-hidden rounded-[28px]"
        displacementScale={18}
        blurAmount={0.015}
        cornerRadius={28}
        padding="0px"
        shadowMode={false}
        style={{
          "--composer-glass-tint": "rgb(255 255 255 / 0.42)",
          "--composer-glass-shadow": "0 18px 44px rgb(15 23 42 / 0.16)",
          "--composer-glass-focus-shadow": "0 18px 48px rgb(14 165 233 / 0.20)",
          borderRadius: "28px",
        }}
      >
        <div
          ref={composerRef}
          className="liquid-glass-composer-content px-2 py-2"
          onFocus={() => setToolsExpanded(true)}
          onBlur={handleComposerBlur}
          onPointerDownCapture={handleComposerPointerDown}
        >
          {editMode && (
            <div className="mx-1 mb-1 flex items-center justify-between rounded-2xl border border-white/50 px-3 py-2 text-sm font-semibold text-slate-700">
              <span className="flex items-center gap-2">
                <PencilSimple size={17} />
                编辑消息
              </span>
              <button
                type="button"
                onClick={onCancelEdit}
                className="flex h-7 w-7 items-center justify-center rounded-full text-slate-600 transition hover:bg-white/50"
                aria-label="取消编辑"
              >
                <X size={16} />
              </button>
            </div>
          )}
          <MobileAttachmentPreview
            attachments={attachments}
            disabled={disabled && disabledReason !== "attachments"}
          />
          <div ref={inputAreaRef} className="flex min-h-[48px] items-end gap-2">
            <textarea
              ref={textareaRef}
              value={value}
              onChange={(event) => {
                onChange(event.target.value);
                window.requestAnimationFrame(syncTextareaHeight);
              }}
              onFocus={() => {
                setToolsExpanded(true);
                syncTextareaHeight();
              }}
              onKeyDown={onKeyDown}
              disabled={disabled}
              rows={1}
              placeholder={inputPlaceholder}
              className="min-h-[44px] flex-1 resize-none border-none bg-transparent px-3 py-3 text-base font-semibold leading-6 text-slate-900 outline-none placeholder:text-slate-500 disabled:cursor-not-allowed disabled:text-slate-400 disabled:placeholder:text-slate-400"
              style={{ height: `${MOBILE_COMPOSER_TEXTAREA_MIN_HEIGHT}px` }}
            />
          </div>
          <div
            className={`mobile-composer-toolbar flex items-center justify-between gap-2 overflow-hidden border-t px-1 transition-[max-height,opacity,margin,padding,border-color] duration-200 ease-out ${
              toolbarVisible
                ? "mt-1 max-h-14 border-white/[.46] pb-0.5 pt-1.5 opacity-100"
                : "pointer-events-none mt-0 max-h-0 border-transparent py-0 opacity-0"
            }`}
            aria-hidden={!toolbarVisible}
          >
            <div className="no-scroll flex min-w-0 flex-1 items-center gap-1 overflow-x-auto pr-1">
              {enableAttachments && (
                <MobileComposerActionButton
                  label="添加附件"
                  disabled={disabled}
                  actionRef={attachmentButtonRef}
                  onPointerDown={openAttachmentSheetFromPointer}
                  onClick={openAttachmentSheetFromClick}
                >
                  <Paperclip size={18} weight="bold" />
                </MobileComposerActionButton>
              )}
              <MobileComposerActionButton
                label="测试题模式"
                active={quizMode}
                disabled={disabled}
                onPointerDown={keepComposerFocused}
                onClick={onToggleQuizMode}
              >
                <Question size={18} weight="bold" />
              </MobileComposerActionButton>
              <MobileFileAccessModeButton
                workspaceSlug={workspaceSlug}
                threadSlug={threadSlug}
                disabled={disabled}
                onPreserveComposerFocus={keepComposerFocused}
              />
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <MobileMemoryUsageButton
                scopeKey={memoryScopeKey}
                status={memoryStatus}
                loading={memoryLoading}
                unavailable={memoryUnavailable || disabledReason === "overview"}
                disabled={disabled}
                onPreserveComposerFocus={keepComposerFocused}
              />
              {showExperimentalActions && (
                <MobileComposerActionButton
                  label="切换语音输入"
                  active={recording}
                  activeClassName="bg-rose-400 text-white shadow-[0_10px_22px_rgba(251,113,133,0.26)]"
                  disabled={disabled}
                  onPointerDown={keepComposerFocused}
                  onClick={onToggleRecording}
                >
                  <Microphone size={18} weight="bold" />
                </MobileComposerActionButton>
              )}
              <MobileComposerActionButton
                label="发送真实消息"
                active={canSubmit}
                disabled={!canSubmit}
                onPointerDown={handleSendPointerDown}
                onClick={handleSendClick}
              >
                <ArrowUp size={18} weight="bold" />
              </MobileComposerActionButton>
            </div>
          </div>
        </div>
        {showExperimentalActions && recording && (
          <div className="mx-2 mb-2 rounded-full bg-rose-100 px-3 py-2 text-xs font-bold text-rose-600">
            语音输入状态仅为原型模拟，再次点击麦克风停止。
          </div>
        )}
      </GlassCard>
    </div>
  );
}

function MobileFileAccessModeButton({
  workspaceSlug = null,
  threadSlug = null,
  disabled = false,
  onPreserveComposerFocus = null,
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState(FileAccessPolicy.modes.sandbox);
  const [defaultMode, setDefaultMode] = useState(
    FileAccessPolicy.modes.sandbox
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const [openConfirmOpen, setOpenConfirmOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState({
    position: "fixed",
    width: "208px",
    left: "0px",
    top: "0px",
    zIndex: 9999,
    visibility: "hidden",
  });
  const [confirmFrameStyle, setConfirmFrameStyle] = useState({
    position: "fixed",
    left: "0px",
    top: "0px",
    width: "0px",
    height: "0px",
    zIndex: 10000,
    visibility: "hidden",
  });
  const buttonRef = useRef(null);
  const menuRef = useRef(null);
  const scopeKey = `${workspaceSlug || "global"}:${threadSlug || "default"}`;
  const disabledButton = disabled || !workspaceSlug || !threadSlug;
  const menuPresence = useAnimatedPresence(menuOpen && !disabledButton, 140);
  const confirmPresence = useAnimatedPresence(
    openConfirmOpen && !disabledButton,
    170
  );

  const config = {
    sandbox: {
      label: t("chat_window.controls.fileAccess.modes.sandbox.label"),
      tooltip: t("chat_window.controls.fileAccess.modes.sandbox.description"),
      iconClass: "text-slate-600",
    },
    authorized: {
      label: t("chat_window.controls.fileAccess.modes.authorized.label"),
      tooltip: t(
        "chat_window.controls.fileAccess.modes.authorized.description"
      ),
      iconClass: "text-sky-600",
    },
    open: {
      label: t("chat_window.controls.fileAccess.modes.open.label"),
      tooltip: t("chat_window.controls.fileAccess.modes.open.description"),
      iconClass: "text-rose-600",
    },
  };
  const current = config[mode] || config.sandbox;

  useEffect(() => {
    let mounted = true;
    const sessionMode = FileAccessPolicy.getSessionMode(
      workspaceSlug,
      threadSlug
    );

    FileAccessPolicy.getPolicy(sessionMode).then((res) => {
      if (!mounted) return;
      const nextMode = FileAccessPolicy.normalizeMode(
        sessionMode ||
          res?.policy?.effectiveMode ||
          res?.policy?.defaultMode ||
          FileAccessPolicy.modes.sandbox
      );
      setMode(nextMode);
      setDefaultMode(
        FileAccessPolicy.normalizeMode(
          res?.policy?.defaultMode || FileAccessPolicy.modes.sandbox
        )
      );
      if (!sessionMode && workspaceSlug && threadSlug) {
        FileAccessPolicy.setSessionMode(nextMode, workspaceSlug, threadSlug);
      }
    });

    return () => {
      mounted = false;
    };
  }, [scopeKey, workspaceSlug, threadSlug]);

  useEffect(() => {
    setMenuOpen(false);
    setOpenConfirmOpen(false);
  }, [disabledButton, scopeKey]);

  useEffect(() => {
    if (!menuOpen) return;

    positionMenu();

    function onPointerDown(event) {
      if (buttonRef.current?.contains(event.target)) return;
      if (menuRef.current?.contains(event.target)) return;
      setMenuOpen(false);
    }

    function onKeyDown(event) {
      if (event.key === "Escape") setMenuOpen(false);
    }

    window.addEventListener("resize", positionMenu);
    window.addEventListener("scroll", positionMenu, true);
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("resize", positionMenu);
      window.removeEventListener("scroll", positionMenu, true);
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!openConfirmOpen) return;

    positionConfirmFrame();

    function onKeyDown(event) {
      if (event.key === "Escape") setOpenConfirmOpen(false);
    }

    window.addEventListener("resize", positionConfirmFrame);
    window.addEventListener("scroll", positionConfirmFrame, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("resize", positionConfirmFrame);
      window.removeEventListener("scroll", positionConfirmFrame, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [openConfirmOpen]);

  function positionMenu() {
    if (typeof window === "undefined") return;
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;

    const width = 208;
    const gap = 10;
    const estimatedHeight = menuRef.current?.offsetHeight || 156;
    const left = Math.min(
      Math.max(8, rect.left),
      window.innerWidth - width - 8
    );
    const top = Math.max(8, rect.top - estimatedHeight - gap);

    setMenuStyle({
      position: "fixed",
      width: `${width}px`,
      left: `${left}px`,
      top: `${top}px`,
      zIndex: 9999,
      visibility: "visible",
    });
  }

  function positionConfirmFrame() {
    if (typeof window === "undefined") return;
    const screen = buttonRef.current?.closest(
      ".mobile-experiment-device-screen"
    );
    const rect = screen?.getBoundingClientRect();
    if (!rect) return;

    setConfirmFrameStyle({
      position: "fixed",
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      zIndex: 10000,
      visibility: "visible",
    });
  }

  async function commitMode(nextMode) {
    const normalized = FileAccessPolicy.normalizeMode(nextMode);
    if (disabledButton) return;

    const storedMode = FileAccessPolicy.setSessionMode(
      normalized,
      workspaceSlug,
      threadSlug
    );
    setMode(storedMode);
    setMenuOpen(false);
    setOpenConfirmOpen(false);
    await FileAccessPolicy.logSessionModeChange({
      mode: storedMode,
      workspaceSlug,
      threadSlug,
    });
  }

  function selectMode(nextMode) {
    const normalized = FileAccessPolicy.normalizeMode(nextMode);
    if (
      normalized === FileAccessPolicy.modes.open &&
      mode !== FileAccessPolicy.modes.open
    ) {
      setMenuOpen(false);
      setOpenConfirmOpen(true);
      if (typeof window !== "undefined") {
        window.requestAnimationFrame(positionConfirmFrame);
      }
      return;
    }

    commitMode(normalized);
  }

  return (
    <div className="relative shrink-0">
      <MobileComposerActionButton
        label={`${t("chat_window.controls.fileAccess.label")}: ${current.label}`}
        disabled={disabledButton}
        onPointerDown={onPreserveComposerFocus}
        onClick={() => {
          if (disabledButton) return;
          setMenuOpen((currentOpen) => {
            const next = !currentOpen;
            if (next && typeof window !== "undefined") {
              window.requestAnimationFrame(positionMenu);
            }
            return next;
          });
        }}
      >
        <span
          ref={buttonRef}
          className={`flex h-9 w-9 items-center justify-center ${
            disabledButton ? "text-slate-400" : current.iconClass
          }`}
        >
          <Shield size={18} weight="bold" className="text-current" />
        </span>
      </MobileComposerActionButton>

      {menuPresence.shouldRender &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={menuRef}
            style={menuStyle}
            className={`mobile-popover-animated mobile-popover-origin-bottom-left pointer-events-auto overflow-hidden rounded-[22px] border border-white/[.72] bg-white/[.86] p-1.5 text-slate-900 shadow-[0_18px_46px_rgba(15,23,42,0.18)] backdrop-blur-2xl ${
              menuPresence.isVisible
                ? "mobile-popover-animated-enter"
                : "mobile-popover-animated-exit"
            }`}
          >
            {MOBILE_FILE_ACCESS_MODES.map((option) => {
              const optionConfig = config[option] || config.sandbox;
              const active = option === mode;

              return (
                <button
                  key={option}
                  type="button"
                  onClick={() => selectMode(option)}
                  className="flex w-full items-center gap-2 rounded-[16px] px-3 py-2.5 text-left text-slate-700 transition hover:bg-slate-950/[.045]"
                  title={optionConfig.tooltip}
                >
                  <span
                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
                      active ? "bg-slate-950/[.045]" : "bg-transparent"
                    } ${optionConfig.iconClass}`}
                  >
                    <Shield
                      size={16}
                      weight={active ? "fill" : "bold"}
                      className="text-current"
                    />
                  </span>
                  <span className="min-w-0 flex-1 text-xs font-black">
                    {optionConfig.label}
                  </span>
                  {option === defaultMode && (
                    <span className="shrink-0 rounded-full bg-slate-950/[.055] px-2 py-0.5 text-[10px] font-bold text-slate-500">
                      {t("chat_window.controls.fileAccess.globalDefault")}
                    </span>
                  )}
                </button>
              );
            })}
          </div>,
          document.body
        )}

      {confirmPresence.shouldRender &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            style={confirmFrameStyle}
            className="pointer-events-auto overflow-hidden rounded-[38px]"
          >
            <div
              className={`mobile-scrim-animated absolute inset-0 bg-slate-950/[.18] backdrop-blur-[2px] ${
                confirmPresence.isVisible
                  ? "mobile-scrim-enter"
                  : "mobile-scrim-exit"
              }`}
              onClick={() => setOpenConfirmOpen(false)}
            />
            <div
              className={`mobile-popover-animated mobile-popover-origin-bottom absolute inset-x-4 bottom-[96px] overflow-hidden rounded-[28px] border border-white/[.72] bg-white/[.9] p-4 text-slate-900 shadow-[0_22px_58px_rgba(15,23,42,0.22)] backdrop-blur-2xl ${
                confirmPresence.isVisible
                  ? "mobile-popover-animated-enter"
                  : "mobile-popover-animated-exit"
              }`}
            >
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-rose-100 text-rose-600">
                  <Shield size={20} weight="fill" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-black leading-5 text-slate-950">
                    {t("chat_window.controls.fileAccess.openConfirm.title")}
                  </p>
                  <p className="mt-1 text-[12px] font-semibold leading-5 text-slate-600">
                    {t(
                      "chat_window.controls.fileAccess.openConfirm.description"
                    )}
                  </p>
                </div>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setOpenConfirmOpen(false)}
                  className="rounded-full bg-slate-950/[.055] px-3 py-2.5 text-xs font-black text-slate-600 transition hover:bg-slate-950/[.09]"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => commitMode(FileAccessPolicy.modes.open)}
                  className="rounded-full bg-rose-500 px-3 py-2.5 text-xs font-black text-white shadow-[0_12px_26px_rgba(244,63,94,0.24)] transition hover:bg-rose-600"
                >
                  {t("chat_window.controls.fileAccess.openConfirm.confirm")}
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}

function MobileMemoryUsageButton({
  scopeKey = null,
  status = null,
  loading = false,
  unavailable = false,
  disabled = false,
  onPreserveComposerFocus = null,
}) {
  const [open, setOpen] = useState(false);
  const [popoverStyle, setPopoverStyle] = useState({
    position: "fixed",
    width: "220px",
    left: "0px",
    top: "0px",
    zIndex: 9999,
    visibility: "hidden",
  });
  const buttonRef = useRef(null);
  const popoverRef = useRef(null);
  const usedTokens = Number(status?.usedTokens || 0);
  const limitTokens = Number(status?.limitTokens || 0);
  const safeRatio = clampRatio(status?.ratio);
  const compactableMessageCount = Number(status?.compactableMessageCount || 0);
  const targetCompactableMessageCount = Number(
    status?.targetCompactableMessageCount ?? compactableMessageCount
  );
  const hasLimit = limitTokens > 0;
  const disabledButton = disabled || unavailable;
  const ringDegrees =
    unavailable || !hasLimit ? 0 : Math.round(safeRatio * 360);
  const ringTone =
    unavailable || !hasLimit
      ? "rgba(148,163,184,0.58)"
      : safeRatio >= 0.9
        ? "rgb(248 113 113)"
        : safeRatio >= 0.72
          ? "rgb(251 191 36)"
          : "rgb(56 189 248)";
  const ringTrack = unavailable
    ? "rgba(148,163,184,0.22)"
    : "rgba(113,113,122,0.35)";
  const percentLabel = hasLimit ? `${Math.round(safeRatio * 100)}%` : "--";
  const popoverPresence = useAnimatedPresence(open && !disabledButton, 140);

  useEffect(() => {
    setOpen(false);
  }, [disabledButton, scopeKey]);

  useEffect(() => {
    if (!open) return;

    positionPopover();

    function onPointerDown(event) {
      if (buttonRef.current?.contains(event.target)) return;
      if (popoverRef.current?.contains(event.target)) return;
      setOpen(false);
    }

    function onKeyDown(event) {
      if (event.key === "Escape") setOpen(false);
    }

    window.addEventListener("resize", positionPopover);
    window.addEventListener("scroll", positionPopover, true);
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("resize", positionPopover);
      window.removeEventListener("scroll", positionPopover, true);
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function positionPopover() {
    if (typeof window === "undefined") return;
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;

    const width = 220;
    const gap = 10;
    const estimatedHeight = popoverRef.current?.offsetHeight || 136;
    const left = Math.min(
      Math.max(8, rect.right - width),
      window.innerWidth - width - 8
    );
    const top = Math.max(8, rect.top - estimatedHeight - gap);

    setPopoverStyle({
      position: "fixed",
      width: `${width}px`,
      left: `${left}px`,
      top: `${top}px`,
      zIndex: 9999,
      visibility: "visible",
    });
  }

  function toggleOpen() {
    if (disabledButton) return;
    setOpen((current) => {
      const next = !current;
      if (next && typeof window !== "undefined") {
        window.requestAnimationFrame(positionPopover);
      }
      return next;
    });
  }

  return (
    <div className="relative shrink-0">
      <button
        ref={buttonRef}
        type="button"
        disabled={disabledButton}
        onPointerDown={onPreserveComposerFocus}
        onClick={toggleOpen}
        className="group relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition hover:bg-slate-950/[.055] disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
        style={{
          backgroundImage: `conic-gradient(${ringTone} ${ringDegrees}deg, ${ringTrack} 0deg)`,
        }}
        aria-label={
          unavailable
            ? "总览页暂无线程记忆占比"
            : `线程记忆占用 ${percentLabel}`
        }
        title={unavailable ? "总览页暂无线程记忆占比" : "线程记忆占用"}
      >
        <span className="flex h-[29px] w-[29px] items-center justify-center rounded-full bg-white/[.78] text-slate-600 shadow-[inset_0_1px_0_rgba(255,255,255,.62)] backdrop-blur-xl group-hover:text-slate-800">
          {loading ? (
            <CircleNotch size={16} className="animate-spin text-slate-500" />
          ) : hasLimit && !unavailable ? (
            <ClockCounterClockwise size={16} weight="bold" />
          ) : (
            <span className="text-[10px] font-black leading-none">--</span>
          )}
        </span>
      </button>

      {popoverPresence.shouldRender &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={popoverRef}
            style={popoverStyle}
            className={`mobile-popover-animated mobile-popover-origin-bottom-right pointer-events-auto rounded-[22px] border border-white/[.72] bg-white/[.84] p-3 text-slate-900 shadow-[0_18px_46px_rgba(15,23,42,0.18)] backdrop-blur-2xl ${
              popoverPresence.isVisible
                ? "mobile-popover-animated-enter"
                : "mobile-popover-animated-exit"
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="m-0 text-sm font-black">线程记忆占用</p>
                <p className="m-0 mt-0.5 text-[11px] font-semibold text-slate-500">
                  当前 thread
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className="m-0 text-sm font-black text-sky-600">
                  {percentLabel}
                </p>
                <p className="m-0 text-[10px] font-bold text-slate-400">
                  memory
                </p>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
              <MobileMemoryStat label="已用" value={nFormatter(usedTokens)} />
              <MobileMemoryStat
                label="上限"
                value={hasLimit ? nFormatter(limitTokens) : "--"}
              />
            </div>
            <div className="mt-2 flex items-center justify-between rounded-2xl bg-slate-950/[.045] px-3 py-2 text-xs font-bold text-slate-600">
              <span>可压缩消息</span>
              <span>{targetCompactableMessageCount}</span>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}

function MobileMemoryStat({ label, value }) {
  return (
    <div className="rounded-2xl bg-slate-950/[.045] px-3 py-2">
      <p className="m-0 text-[10px] font-bold text-slate-400">{label}</p>
      <p className="m-0 mt-0.5 truncate text-xs font-black text-slate-900">
        {value}
      </p>
    </div>
  );
}

function MobileComposerActionButton({
  label,
  active = false,
  disabled = false,
  activeClassName = "bg-sky-400 text-white shadow-[0_10px_22px_rgba(56,189,248,0.24)]",
  actionRef = null,
  onPointerDown,
  onClick,
  children,
}) {
  return (
    <button
      ref={actionRef}
      type="button"
      onPointerDown={onPointerDown}
      onClick={onClick}
      disabled={disabled}
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition ${
        disabled
          ? "cursor-not-allowed bg-slate-950/[.04] text-slate-400"
          : active
            ? activeClassName
            : "bg-slate-950/[.055] text-slate-600 hover:bg-slate-950/[.09] hover:text-slate-800"
      }`}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}

function mobileAccountName(user) {
  return user?.username || user?.email?.split("@")?.[0] || "当前账号";
}

function durableMobileAvatarUrl(value) {
  if (!value || String(value).startsWith("blob:")) return null;
  return value;
}

export function buildMobileLoginAccountHint(
  device = null,
  fallbackUser = null,
  fallbackPfp = null
) {
  const emailPrefix = device?.email?.split?.("@")?.[0];
  const accountName =
    device?.displayName ||
    device?.username ||
    device?.deviceName ||
    emailPrefix ||
    mobileAccountName(fallbackUser);
  const avatarUrl =
    durableMobileAvatarUrl(device?.avatarUrl) ||
    durableMobileAvatarUrl(fallbackPfp);

  return {
    accountName,
    avatarUrl,
    deviceId: device?.deviceId || null,
  };
}

function isMobilePasskeyCancel(error) {
  return ["AbortError", "NotAllowedError"].includes(error?.name);
}

function mobileAccountEmail(user) {
  return user?.email || "未绑定邮箱";
}

function mobileAccountUserId(user = null) {
  const authUserId = Number(user?.authUserId);
  if (Number.isFinite(authUserId) && authUserId > 0) return authUserId;
  const id = Number(user?.id);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function normalizeMobileQuickLoginDevices(devices = []) {
  return devices
    .filter((device) => device?.deviceId && device?.userId)
    .map((device) => ({
      ...device,
      ...buildMobileLoginAccountHint(device),
    }))
    .sort((first, second) => {
      const firstTime = new Date(
        first.lastUsedAt || first.createdAt || 0
      ).getTime();
      const secondTime = new Date(
        second.lastUsedAt || second.createdAt || 0
      ).getTime();
      return secondTime - firstTime;
    });
}

const MOBILE_ACCOUNT_SETTINGS_NAV_ITEMS = [
  { href: "#memory-blocks", label: "长期记忆", icon: Note },
  { href: "#contact", label: "联系方式", icon: EnvelopeSimple },
  { href: "#security", label: "登录与安全", icon: LockKey },
  { href: "#passkeys", label: "通行密钥", icon: Fingerprint },
  { href: "#sessions", label: "会话与设备", icon: DeviceMobile },
  { href: "#notifications", label: "邮箱与通知", icon: Bell },
  { href: "#privacy", label: "数据与隐私", icon: ShieldCheck },
];

const MOBILE_ACCOUNT_SETTINGS_ADMIN_NAV_ITEMS = [
  { href: "#admin", label: "概览", icon: UserCircleGear },
  { href: "#admin-users", label: "用户", icon: UserCircle },
  { href: "#admin-workspaces", label: "工作区", icon: BookOpen },
  { href: "#admin-chats", label: "对话历史记录", icon: ChatsCircle },
  { href: "#admin-invites", label: "邀请", icon: EnvelopeSimple },
  { href: "#admin-default-prompt", label: "默认系统提示词", icon: TextT },
];

const MOBILE_ACCOUNT_SETTINGS_DETAIL_ITEMS = [
  { href: "#personalization", label: "个性化", icon: Sparkle },
  ...MOBILE_ACCOUNT_SETTINGS_NAV_ITEMS,
  ...MOBILE_ACCOUNT_SETTINGS_ADMIN_NAV_ITEMS,
];

function findMobileAccountSettingsDetail(href) {
  return (
    MOBILE_ACCOUNT_SETTINGS_DETAIL_ITEMS.find((item) => item.href === href) ||
    null
  );
}

function WorkspaceDrawer({
  open = true,
  threads,
  activeThreadId,
  removingThreadIds = [],
  onClose,
  onDeleteThread,
  onPinThread,
  onRenameThread,
  onSelectThread,
  onSignOut,
  onSwitchAccount,
  onAddAccount,
  sessionUser = null,
  sessionPfp = undefined,
}) {
  const auth = useContext(AuthContext);
  const { pfp, setPfp } = usePfp();
  const groups = useMemo(() => groupThreadsByWorkspace(threads), [threads]);
  const activeThread = threads.find((thread) => thread.id === activeThreadId);
  const activeWorkspaceSlug = activeThread?.workspaceSlug || groups[0]?.slug;
  const [expandedWorkspaces, setExpandedWorkspaces] = useState(() => ({
    [activeWorkspaceSlug]: true,
  }));
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [accountSwitcherOpen, setAccountSwitcherOpen] = useState(false);
  const [quickLoginDevices, setQuickLoginDevices] = useState([]);
  const [quickLoginDevicesLoading, setQuickLoginDevicesLoading] =
    useState(false);
  const [quickLoginBusyDeviceId, setQuickLoginBusyDeviceId] = useState(null);
  const [quickLoginSwitchError, setQuickLoginSwitchError] = useState(null);
  const [accountProfileOpen, setAccountProfileOpen] = useState(false);
  const [accountPersonalizationOpen, setAccountPersonalizationOpen] =
    useState(false);
  const [accountSettingsOpen, setAccountSettingsOpen] = useState(false);
  const [accountSettingsDetail, setAccountSettingsDetail] = useState(null);
  const [accountUserOverride, setAccountUserOverride] = useState(null);
  const [accountAuthCapability, setAccountAuthCapability] = useState(() =>
    detectAuthCapability()
  );
  const [accountPasskeys, setAccountPasskeys] = useState([]);
  const [accountPasskeysLoading, setAccountPasskeysLoading] = useState(false);
  const accountRowRef = useRef(null);
  const accountMenuRef = useRef(null);
  const accountPasskeysRef = useRef([]);
  const accountUser =
    accountUserOverride || sessionUser || auth?.store?.user || null;
  const accountPfp = sessionUser ? sessionPfp : pfp;
  const accountName = mobileAccountName(accountUser);
  const accountEmail = mobileAccountEmail(accountUser);
  const accountMenuPresence = useAnimatedPresence(accountMenuOpen, 140);
  const accountSwitcherPresence = useAnimatedPresence(
    accountMenuOpen && accountSwitcherOpen,
    140
  );
  const accountProfilePresence = useAnimatedPresence(accountProfileOpen, 170);
  const accountSettingsPresence = useAnimatedPresence(accountSettingsOpen, 170);

  const refreshAccountPasskeys = useCallback(async () => {
    const capability = detectAuthCapability();
    setAccountAuthCapability(capability);
    if (!capability.showPasskey) {
      accountPasskeysRef.current = [];
      setAccountPasskeys([]);
      return [];
    }

    setAccountPasskeysLoading(true);
    const result = await AccountSettingsApi.fetchPasskeys();
    setAccountPasskeysLoading(false);

    if (result?.success) {
      const nextPasskeys = result.passkeys || [];
      accountPasskeysRef.current = nextPasskeys;
      setAccountPasskeys(nextPasskeys);
      return nextPasskeys;
    }

    return accountPasskeysRef.current;
  }, []);

  useEffect(() => {
    if (!activeWorkspaceSlug) return;
    setExpandedWorkspaces((current) => ({
      ...current,
      [activeWorkspaceSlug]: true,
    }));
  }, [activeWorkspaceSlug]);

  useEffect(() => {
    setAccountUserOverride(null);
  }, [auth?.store?.user]);

  useEffect(() => {
    if (!accountSettingsOpen) return;
    refreshAccountPasskeys();
  }, [accountSettingsOpen, refreshAccountPasskeys]);

  useEffect(() => {
    if (!accountSettingsOpen) return;

    function refreshWhenVisible() {
      if (document.visibilityState === "visible") refreshAccountPasskeys();
    }

    window.addEventListener("focus", refreshAccountPasskeys);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.removeEventListener("focus", refreshAccountPasskeys);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [accountSettingsOpen, refreshAccountPasskeys]);

  function toggleWorkspace(workspaceSlug) {
    setExpandedWorkspaces((current) => ({
      ...current,
      [workspaceSlug]: !current[workspaceSlug],
    }));
  }

  function handleAccountProfile() {
    setAccountMenuOpen(false);
    setAccountSwitcherOpen(false);
    setAccountPersonalizationOpen(false);
    setAccountSettingsOpen(false);
    setAccountSettingsDetail(null);
    setAccountProfileOpen(true);
  }

  function handleAccountPersonalization() {
    setAccountMenuOpen(false);
    setAccountSwitcherOpen(false);
    setAccountProfileOpen(false);
    setAccountSettingsOpen(false);
    setAccountSettingsDetail(null);
    setAccountPersonalizationOpen(true);
  }

  function handleAccountSettings() {
    setAccountMenuOpen(false);
    setAccountSwitcherOpen(false);
    setAccountProfileOpen(false);
    setAccountPersonalizationOpen(false);
    setAccountSettingsDetail(null);
    setAccountSettingsOpen(true);
  }

  function handleAccountSettingsClose() {
    setAccountSettingsDetail(null);
    setAccountSettingsOpen(false);
  }

  function handleAccountSaved(nextUser) {
    setAccountUserOverride(nextUser);
    if (auth?.store?.authToken) {
      auth?.actions?.updateUser?.(nextUser, auth.store.authToken);
      return;
    }

    setStoredAuthUser(nextUser);
  }

  function handleAccountSignOut() {
    setAccountMenuOpen(false);
    setAccountSwitcherOpen(false);
    setAccountPersonalizationOpen(false);
    setAccountSettingsDetail(null);
    onSignOut?.();
  }

  const loadQuickLoginDevices = useCallback(async () => {
    setQuickLoginDevicesLoading(true);
    setQuickLoginSwitchError(null);
    try {
      const devices = await listLocalZkDevices();
      setQuickLoginDevices(normalizeMobileQuickLoginDevices(devices));
    } catch {
      setQuickLoginDevices([]);
      setQuickLoginSwitchError("无法读取此浏览器的快速登录账号。");
    } finally {
      setQuickLoginDevicesLoading(false);
    }
  }, []);

  async function handleQuickAccountSwitch(device) {
    if (!device?.deviceId || quickLoginBusyDeviceId) return;
    setQuickLoginBusyDeviceId(device.deviceId);
    setQuickLoginSwitchError(null);
    const result = await onSwitchAccount?.(device);
    setQuickLoginBusyDeviceId(null);

    if (result?.success) {
      setAccountMenuOpen(false);
      setAccountSwitcherOpen(false);
      setAccountProfileOpen(false);
      setAccountPersonalizationOpen(false);
      setAccountSettingsOpen(false);
      setAccountSettingsDetail(null);
      return;
    }

    setQuickLoginSwitchError(result?.error || "快速切换失败，请重新登录。");
    await loadQuickLoginDevices();
  }

  function handleAddAccount() {
    setAccountMenuOpen(false);
    setAccountSwitcherOpen(false);
    setAccountProfileOpen(false);
    setAccountPersonalizationOpen(false);
    setAccountSettingsOpen(false);
    setAccountSettingsDetail(null);
    onAddAccount?.();
  }

  useEffect(() => {
    setAccountMenuOpen(false);
    setAccountSwitcherOpen(false);
    setAccountProfileOpen(false);
    setAccountPersonalizationOpen(false);
    setAccountSettingsOpen(false);
    setAccountSettingsDetail(null);
  }, [activeThreadId]);

  useEffect(() => {
    if (!accountMenuOpen) return;
    loadQuickLoginDevices();
  }, [accountMenuOpen, loadQuickLoginDevices]);

  useEffect(() => {
    if (!accountMenuOpen) return;

    function onPointerDown(event) {
      if (accountRowRef.current?.contains(event.target)) return;
      if (accountMenuRef.current?.contains(event.target)) return;
      setAccountMenuOpen(false);
      setAccountSwitcherOpen(false);
    }

    function onKeyDown(event) {
      if (event.key === "Escape") {
        setAccountMenuOpen(false);
        setAccountSwitcherOpen(false);
      }
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [accountMenuOpen]);

  useEffect(() => {
    if (!open) return;

    function onKeyDown(event) {
      if (event.key !== "Escape") return;
      if (accountPersonalizationOpen) {
        setAccountPersonalizationOpen(false);
        return;
      }
      if (accountSettingsDetail) {
        setAccountSettingsDetail(null);
        return;
      }
      if (accountSettingsOpen) {
        setAccountSettingsDetail(null);
        setAccountSettingsOpen(false);
        return;
      }
      onClose();
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [
    open,
    onClose,
    accountPersonalizationOpen,
    accountSettingsOpen,
    accountSettingsDetail,
  ]);

  return (
    <div className="absolute inset-0 z-40" onClick={onClose}>
      <div
        className={`mobile-scrim-animated absolute inset-0 bg-slate-950/[.16] backdrop-blur-[3px] ${
          open ? "mobile-scrim-enter" : "mobile-scrim-exit"
        }`}
      />
      <div
        className={`mobile-drawer-panel-animated relative flex h-full w-[268px] max-w-[66%] flex-col rounded-r-[30px] border-r border-slate-200 bg-white shadow-[18px_0_58px_rgba(15,23,42,0.12)] ${
          open ? "mobile-drawer-panel-enter" : "mobile-drawer-panel-exit"
        }`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 pb-4 pt-[54px]">
          <div>
            <p className="text-[17px] font-black text-slate-950">Athena</p>
            <p className="mt-1 text-xs font-semibold text-slate-500">
              当前登录账号
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-950/[.045] text-slate-500 transition hover:bg-slate-950/[.08]"
            aria-label="关闭菜单"
          >
            <X size={18} weight="bold" />
          </button>
        </div>

        <div className="no-scroll min-h-0 flex-1 overflow-y-auto px-3 pb-4">
          <p className="px-3 py-2 text-[12px] font-black text-slate-500">
            Workspaces
          </p>
          <div>
            {groups.map((group, index) => (
              <React.Fragment key={group.slug}>
                {index > 0 && <MobileWorkspaceDivider />}
                <DrawerWorkspaceGroup
                  group={group}
                  expanded={!!expandedWorkspaces[group.slug]}
                  activeThreadId={activeThreadId}
                  removingThreadIds={removingThreadIds}
                  onToggle={() => toggleWorkspace(group.slug)}
                  onDeleteThread={onDeleteThread}
                  onPinThread={onPinThread}
                  onRenameThread={onRenameThread}
                  onSelectThread={onSelectThread}
                />
              </React.Fragment>
            ))}
          </div>
        </div>

        <div className="relative border-t border-slate-200 bg-white px-3 py-3">
          {accountMenuPresence.shouldRender && (
            <MobileAccountMenu
              open={accountMenuPresence.isVisible}
              menuRef={accountMenuRef}
              switcherOpen={accountSwitcherPresence.isVisible}
              switcherShouldRender={accountSwitcherPresence.shouldRender}
              accountName={accountName}
              currentUser={accountUser}
              pfp={accountPfp}
              quickLoginDevices={quickLoginDevices}
              quickLoginDevicesLoading={quickLoginDevicesLoading}
              quickLoginBusyDeviceId={quickLoginBusyDeviceId}
              quickLoginSwitchError={quickLoginSwitchError}
              onToggleSwitcher={() =>
                setAccountSwitcherOpen((current) => !current)
              }
              onSwitchAccount={handleQuickAccountSwitch}
              onAddAccount={handleAddAccount}
              onProfile={handleAccountProfile}
              onPersonalization={handleAccountPersonalization}
              onSettings={handleAccountSettings}
              onSignOut={handleAccountSignOut}
            />
          )}
          <button
            ref={accountRowRef}
            type="button"
            onClick={() => setAccountMenuOpen((current) => !current)}
            className="flex w-full items-center gap-3 rounded-[22px] px-2 py-2 text-left transition hover:bg-slate-950/[.04]"
            aria-label="打开账号菜单"
            aria-expanded={accountMenuOpen}
          >
            <MobileAccountAvatar pfp={accountPfp} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-black text-slate-950">
                {accountName}
              </p>
              <p className="truncate text-xs font-semibold text-slate-500">
                {accountEmail}
              </p>
            </div>
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-950/[.045] text-slate-500 transition group-hover:bg-slate-950/[.08]">
              <GearSix size={18} weight="bold" />
            </span>
          </button>
        </div>
      </div>
      {accountProfilePresence.shouldRender && (
        <MobileAccountProfileModal
          open={accountProfilePresence.isVisible}
          user={accountUser}
          accountName={accountName}
          accountEmail={accountEmail}
          pfp={accountPfp}
          setPfp={setPfp}
          onSaved={handleAccountSaved}
          onClose={() => setAccountProfileOpen(false)}
        />
      )}
      {accountPersonalizationOpen && (
        <MobileAccountSettingsDetailModal
          detail={findMobileAccountSettingsDetail("#personalization")}
          user={accountUser}
          authCapability={accountAuthCapability}
          passkeys={accountPasskeys}
          passkeysLoading={accountPasskeysLoading}
          refreshPasskeys={refreshAccountPasskeys}
          onUserUpdated={handleAccountSaved}
          subtitle="个人偏好"
          backLabel="关闭个性化"
          onClose={() => setAccountPersonalizationOpen(false)}
        />
      )}
      {accountSettingsPresence.shouldRender && (
        <MobileAccountSettingsHome
          open={accountSettingsPresence.isVisible}
          user={accountUser}
          onClose={handleAccountSettingsClose}
          onOpenDetail={setAccountSettingsDetail}
        />
      )}
      {accountSettingsDetail && accountSettingsOpen && (
        <MobileAccountSettingsDetailModal
          detail={findMobileAccountSettingsDetail(accountSettingsDetail)}
          user={accountUser}
          authCapability={accountAuthCapability}
          passkeys={accountPasskeys}
          passkeysLoading={accountPasskeysLoading}
          refreshPasskeys={refreshAccountPasskeys}
          onUserUpdated={handleAccountSaved}
          onClose={() => setAccountSettingsDetail(null)}
        />
      )}
    </div>
  );
}

function MobileWorkspaceDivider() {
  return (
    <div
      className="mx-4 my-2 h-px bg-gradient-to-r from-transparent via-slate-200/95 to-transparent"
      aria-hidden="true"
    />
  );
}

function MobileAccountSettingsHome({
  open = true,
  user = null,
  onClose,
  onOpenDetail,
}) {
  const showAdmin = canSeeAdmin(user);

  return (
    <div
      className={`mobile-popover-animated mobile-popover-origin-bottom-left absolute inset-y-0 left-0 z-[70] flex h-full w-[268px] max-w-[66%] flex-col rounded-r-[30px] border-r border-slate-200 bg-white text-slate-950 shadow-[18px_0_58px_rgba(15,23,42,0.14)] ${
        open ? "mobile-popover-animated-enter" : "mobile-popover-animated-exit"
      }`}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="flex items-center gap-3 px-4 pb-4 pt-[54px]">
        <button
          type="button"
          onClick={onClose}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-950/[.045] text-slate-600 transition hover:bg-slate-950/[.08]"
          aria-label="返回账号菜单"
        >
          <CaretLeft size={19} weight="bold" />
        </button>
        <div className="min-w-0">
          <p className="text-[17px] font-black leading-6 text-slate-950">
            设置
          </p>
          <p className="mt-0.5 truncate text-xs font-semibold text-slate-500">
            账号设置导航
          </p>
        </div>
      </div>

      <div className="no-scroll min-h-0 flex-1 overflow-y-auto px-3 pb-5">
        <p className="px-3 py-2 text-[12px] font-black text-slate-500">
          Account Settings
        </p>
        <div className="space-y-1">
          {MOBILE_ACCOUNT_SETTINGS_NAV_ITEMS.map((item) => (
            <MobileAccountSettingsNavRow
              key={item.href}
              {...item}
              onNavigate={onOpenDetail}
            />
          ))}
        </div>

        {showAdmin && (
          <div className="mt-4 border-t border-slate-200 pt-4">
            <p className="px-3 pb-2 text-[12px] font-black text-slate-500">
              管理员
            </p>
            <div className="space-y-1">
              {MOBILE_ACCOUNT_SETTINGS_ADMIN_NAV_ITEMS.map((item) => (
                <MobileAccountSettingsNavRow
                  key={item.href}
                  {...item}
                  onNavigate={onOpenDetail}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function MobileAccountSettingsNavRow({ href, label, icon: Icon, onNavigate }) {
  return (
    <button
      type="button"
      onClick={() => onNavigate?.(href)}
      className="flex w-full items-center gap-3 rounded-[18px] px-2.5 py-2.5 text-left text-slate-950 transition hover:bg-slate-950/[.045]"
    >
      <Icon size={22} weight="regular" className="shrink-0 text-slate-700" />
      <span className="min-w-0 flex-1 truncate text-[15px] font-black">
        {label}
      </span>
      <CaretRight size={18} weight="bold" className="shrink-0 text-slate-400" />
    </button>
  );
}

function MobileAccountSettingsDetailModal({
  detail,
  user,
  authCapability,
  passkeys,
  passkeysLoading,
  refreshPasskeys,
  onUserUpdated,
  subtitle = "账号设置",
  backLabel = "返回设置",
  onClose,
}) {
  if (!detail) return null;

  const Icon = detail.icon;

  return (
    <div
      className="absolute inset-0 z-[90] bg-slate-950/[.12] backdrop-blur-[2px]"
      onClick={(event) => {
        event.stopPropagation();
        onClose?.();
      }}
    >
      <div
        className="mobile-account-settings-modal-shell absolute left-1/2 top-1/2 w-[calc(100%-32px)] max-w-[342px] -translate-x-1/2 -translate-y-1/2"
        onClick={(event) => event.stopPropagation()}
      >
        <div
          className="mobile-account-settings-modal mobile-account-settings-modal-enter flex h-full min-h-0 flex-col overflow-hidden rounded-[30px] border border-white/80 bg-[#f5f5f7] text-slate-950 shadow-[0_28px_70px_rgba(15,23,42,0.24)]"
          role="dialog"
          aria-modal="true"
          aria-label={detail.label}
        >
          <div className="flex shrink-0 items-center gap-3 border-b border-slate-200/80 bg-white/86 px-4 py-3 backdrop-blur-xl">
            <button
              type="button"
              onClick={onClose}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-950/[.045] text-slate-600 transition hover:bg-slate-950/[.08]"
              aria-label={backLabel}
            >
              <CaretLeft size={19} weight="bold" />
            </button>
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-slate-200 bg-slate-50 text-slate-600">
              <Icon size={21} weight="regular" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[16px] font-black leading-5 text-slate-950">
                {detail.label}
              </p>
              <p className="mt-0.5 truncate text-xs font-semibold text-slate-500">
                {subtitle}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-950/[.045] text-slate-500 transition hover:bg-slate-950/[.08]"
              aria-label="关闭弹窗"
            >
              <X size={18} weight="bold" />
            </button>
          </div>

          <div className="mobile-account-settings-detail no-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3">
            <MobileAccountSettingsDetailContent
              detail={detail}
              user={user}
              authCapability={authCapability}
              passkeys={passkeys}
              passkeysLoading={passkeysLoading}
              refreshPasskeys={refreshPasskeys}
              onUserUpdated={onUserUpdated}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function MobileAccountSettingsDetailContent({
  detail,
  user,
  authCapability,
  passkeys,
  passkeysLoading,
  refreshPasskeys,
  onUserUpdated,
}) {
  const emailVerified = Boolean(user?.email && user?.email_verified_at);

  const renderDetail = () => {
    switch (detail.href) {
      case "#personalization":
        return (
          <PersonalizationCard user={user} onUserUpdated={onUserUpdated} />
        );
      case "#memory-blocks":
        return <MemoryBlocksCard />;
      case "#contact":
        return <ContactMethodsCard user={user} onUserUpdated={onUserUpdated} />;
      case "#security":
        return (
          <LoginSecurityCard
            user={user}
            emailVerified={emailVerified}
            authCapability={authCapability}
            passkeys={passkeys}
            passkeysLoading={passkeysLoading}
            refreshPasskeys={refreshPasskeys}
          />
        );
      case "#passkeys":
        return (
          <PasskeysCard
            authCapability={authCapability}
            passkeys={passkeys}
            passkeysLoading={passkeysLoading}
            refreshPasskeys={refreshPasskeys}
          />
        );
      case "#sessions":
        return <SessionsDevicesCard />;
      case "#notifications":
        return <NotificationsCard />;
      case "#privacy":
        return <DataPrivacyCard />;
      case "#admin":
      case "#admin-users":
      case "#admin-workspaces":
      case "#admin-chats":
      case "#admin-invites":
      case "#admin-default-prompt":
        if (!canSeeAdmin(user)) {
          return (
            <section className="account-card">
              <div className="rounded-2xl bg-slate-50 px-4 py-8 text-center text-sm font-medium text-slate-500">
                当前账号没有管理员设置权限。
              </div>
            </section>
          );
        }
        return (
          <AdminPanel
            currentUser={user}
            activeSection={detail.href.replace(/^#/, "")}
          />
        );
      default:
        return (
          <section className="account-card">
            <div className="rounded-2xl bg-slate-50 px-4 py-8 text-center text-sm font-medium text-slate-500">
              暂未找到该设置项。
            </div>
          </section>
        );
    }
  };

  return (
    <AccountSettingsDataProvider user={user}>
      {renderDetail()}
    </AccountSettingsDataProvider>
  );
}

function MobileAccountAvatar({ pfp, className = "h-10 w-10" }) {
  return (
    <div
      className={`${className} shrink-0 overflow-hidden rounded-full border border-slate-200 bg-slate-100 shadow-[0_8px_18px_rgba(15,23,42,0.10)]`}
    >
      {pfp ? (
        <img
          src={pfp}
          alt=""
          className="h-full w-full object-cover"
          draggable={false}
        />
      ) : (
        <div className="h-full w-full bg-[radial-gradient(circle_at_32%_28%,rgba(255,255,255,0.9),transparent_28%),linear-gradient(135deg,#f9a8d4,#93c5fd_52%,#fde68a)]" />
      )}
    </div>
  );
}

function MobileAccountMenu({
  open = true,
  menuRef,
  switcherOpen = false,
  switcherShouldRender = false,
  accountName,
  currentUser,
  pfp,
  quickLoginDevices = [],
  quickLoginDevicesLoading = false,
  quickLoginBusyDeviceId = null,
  quickLoginSwitchError = null,
  onToggleSwitcher,
  onSwitchAccount,
  onAddAccount,
  onProfile,
  onPersonalization,
  onSettings,
  onSignOut,
}) {
  const menuItems = [
    { label: "个人信息", icon: UserCircle, onClick: onProfile },
    { label: "个性化", icon: Sparkle, onClick: onPersonalization },
    { label: "设置", icon: GearSix, onClick: onSettings },
  ];

  return (
    <div
      ref={menuRef}
      className={`mobile-popover-animated mobile-popover-origin-bottom absolute bottom-[82px] left-3 right-3 z-50 rounded-[28px] border border-slate-200 bg-white p-2 text-slate-950 shadow-[0_18px_42px_rgba(15,23,42,0.16)] ${
        open ? "mobile-popover-animated-enter" : "mobile-popover-animated-exit"
      }`}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        onClick={onToggleSwitcher}
        className="flex w-full items-center gap-3 rounded-[22px] px-2 py-2.5 text-left transition hover:bg-slate-950/[.045]"
        aria-expanded={switcherOpen}
        aria-label="切换账号"
      >
        <MobileAccountAvatar pfp={pfp} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-black leading-5 text-slate-950">
            {accountName}
          </p>
          <p className="mt-0.5 truncate text-[13px] font-semibold leading-4 text-slate-500">
            快速切换账号
          </p>
        </div>
        <CaretRight size={19} weight="bold" className="text-slate-900" />
      </button>

      {switcherShouldRender && (
        <MobileQuickAccountSwitcher
          open={switcherOpen}
          currentUser={currentUser}
          devices={quickLoginDevices}
          loading={quickLoginDevicesLoading}
          busyDeviceId={quickLoginBusyDeviceId}
          error={quickLoginSwitchError}
          onSwitchAccount={onSwitchAccount}
          onAddAccount={onAddAccount}
        />
      )}

      <MobileAccountDivider />

      <div className="space-y-0.5">
        {menuItems.map(({ label, icon: Icon, onClick }) => (
          <button
            key={label}
            type="button"
            onClick={onClick}
            className="flex w-full items-center gap-3 rounded-[18px] px-2.5 py-2.5 text-left text-slate-950 transition hover:bg-slate-950/[.045]"
          >
            <Icon size={22} weight="regular" className="shrink-0" />
            <span className="text-[15px] font-black">{label}</span>
          </button>
        ))}
      </div>

      <MobileAccountDivider />

      <button
        type="button"
        onClick={onSignOut}
        className="flex w-full items-center gap-3 rounded-[18px] px-2.5 py-2.5 text-left text-rose-500 transition hover:bg-rose-50"
      >
        <SignOut size={22} weight="regular" className="shrink-0" />
        <span className="text-[15px] font-black">退出登录</span>
      </button>
    </div>
  );
}

function MobileQuickAccountSwitcher({
  open = true,
  currentUser,
  devices = [],
  loading = false,
  busyDeviceId = null,
  error = null,
  onSwitchAccount,
  onAddAccount,
}) {
  const currentUserId = mobileAccountUserId(currentUser);

  return (
    <div
      className={`mobile-account-switcher-popover mobile-popover-animated mobile-popover-origin-bottom-left absolute bottom-[10px] left-[calc(100%-88px)] z-[65] w-[222px] rounded-[24px] border border-slate-200 bg-white p-2 text-slate-950 shadow-[0_20px_50px_rgba(15,23,42,0.18)] ${
        open ? "mobile-popover-animated-enter" : "mobile-popover-animated-exit"
      }`}
    >
      <div className="max-h-[238px] overflow-y-auto overscroll-contain pr-0.5">
        {loading ? (
          <div className="flex items-center gap-2 rounded-[18px] px-3 py-3 text-[13px] font-semibold text-slate-500">
            <CircleNotch size={17} className="animate-spin" />
            正在读取账号
          </div>
        ) : devices.length ? (
          <div className="space-y-1">
            {devices.map((device) => {
              const selected =
                currentUserId && Number(device.userId) === currentUserId;
              const busy = busyDeviceId === device.deviceId;

              return (
                <button
                  key={device.deviceId}
                  type="button"
                  onClick={() => onSwitchAccount?.(device)}
                  disabled={busy || selected}
                  className={[
                    "flex w-full items-center gap-3 rounded-[18px] px-2.5 py-2.5 text-left transition",
                    selected
                      ? "bg-slate-100 text-slate-950"
                      : "hover:bg-slate-950/[.045]",
                    busy ? "cursor-wait opacity-70" : "",
                  ].join(" ")}
                >
                  <MobileAccountAvatar
                    pfp={device.avatarUrl}
                    className="h-9 w-9"
                  />
                  <span className="min-w-0 flex-1 truncate text-[14px] font-black">
                    {device.accountName}
                  </span>
                  {busy ? (
                    <CircleNotch
                      size={17}
                      className="shrink-0 animate-spin text-slate-400"
                    />
                  ) : selected ? (
                    <Check
                      size={17}
                      weight="bold"
                      className="shrink-0 text-sky-600"
                    />
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : (
          <p className="rounded-[18px] px-3 py-3 text-[13px] font-semibold leading-5 text-slate-500">
            此浏览器暂无可快速切换的账号。
          </p>
        )}
      </div>

      {error && (
        <p className="mt-1 px-3 text-[12px] font-semibold leading-5 text-rose-500">
          {error}
        </p>
      )}

      <MobileAccountDivider />

      <button
        type="button"
        onClick={onAddAccount}
        className="flex w-full items-center gap-3 rounded-[18px] px-2.5 py-2.5 text-left text-slate-950 transition hover:bg-slate-950/[.045]"
      >
        <Plus size={22} weight="regular" className="shrink-0" />
        <span className="text-[15px] font-black">添加账号</span>
      </button>
    </div>
  );
}

function MobileAccountDivider() {
  return (
    <div className="mx-2 my-1 h-px bg-gradient-to-r from-transparent via-slate-200 to-transparent" />
  );
}

function MobileAccountProfileModal({
  open = true,
  user,
  accountName,
  accountEmail,
  pfp,
  setPfp,
  onSaved,
  onClose,
}) {
  const formRef = useRef(null);
  const fileInputRef = useRef(null);
  const [avatarCrop, setAvatarCrop] = useState(null);
  const [pendingAvatar, setPendingAvatar] = useState(null);
  const [pendingRemovePfp, setPendingRemovePfp] = useState(false);
  const [usernameDraft, setUsernameDraft] = useState(accountName);
  const [saving, setSaving] = useState(false);
  const [cropSaving, setCropSaving] = useState(false);
  const previewPfp = pendingRemovePfp ? null : pendingAvatar?.url || pfp;

  useEffect(() => {
    setUsernameDraft(accountName);
  }, [accountName]);

  useEffect(() => {
    return () => {
      if (avatarCrop?.url) URL.revokeObjectURL(avatarCrop.url);
    };
  }, [avatarCrop?.url]);

  useEffect(() => {
    return () => {
      if (pendingAvatar?.url) URL.revokeObjectURL(pendingAvatar.url);
    };
  }, [pendingAvatar?.url]);

  useEffect(() => {
    if (!open) return;

    function onKeyDown(event) {
      if (event.key === "Escape") onClose();
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose]);

  function clearAvatarInput() {
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function closeAvatarCropDialog() {
    if (avatarCrop?.url) URL.revokeObjectURL(avatarCrop.url);
    setAvatarCrop(null);
    clearAvatarInput();
  }

  function handleFileUpload(event) {
    const file = event.target.files?.[0];
    if (!file) {
      clearAvatarInput();
      return;
    }

    if (!file.type?.startsWith("image/")) {
      showToast("请选择图片文件。", "error", { clear: true });
      clearAvatarInput();
      return;
    }

    if (avatarCrop?.url) URL.revokeObjectURL(avatarCrop.url);
    setAvatarCrop({
      url: URL.createObjectURL(file),
      fileName: file.name || "avatar.jpg",
      mimeType: file.type || "image/jpeg",
    });
  }

  function handleRemovePfp() {
    if (pendingAvatar?.url) URL.revokeObjectURL(pendingAvatar.url);
    setPendingAvatar(null);
    setPendingRemovePfp(true);
  }

  async function handleSave(event) {
    event.preventDefault();
    if (!formRef.current?.reportValidity()) return;

    const nextUsername = usernameDraft.trim();
    const payload = {
      username: nextUsername,
      password: "",
      bio: user?.bio || "",
    };

    setSaving(true);
    const profileResult = await System.updateUser(payload);

    if (!profileResult.success) {
      setSaving(false);
      showToast(`账号信息保存失败：${profileResult.error}`, "error", {
        clear: true,
      });
      return;
    }

    if (pendingRemovePfp) {
      const { success, error } = await System.removePfp();
      if (!success) {
        setSaving(false);
        showToast(`头像移除失败：${error}`, "error", { clear: true });
        return;
      }
      setPfp(null);
    } else if (pendingAvatar?.blob) {
      const formData = new FormData();
      formData.append(
        "file",
        new File([pendingAvatar.blob], pendingAvatar.fileName, {
          type: pendingAvatar.blob.type,
        })
      );
      const { success, error } = await System.uploadPfp(formData);
      if (!success) {
        setSaving(false);
        showToast(`头像上传失败：${error}`, "error", { clear: true });
        return;
      }
      const pfpUrl = user?.id ? await System.fetchPfp(user.id) : null;
      setPfp(pfpUrl);
    }

    setSaving(false);
    const nextUser = {
      ...(user || {}),
      username: nextUsername,
      bio: payload.bio,
    };
    onSaved(nextUser);
    showToast("账号信息已保存。", "success", { clear: true });
    onClose();
  }

  return (
    <div
      className="absolute inset-0 z-[70] flex items-center justify-center px-8"
      onClick={(event) => {
        event.stopPropagation();
        onClose();
      }}
    >
      <div
        className={`mobile-scrim-animated absolute inset-0 bg-slate-950/[.18] backdrop-blur-[3px] ${
          open ? "mobile-scrim-enter" : "mobile-scrim-exit"
        }`}
      />
      <div
        className={`mobile-popover-animated mobile-popover-origin-bottom relative w-full overflow-hidden rounded-[30px] border border-slate-200 bg-white p-5 text-center text-slate-950 shadow-[0_24px_64px_rgba(15,23,42,0.20)] ${
          open
            ? "mobile-popover-animated-enter"
            : "mobile-popover-animated-exit"
        }`}
        onClick={(event) => event.stopPropagation()}
      >
        <form ref={formRef} onSubmit={handleSave}>
          <button
            type="button"
            onClick={onClose}
            className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-950/[.045] hover:text-slate-700"
            aria-label="关闭个人信息"
          >
            <X size={17} weight="regular" />
          </button>
          <label className="group relative mx-auto block h-20 w-20 cursor-pointer">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleFileUpload}
            />
            <MobileAccountAvatar pfp={previewPfp} className="h-20 w-20" />
            <span className="absolute inset-0 flex items-center justify-center rounded-full bg-slate-950/0 text-[11px] font-semibold text-white opacity-0 transition group-hover:bg-slate-950/45 group-hover:opacity-100">
              更换
            </span>
          </label>
          {(previewPfp || pendingAvatar) && (
            <button
              type="button"
              onClick={handleRemovePfp}
              disabled={saving}
              className="mt-2 text-[12px] font-medium text-slate-500 transition hover:text-rose-500 disabled:opacity-50"
            >
              移除头像
            </button>
          )}
          <div className="relative mt-5 rounded-[18px] border border-slate-200 bg-white px-4 pb-3 pt-4 text-left">
            <p className="absolute -top-2 left-4 bg-white px-1.5 text-[11px] font-semibold leading-4 text-slate-400">
              邮箱
            </p>
            <p className="truncate text-sm font-semibold text-slate-900">
              {accountEmail}
            </p>
          </div>
          <label className="group relative mt-4 block rounded-[18px] border border-slate-200 bg-white px-4 pb-3 pt-4 text-left transition focus-within:border-slate-400 focus-within:ring-2 focus-within:ring-slate-950/[.08]">
            <span className="absolute -top-2 left-4 bg-white px-1.5 text-[11px] font-semibold leading-4 text-slate-400 transition group-focus-within:text-slate-600">
              账号名称
            </span>
            <input
              type="text"
              value={usernameDraft}
              onChange={(event) => setUsernameDraft(event.target.value)}
              minLength={USERNAME_MIN_LENGTH}
              maxLength={USERNAME_MAX_LENGTH}
              pattern={USERNAME_PATTERN}
              required
              autoComplete="off"
              className="block w-full border-0 bg-transparent p-0 text-base font-semibold text-slate-900 outline-none placeholder:text-slate-400"
              placeholder="账号名称"
            />
          </label>
          <AppButton
            type="submit"
            disabled={saving || cropSaving}
            loading={saving}
            variant="primary"
            size="md"
            className="mx-auto mt-4 min-w-[112px]"
          >
            保存
          </AppButton>
        </form>
      </div>
      {avatarCrop && (
        <MobileAvatarCropDialog
          source={avatarCrop}
          uploading={cropSaving}
          onCancel={closeAvatarCropDialog}
          onImageError={() => {
            showToast("无法读取图片，请选择其他图片。", "error", {
              clear: true,
            });
            closeAvatarCropDialog();
          }}
          onSave={async (blob) => {
            setCropSaving(true);
            if (pendingAvatar?.url) URL.revokeObjectURL(pendingAvatar.url);
            setPendingAvatar({
              blob,
              fileName: avatarCrop.fileName,
              url: URL.createObjectURL(blob),
            });
            setPendingRemovePfp(false);
            setCropSaving(false);
            closeAvatarCropDialog();
          }}
        />
      )}
    </div>
  );
}

function MobileAvatarCropDialog({
  source,
  uploading = false,
  onCancel,
  onImageError,
  onSave,
}) {
  const imageRef = useRef(null);
  const pointersRef = useRef(new Map());
  const gestureRef = useRef(null);
  const offsetRef = useRef({ x: 0, y: 0 });
  const zoomRef = useRef(1);
  const cropSize = 230;
  const [imageSize, setImageSize] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const metrics = imageSize
    ? mobileCropMetrics({ imageSize, cropSize, zoom, offset })
    : null;

  useEffect(() => {
    offsetRef.current = offset;
  }, [offset]);

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  function clampOffset(nextOffset, nextZoom = zoom) {
    if (!imageSize) return nextOffset;
    const { maxX, maxY } = mobileCropMetrics({
      imageSize,
      cropSize,
      zoom: nextZoom,
      offset: nextOffset,
    });
    return {
      x: mobileClamp(nextOffset.x, -maxX, maxX),
      y: mobileClamp(nextOffset.y, -maxY, maxY),
    };
  }

  function handlePointerDown(event) {
    if (!imageSize || uploading) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    pointersRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });

    const pointers = Array.from(pointersRef.current.values());
    if (pointers.length >= 2) {
      gestureRef.current = {
        type: "pinch",
        startDistance: mobilePointerDistance(pointers),
        startCenter: mobilePointerCenter(pointers),
        startOffset: offsetRef.current,
        startZoom: zoomRef.current,
      };
      return;
    }

    gestureRef.current = {
      type: "drag",
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startOffset: offsetRef.current,
    };
  }

  function handlePointerMove(event) {
    if (!pointersRef.current.has(event.pointerId)) return;
    pointersRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });

    const gesture = gestureRef.current;
    const pointers = Array.from(pointersRef.current.values());
    if (!gesture) return;

    if (gesture.type === "pinch" && pointers.length >= 2) {
      const nextCenter = mobilePointerCenter(pointers);
      const nextDistance = mobilePointerDistance(pointers);
      const nextZoom = mobileClamp(
        gesture.startZoom * (nextDistance / gesture.startDistance),
        1,
        3
      );
      const nextOffset = {
        x: gesture.startOffset.x + nextCenter.x - gesture.startCenter.x,
        y: gesture.startOffset.y + nextCenter.y - gesture.startCenter.y,
      };
      setZoom(nextZoom);
      setOffset(clampOffset(nextOffset, nextZoom));
      return;
    }

    if (gesture.type === "drag" && gesture.pointerId === event.pointerId) {
      const nextOffset = {
        x: gesture.startOffset.x + event.clientX - gesture.startX,
        y: gesture.startOffset.y + event.clientY - gesture.startY,
      };
      setOffset(clampOffset(nextOffset));
    }
  }

  function handlePointerUp(event) {
    pointersRef.current.delete(event.pointerId);
    const pointers = Array.from(pointersRef.current.entries());
    if (!pointers.length) {
      gestureRef.current = null;
      return;
    }

    const [pointerId, pointer] = pointers[0];
    gestureRef.current = {
      type: "drag",
      pointerId,
      startX: pointer.x,
      startY: pointer.y,
      startOffset: offsetRef.current,
    };
  }

  async function handleSave() {
    if (!imageRef.current || !imageSize) return;
    const blob = await mobileCropAvatarBlob({
      image: imageRef.current,
      imageSize,
      cropSize,
      zoom,
      offset,
      mimeType: source.mimeType,
    });
    if (!blob) {
      onImageError?.();
      return;
    }
    await onSave(blob);
  }

  return (
    <div
      className="absolute inset-0 z-[80] flex items-center justify-center px-6"
      onClick={(event) => {
        event.stopPropagation();
        if (!uploading) onCancel();
      }}
    >
      <div className="absolute inset-0 bg-slate-950/[.22] backdrop-blur-[3px]" />
      <div
        className="relative max-h-[calc(100%-44px)] w-full max-w-[326px] overflow-y-auto rounded-[30px] border border-slate-200 bg-white p-4 text-left text-slate-950 shadow-[0_24px_64px_rgba(15,23,42,0.22)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[15px] font-semibold leading-5">裁切头像</p>
            <p className="mt-1 text-[12px] font-medium leading-5 text-slate-500">
              拖动图片调整位置，双指捏合缩放头像范围。
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={uploading}
            className="flex h-8 w-8 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-950/[.045] hover:text-slate-700 disabled:opacity-50"
            aria-label="取消裁切头像"
          >
            <X size={17} weight="regular" />
          </button>
        </div>
        <div
          className="relative mx-auto mt-4 touch-none overflow-hidden rounded-[30px] bg-slate-100 shadow-inner ring-1 ring-slate-200"
          style={{ width: cropSize, height: cropSize }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          <img
            ref={imageRef}
            src={source.url}
            alt="头像裁切预览"
            draggable={false}
            className="absolute left-1/2 top-1/2 max-w-none select-none"
            style={
              metrics
                ? {
                    width: metrics.renderWidth,
                    height: metrics.renderHeight,
                    transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px))`,
                  }
                : { opacity: 0 }
            }
            onLoad={(event) => {
              const nextSize = {
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              };
              setImageSize(nextSize);
              setOffset({ x: 0, y: 0 });
              setZoom(1);
            }}
            onError={onImageError}
          />
          <div
            className="pointer-events-none absolute inset-0"
            style={{
              boxShadow: `0 0 0 ${cropSize}px rgb(15 23 42 / 0.34)`,
              borderRadius: "999px",
            }}
          />
          <div className="pointer-events-none absolute inset-0 rounded-full ring-2 ring-white/90" />
        </div>
        <p className="mt-3 text-center text-[12px] font-medium text-slate-400">
          单指拖动，双指缩放
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <AppButton
            type="button"
            onClick={onCancel}
            disabled={uploading}
            variant="secondary"
            size="sm"
            className="min-w-[82px]"
          >
            取消
          </AppButton>
          <AppButton
            type="button"
            onClick={handleSave}
            disabled={!imageSize || uploading}
            loading={uploading}
            variant="primary"
            size="sm"
            className="min-w-[96px]"
          >
            使用头像
          </AppButton>
        </div>
      </div>
    </div>
  );
}

function mobilePointerDistance(pointers) {
  const [first, second] = pointers;
  if (!first || !second) return 1;
  return Math.max(1, Math.hypot(second.x - first.x, second.y - first.y));
}

function mobilePointerCenter(pointers) {
  const [first, second] = pointers;
  if (!first || !second) return first || { x: 0, y: 0 };
  return {
    x: (first.x + second.x) / 2,
    y: (first.y + second.y) / 2,
  };
}

function mobileCropMetrics({ imageSize, cropSize, zoom, offset }) {
  const baseScale = cropSize / Math.min(imageSize.width, imageSize.height);
  const displayScale = baseScale * zoom;
  const renderWidth = imageSize.width * displayScale;
  const renderHeight = imageSize.height * displayScale;
  const maxX = Math.max(0, (renderWidth - cropSize) / 2);
  const maxY = Math.max(0, (renderHeight - cropSize) / 2);

  return {
    displayScale,
    renderWidth,
    renderHeight,
    maxX,
    maxY,
    imageLeft: (cropSize - renderWidth) / 2 + offset.x,
    imageTop: (cropSize - renderHeight) / 2 + offset.y,
  };
}

async function mobileCropAvatarBlob({
  image,
  imageSize,
  cropSize,
  zoom,
  offset,
  mimeType,
}) {
  const metrics = mobileCropMetrics({ imageSize, cropSize, zoom, offset });
  const outputSize = 512;
  const sx = Math.max(0, (0 - metrics.imageLeft) / metrics.displayScale);
  const sy = Math.max(0, (0 - metrics.imageTop) / metrics.displayScale);
  const sw = Math.min(imageSize.width - sx, cropSize / metrics.displayScale);
  const sh = Math.min(imageSize.height - sy, cropSize / metrics.displayScale);
  const canvas = document.createElement("canvas");
  canvas.width = outputSize;
  canvas.height = outputSize;
  const context = canvas.getContext("2d");
  if (!context) return null;

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, outputSize, outputSize);
  context.drawImage(image, sx, sy, sw, sh, 0, 0, outputSize, outputSize);

  const outputType = mimeType === "image/png" ? "image/png" : "image/jpeg";
  return new Promise((resolve) => {
    canvas.toBlob(
      (blob) => resolve(blob),
      outputType,
      outputType === "image/jpeg" ? 0.92 : undefined
    );
  });
}

function mobileClamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function groupThreadsByWorkspace(threads = []) {
  const groups = [];
  const bySlug = new Map();

  for (const thread of threads) {
    if (!isVisibleThreadItem(thread)) continue;
    const slug = thread.workspaceSlug || thread.workspace;
    if (!bySlug.has(slug)) {
      const group = {
        slug,
        name: thread.workspace || slug || "Workspace",
        threads: [],
      };
      bySlug.set(slug, group);
      groups.push(group);
    }
    bySlug.get(slug).threads.push(thread);
  }

  return groups;
}

function DrawerWorkspaceGroup({
  group,
  expanded,
  activeThreadId,
  removingThreadIds = [],
  onToggle,
  onDeleteThread,
  onPinThread,
  onRenameThread,
  onSelectThread,
}) {
  const [menuThreadId, setMenuThreadId] = useState(null);
  const [menuAnchorEl, setMenuAnchorEl] = useState(null);
  const menuPresence = useAnimatedPresence(!!menuThreadId, 130);
  const activeMenuThread = group.threads.find(
    (thread) => thread.id === menuThreadId
  );

  useEffect(() => {
    setMenuThreadId(null);
    setMenuAnchorEl(null);
  }, [activeThreadId, expanded]);

  useEffect(() => {
    if (!menuThreadId) return;

    function onPointerDown(event) {
      if (event.target.closest("[data-mobile-thread-menu-root]")) return;
      setMenuThreadId(null);
    }

    function onKeyDown(event) {
      if (event.key === "Escape") setMenuThreadId(null);
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuThreadId]);

  function closeMenu() {
    setMenuThreadId(null);
    setMenuAnchorEl(null);
  }

  return (
    <div className="min-h-0">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 rounded-[18px] px-3 py-3 text-left text-slate-800 transition hover:bg-slate-950/[.045]"
      >
        {expanded ? (
          <CaretDown size={16} weight="bold" className="text-slate-400" />
        ) : (
          <CaretRight size={16} weight="bold" className="text-slate-400" />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-black">{group.name}</p>
          <p className="text-[11px] font-semibold text-slate-500">
            {group.threads.length} threads
          </p>
        </div>
      </button>
      {expanded && (
        <div className="ml-5 mt-1 border-l border-slate-200 pl-2">
          <div className="no-scroll max-h-[430px] overflow-y-auto pr-1">
            {group.threads.map((thread) => {
              const active = thread.id === activeThreadId;
              const menuOpen = menuThreadId === thread.id;
              const removing = removingThreadIds.includes(thread.id);
              return (
                <div
                  key={thread.id}
                  data-mobile-thread-menu-root
                  className={`group flex w-full items-center gap-2 overflow-hidden rounded-[16px] text-left transition-[max-height,opacity,transform,padding,margin,background-color,color] duration-200 ease-out ${
                    removing
                      ? "pointer-events-none mb-0 max-h-0 -translate-x-2 px-3 py-0 opacity-0"
                      : `mb-1 max-h-12 px-3 py-2.5 opacity-100 ${
                          active
                            ? "bg-sky-100/90 text-slate-950"
                            : "text-slate-700 hover:bg-slate-950/[.045]"
                        }`
                  }`}
                  aria-hidden={removing}
                >
                  <button
                    type="button"
                    onClick={() => {
                      closeMenu();
                      onSelectThread(thread.id);
                    }}
                    className="min-w-0 flex-1 truncate text-left text-[13px] font-black"
                  >
                    {thread.title}
                  </button>
                  <div className="relative shrink-0">
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        const nextOpen = menuThreadId !== thread.id;
                        setMenuThreadId((current) =>
                          current === thread.id ? null : thread.id
                        );
                        setMenuAnchorEl(nextOpen ? event.currentTarget : null);
                      }}
                      className={`flex h-7 w-7 items-center justify-center rounded-full transition ${
                        menuOpen
                          ? "bg-slate-950/[.075] text-slate-700"
                          : "text-slate-400 opacity-70 hover:bg-slate-950/[.055] hover:text-slate-700 hover:opacity-100"
                      }`}
                      aria-label={`${thread.title} 更多操作`}
                    >
                      <DotsThree size={16} weight="bold" />
                    </button>
                    {menuOpen &&
                      menuPresence.shouldRender &&
                      activeMenuThread?.id === thread.id && (
                        <MobileThreadActionMenu
                          open={menuPresence.isVisible}
                          thread={thread}
                          anchorEl={menuAnchorEl}
                          onClose={closeMenu}
                          onDeleteThread={onDeleteThread}
                          onPinThread={onPinThread}
                          onRenameThread={onRenameThread}
                        />
                      )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function MobileThreadActionMenu({
  open = true,
  thread,
  anchorEl,
  onClose,
  onDeleteThread,
  onPinThread,
  onRenameThread,
}) {
  const popoverRef = useRef(null);
  const [style, setStyle] = useState({
    position: "fixed",
    width: "154px",
    left: "0px",
    top: "0px",
    zIndex: 10060,
    visibility: "hidden",
  });

  useEffect(() => {
    positionPopover();
    const frame = window.requestAnimationFrame(positionPopover);

    window.addEventListener("resize", positionPopover);
    window.addEventListener("scroll", positionPopover, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", positionPopover);
      window.removeEventListener("scroll", positionPopover, true);
    };
  }, [anchorEl]);

  function positionPopover() {
    if (typeof window === "undefined" || !anchorEl) return;
    const rect = anchorEl.getBoundingClientRect();
    const width = 154;
    const gap = 8;
    const estimatedHeight = popoverRef.current?.offsetHeight || 136;
    const left = Math.min(
      Math.max(8, rect.right - width),
      window.innerWidth - width - 8
    );
    const preferredTop = rect.bottom + gap;
    const top =
      preferredTop + estimatedHeight > window.innerHeight - 8
        ? rect.top - estimatedHeight - gap
        : preferredTop;

    setStyle({
      position: "fixed",
      width: `${width}px`,
      left: `${left}px`,
      top: `${Math.max(8, top)}px`,
      zIndex: 10060,
      visibility: "visible",
    });
  }

  function runAction(action) {
    onClose?.();
    action?.(thread);
  }

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={popoverRef}
      style={style}
      data-mobile-thread-menu-root
      className={`mobile-popover-animated mobile-popover-origin-top-right absolute right-0 top-8 z-[90] w-[154px] overflow-hidden rounded-[18px] border border-slate-200 bg-white p-1.5 text-slate-900 shadow-[0_18px_46px_rgba(15,23,42,0.16)] ${
        open ? "mobile-popover-animated-enter" : "mobile-popover-animated-exit"
      }`}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        onClick={() => runAction(onRenameThread)}
        className="flex w-full items-center gap-2.5 rounded-[13px] px-3 py-2.5 text-left text-[13px] font-semibold transition hover:bg-slate-950/[.045]"
      >
        <PencilSimple size={16} weight="regular" className="shrink-0" />
        <span>重命名线程</span>
      </button>
      <button
        type="button"
        onClick={() => runAction(onPinThread)}
        className="flex w-full items-center gap-2.5 rounded-[13px] px-3 py-2.5 text-left text-[13px] font-semibold transition hover:bg-slate-950/[.045]"
      >
        <PushPinSimple size={16} weight="regular" className="shrink-0" />
        <span>置顶线程</span>
      </button>
      <button
        type="button"
        onClick={() => runAction(onDeleteThread)}
        className="flex w-full items-center gap-2.5 rounded-[13px] px-3 py-2.5 text-left text-[13px] font-semibold text-rose-500 transition hover:bg-rose-50 hover:text-rose-600"
      >
        <Trash size={16} weight="regular" className="shrink-0" />
        <span>删除线程</span>
      </button>
    </div>,
    document.body
  );
}

function MoreActionSheet({ open = true, anchorRef, onClose }) {
  const popoverRef = useRef(null);
  const [style, setStyle] = useState({
    position: "fixed",
    width: "218px",
    left: "0px",
    top: "0px",
    zIndex: 10020,
    visibility: "hidden",
  });

  useEffect(() => {
    positionPopover();
    const frame = window.requestAnimationFrame(positionPopover);

    function onPointerDown(event) {
      if (anchorRef?.current?.contains(event.target)) return;
      if (popoverRef.current?.contains(event.target)) return;
      onClose();
    }

    function onKeyDown(event) {
      if (event.key === "Escape") onClose();
    }

    window.addEventListener("resize", positionPopover);
    window.addEventListener("scroll", positionPopover, true);
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", positionPopover);
      window.removeEventListener("scroll", positionPopover, true);
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [anchorRef, onClose]);

  function positionPopover() {
    if (typeof window === "undefined") return;
    const rect = anchorRef?.current?.getBoundingClientRect();
    if (!rect) return;

    const width = 218;
    const gap = 10;
    const left = Math.min(
      Math.max(8, rect.right - width),
      window.innerWidth - width - 8
    );
    const top = Math.min(
      rect.bottom + gap,
      window.innerHeight - (popoverRef.current?.offsetHeight || 176) - 8
    );

    setStyle({
      position: "fixed",
      width: `${width}px`,
      left: `${left}px`,
      top: `${Math.max(8, top)}px`,
      zIndex: 10020,
      visibility: "visible",
    });
  }

  return createPortal(
    <div
      ref={popoverRef}
      style={style}
      className={`mobile-popover-animated mobile-popover-origin-top-right rounded-[24px] border border-slate-200 bg-white p-2 text-slate-950 shadow-[0_22px_58px_rgba(15,23,42,0.16)] ${
        open ? "mobile-popover-animated-enter" : "mobile-popover-animated-exit"
      }`}
      onClick={(event) => event.stopPropagation()}
    >
      {moreActions.map((action) => (
        <button
          key={action.label}
          type="button"
          onClick={onClose}
          className="w-full rounded-[18px] px-4 py-3 text-left transition hover:bg-slate-950/[.045]"
        >
          <p className="text-sm font-semibold text-slate-950">{action.label}</p>
          <p className="mt-1 text-xs font-medium text-slate-500">
            {action.meta}
          </p>
        </button>
      ))}
    </div>,
    document.body
  );
}

function AttachmentPopover({
  open = true,
  anchorRef,
  onPickCamera,
  onPickPhotos,
  onPickFiles,
  onClose,
}) {
  const popoverRef = useRef(null);
  const [style, setStyle] = useState({
    position: "fixed",
    width: "218px",
    left: "0px",
    top: "0px",
    zIndex: 10020,
    visibility: "hidden",
  });

  useEffect(() => {
    positionPopover();
    const frame = window.requestAnimationFrame(positionPopover);

    function onPointerDown(event) {
      if (anchorRef?.current?.contains(event.target)) return;
      if (popoverRef.current?.contains(event.target)) return;
      onClose();
    }

    function onKeyDown(event) {
      if (event.key === "Escape") onClose();
    }

    window.addEventListener("resize", positionPopover);
    window.addEventListener("scroll", positionPopover, true);
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", positionPopover);
      window.removeEventListener("scroll", positionPopover, true);
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [anchorRef, onClose]);

  function positionPopover() {
    if (typeof window === "undefined") return;
    const rect = anchorRef?.current?.getBoundingClientRect();
    if (!rect) return;

    const width = 218;
    const gap = 12;
    const estimatedHeight = popoverRef.current?.offsetHeight || 174;
    const left = Math.min(
      Math.max(8, rect.left),
      window.innerWidth - width - 8
    );
    const top = Math.max(8, rect.top - estimatedHeight - gap);

    setStyle({
      position: "fixed",
      width: `${width}px`,
      left: `${left}px`,
      top: `${top}px`,
      zIndex: 10020,
      visibility: "visible",
    });
  }

  if (typeof document === "undefined") return null;

  const attachmentOptions = [
    {
      label: "相机",
      icon: Camera,
      onPick: onPickCamera,
    },
    {
      label: "照片",
      icon: ImageSquare,
      onPick: onPickPhotos,
    },
    { label: "文件", icon: FileIcon, onPick: onPickFiles },
  ];

  function handlePick(onPick) {
    mobileChatDebug("attachment:popover-pick", {
      hasPicker: !!onPick,
    });
    onPick?.();
  }

  return createPortal(
    <div
      ref={popoverRef}
      style={style}
      className={`mobile-popover-animated mobile-popover-origin-bottom-left pointer-events-auto overflow-hidden rounded-[26px] border border-white/[.82] bg-white/[.92] p-2 text-slate-950 shadow-[0_22px_58px_rgba(15,23,42,0.20)] backdrop-blur-2xl ${
        open ? "mobile-popover-animated-enter" : "mobile-popover-animated-exit"
      }`}
    >
      {attachmentOptions.map(({ label, icon: Icon, onPick }) => (
        <button
          key={label}
          type="button"
          onClick={() => handlePick(onPick)}
          className="flex w-full items-center gap-3 rounded-[20px] px-2.5 py-2.5 text-left transition hover:bg-slate-950/[.045]"
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-950/[.055] text-slate-900">
            <Icon size={21} weight="bold" />
          </span>
          <span className="text-[15px] font-black text-slate-950">{label}</span>
        </button>
      ))}
    </div>,
    document.body
  );
}
