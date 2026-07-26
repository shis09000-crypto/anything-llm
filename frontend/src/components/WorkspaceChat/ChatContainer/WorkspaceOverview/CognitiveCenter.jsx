import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowsClockwise,
  Brain,
  Check,
  FileText,
  Gavel,
  Question,
  UsersThree,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import useUser from "@/hooks/useUser";
import WorkspaceCognition from "@/models/workspaceCognition";
import WorkspaceThread from "@/models/workspaceThread";
import System from "@/models/system";
import showToast from "@/utils/toast";
import { canSeeAdmin } from "@/utils/authz";

const TABS = [
  ["overview", "总览"],
  ["candidates", "候选项"],
  ["legacy", "旧版候选"],
  ["positions", "用户观点"],
  ["disputes", "争议"],
  ["questions", "开放问题"],
  ["evidence", "来源与证据"],
  ["ledger", "当前与历史"],
  ["account-memory", "账号记忆导入"],
  ["meetings", "会议包"],
  ["backfill", "历史回填"],
];

const TYPE_LABELS = {
  document_fact: "资料事实",
  user_position: "用户观点",
  conclusion: "结论",
  decision: "决策",
  hypothesis: "假设",
  open_question: "开放问题",
  risk: "风险",
  constraint: "约束",
};

const STATUS_LABELS = {
  candidate: "待确认",
  source_backed: "来源支持",
  user_confirmed: "已确认",
  contested: "存在争议",
  rejected: "已拒绝",
  superseded: "已替代",
  expired: "已过期",
};

const DISCLOSURE_OPTIONS = [
  ["workspace_only", "仅工作区"],
  ["meeting_allowed", "允许进入会议"],
  ["meeting_redacted", "脱敏后进入会议"],
  ["blocked", "禁止进入会议"],
];

function itemById(items, id) {
  return items.find((item) => Number(item.id) === Number(id));
}

function SectionEmpty({ children = "暂无内容" }) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-300/70 px-4 py-8 text-center text-sm text-[color:var(--overview-text-secondary)]">
      {children}
    </div>
  );
}

function CognitiveItem({ assertion, children, actions = null }) {
  return (
    <article className="rounded-2xl border border-[color:var(--overview-glass-border)] bg-white/45 p-4">
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="overview-glass-pill px-2 py-1">
          {TYPE_LABELS[assertion?.assertionType] || assertion?.assertionType}
        </span>
        <span className="overview-glass-pill px-2 py-1">
          {STATUS_LABELS[assertion?.verificationStatus] ||
            assertion?.verificationStatus}
        </span>
        <span className="text-[color:var(--overview-text-secondary)]">
          可信度 {Math.round(Number(assertion?.confidence || 0) * 100)}%
        </span>
      </div>
      <p className="mt-3 text-sm leading-6 text-[color:var(--overview-text-primary)]">
        {assertion?.statement}
      </p>
      {children}
      {actions && <div className="mt-3 flex flex-wrap gap-2">{actions}</div>}
    </article>
  );
}

function SmallButton({
  children,
  onClick,
  disabled = false,
  tone = "default",
}) {
  const toneClass =
    tone === "primary"
      ? "bg-sky-600 text-white hover:bg-sky-500"
      : tone === "danger"
        ? "border border-rose-300 text-rose-700 hover:bg-rose-50"
        : "border border-slate-300 text-[color:var(--overview-text-primary)] hover:bg-white/70";
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`rounded-lg px-3 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50 ${toneClass}`}
    >
      {children}
    </button>
  );
}

function DisclosureSelect({ value, onChange, disabled = false }) {
  return (
    <select
      value={value || "workspace_only"}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-800 disabled:opacity-50"
    >
      {DISCLOSURE_OPTIONS.map(([key, label]) => (
        <option key={key} value={key}>
          {label}
        </option>
      ))}
    </select>
  );
}

export default function CognitiveCenter({ workspace, threadSlug = null }) {
  const { user } = useUser();
  const canManageShared = !user?.role || canSeeAdmin(user);
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState("overview");
  const [loading, setLoading] = useState(false);
  const [profile, setProfile] = useState(null);
  const [items, setItems] = useState({
    assertions: [],
    positions: [],
    evidence: [],
    relations: [],
  });
  const [candidates, setCandidates] = useState([]);
  const [legacyCandidates, setLegacyCandidates] = useState([]);
  const [extraction, setExtraction] = useState({ threads: [], jobs: [] });
  const [ledger, setLedger] = useState({ items: [], relations: [] });
  const [ledgerView, setLedgerView] = useState("current");
  const [packets, setPackets] = useState([]);
  const [busyId, setBusyId] = useState(null);
  const [meetingDraft, setMeetingDraft] = useState({
    title: "",
    objective: "",
    documentIds: "",
    documentPathPrefixes: "",
    knowledgeNodeKeys: "",
    redactionTerms: "",
    authorizationEnabled: false,
    actionType: "",
    allowedTargets: "",
    maxAmount: "",
    maxQuantity: "",
    maxDurationMinutes: "",
    latestDueAt: "",
    validUntil: "",
    allowConditional: false,
    requiresSecondApproval: false,
  });
  const [meetingSession, setMeetingSession] = useState(null);
  const [disputeDraft, setDisputeDraft] = useState({ left: "", right: "" });
  const [accountMemories, setAccountMemories] = useState([]);
  const [selectedMemoryIds, setSelectedMemoryIds] = useState([]);
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [historyThreads, setHistoryThreads] = useState([]);
  const [selectedThreadSlugs, setSelectedThreadSlugs] = useState([]);

  const load = useCallback(async () => {
    if (!workspace?.slug) return;
    setLoading(true);
    const [
      profileResult,
      itemsResult,
      candidateResult,
      allCandidateResult,
      extractionResult,
      ledgerResult,
      packetResult,
    ] = await Promise.all([
      WorkspaceCognition.profile(workspace.slug),
      WorkspaceCognition.items(workspace.slug),
      WorkspaceCognition.candidates(workspace.slug),
      WorkspaceCognition.candidates(workspace.slug, { includeLegacy: true }),
      WorkspaceCognition.extractionState(workspace.slug),
      WorkspaceCognition.ledger(workspace.slug),
      WorkspaceCognition.meetingPackets(workspace.slug),
    ]);
    if (profileResult.success) setProfile(profileResult.profile);
    if (itemsResult.success)
      setItems({
        assertions: itemsResult.assertions || [],
        positions: itemsResult.positions || [],
        evidence: itemsResult.evidence || [],
        relations: itemsResult.relations || [],
      });
    if (candidateResult.success)
      setCandidates(candidateResult.candidates || []);
    if (allCandidateResult.success)
      setLegacyCandidates(
        (allCandidateResult.candidates || []).filter(
          (candidate) => candidate.legacyPipeline
        )
      );
    if (extractionResult.success)
      setExtraction({
        threads: extractionResult.threads || [],
        jobs: extractionResult.jobs || [],
        roughResults: extractionResult.roughResults || [],
        aggregation: extractionResult.aggregation || null,
      });
    if (ledgerResult.success)
      setLedger({
        items: ledgerResult.items || [],
        relations: ledgerResult.relations || [],
      });
    if (packetResult.success) setPackets(packetResult.packets || []);
    setLoading(false);
  }, [workspace?.slug]);

  useEffect(() => {
    if (expanded) load();
  }, [expanded, load]);

  useEffect(() => {
    function refreshSyncedWorkspaceActivity(event) {
      if (!expanded) return;
      if (!["cognition", "meetings"].includes(event.detail?.domain)) return;
      if (Number(event.detail?.workspaceId) !== Number(workspace?.id)) return;
      load();
    }
    window.addEventListener(
      "athena-sync-v2-workspace-activity-refresh",
      refreshSyncedWorkspaceActivity
    );
    return () =>
      window.removeEventListener(
        "athena-sync-v2-workspace-activity-refresh",
        refreshSyncedWorkspaceActivity
      );
  }, [expanded, load, workspace?.id]);

  useEffect(() => {
    if (!expanded || tab !== "account-memory" || accountMemories.length) return;
    setMemoryLoading(true);
    System.memoryBlocks({ limit: 500, detail: "full" })
      .then((result) => {
        if (result?.success) {
          setAccountMemories(
            (result.blocks || []).flatMap((block) =>
              (block.items || []).map((item) => ({
                ...item,
                category: item.category || block.category || block.key,
              }))
            )
          );
        } else {
          showToast(result?.error || "无法读取账号长期记忆。", "error", {
            clear: true,
          });
        }
      })
      .finally(() => setMemoryLoading(false));
  }, [accountMemories.length, expanded, tab]);

  useEffect(() => {
    if (!expanded || tab !== "backfill" || historyThreads.length) return;
    WorkspaceThread.all(workspace.slug, { includeArchived: true }).then(
      ({ threads = [] }) => {
        const eligible = threads.filter(
          (thread) => thread.thread_type !== "meeting"
        );
        setHistoryThreads(eligible);
        if (threadSlug && eligible.some((thread) => thread.slug === threadSlug))
          setSelectedThreadSlugs([threadSlug]);
      }
    );
  }, [expanded, historyThreads.length, tab, threadSlug, workspace.slug]);

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get(
      "cognition"
    );
    if (!requested) return;
    setExpanded(true);
    if (TABS.some(([key]) => key === requested)) setTab(requested);
  }, []);

  const candidatePositions = useMemo(
    () =>
      items.positions.filter(
        (position) =>
          position.status === "candidate" &&
          (!user?.id || Number(position.subjectUserId) === Number(user.id))
      ),
    [items.positions, user?.id]
  );
  const candidateAssertions = useMemo(
    () =>
      items.assertions.filter(
        (assertion) => assertion.verificationStatus === "candidate"
      ),
    [items.assertions]
  );
  const pendingCanonicalCandidates = useMemo(
    () =>
      candidates.filter((candidate) => candidate.reviewStatus === "pending"),
    [candidates]
  );
  const confirmedPositions = useMemo(
    () => items.positions.filter((position) => position.status === "confirmed"),
    [items.positions]
  );
  const openQuestions = useMemo(
    () =>
      items.assertions.filter(
        (assertion) =>
          assertion.assertionType === "open_question" &&
          !["rejected", "superseded", "expired"].includes(
            assertion.verificationStatus
          )
      ),
    [items.assertions]
  );

  async function runAction(key, action) {
    setBusyId(key);
    const result = await action();
    setBusyId(null);
    if (!result?.success) {
      showToast(result?.error || "操作失败", "error", { clear: true });
      return false;
    }
    await load();
    return true;
  }

  async function confirmPosition(position) {
    return runAction(`position:${position.id}`, () =>
      WorkspaceCognition.patchPosition(workspace.slug, position.id, {
        status: "confirmed",
      })
    );
  }

  async function rejectPosition(position) {
    return runAction(`position:${position.id}`, () =>
      WorkspaceCognition.patchPosition(workspace.slug, position.id, {
        status: "withdrawn",
      })
    );
  }

  async function confirmAssertion(assertion) {
    return runAction(`assertion:${assertion.id}`, () =>
      WorkspaceCognition.patchAssertion(workspace.slug, assertion.id, {
        verificationStatus: "user_confirmed",
      })
    );
  }

  async function rejectAssertion(assertion) {
    return runAction(`assertion:${assertion.id}`, () =>
      WorkspaceCognition.patchAssertion(workspace.slug, assertion.id, {
        verificationStatus: "rejected",
      })
    );
  }

  async function reviewCanonicalCandidate(candidate, eventType, payload = {}) {
    return runAction(`candidate:${candidate.id}`, () =>
      WorkspaceCognition.reviewCandidate(
        workspace.slug,
        candidate.id,
        eventType,
        payload
      )
    );
  }

  async function editCanonicalCandidate(candidate) {
    const statement = window.prompt("修改认知命题", candidate.statement);
    if (!statement?.trim() || statement.trim() === candidate.statement) return;
    await reviewCanonicalCandidate(candidate, "edited", {
      statement: statement.trim(),
      relation: candidate.suggestedRelation,
    });
  }

  async function splitCanonicalCandidate(candidate) {
    const value = window.prompt("每行填写一个独立命题", candidate.statement);
    const statements = String(value || "")
      .split(/\n+/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (statements.length < 2) {
      if (value !== null)
        showToast("拆分至少需要两个独立命题。", "warning", { clear: true });
      return;
    }
    await reviewCanonicalCandidate(candidate, "split", {
      items: statements.map((statement) => ({
        assertionType: candidate.assertionType,
        statement,
      })),
    });
  }

  async function retryExtractionJob(job) {
    const budgetOverride =
      job.status === "budget_blocked"
        ? window.confirm(
            "该任务超过自动 Token 预算。是否授权本任务执行一次高成本重试？"
          )
          ? "once"
          : null
        : null;
    if (job.status === "budget_blocked" && !budgetOverride) return;
    await runAction(`job:${job.id}`, () =>
      WorkspaceCognition.retryJob(workspace.slug, job.id, {
        ...(budgetOverride ? { budgetOverride } : {}),
      })
    );
  }

  async function editAssertion(assertion) {
    const statement = window.prompt("修改认知命题", assertion.statement);
    if (!statement?.trim() || statement.trim() === assertion.statement) return;
    await runAction(`assertion:${assertion.id}`, () =>
      WorkspaceCognition.patchAssertion(workspace.slug, assertion.id, {
        statement: statement.trim(),
      })
    );
  }

  async function splitAssertion(assertion, position = null) {
    const value = window.prompt(
      "每行填写一个独立观点或命题",
      assertion.statement
    );
    const statements = String(value || "")
      .split(/\n+/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (statements.length < 2) {
      if (value !== null)
        showToast("拆分至少需要两个独立命题。", "warning", { clear: true });
      return;
    }
    setBusyId(`assertion:${assertion.id}`);
    for (const statement of statements) {
      const result = await WorkspaceCognition.createAssertion(workspace.slug, {
        assertionType: assertion.assertionType,
        statement,
        asPosition: Boolean(position),
        stance: position?.stance || "supports",
      });
      if (!result.success) {
        setBusyId(null);
        showToast(result.error || "拆分候选失败", "error", { clear: true });
        await load();
        return;
      }
    }
    if (position) {
      await WorkspaceCognition.patchPosition(workspace.slug, position.id, {
        status: "superseded",
      });
    } else {
      await WorkspaceCognition.patchAssertion(workspace.slug, assertion.id, {
        verificationStatus: "superseded",
      });
    }
    setBusyId(null);
    await load();
  }

  async function approveAssertion(assertion, disclosureLevel) {
    return runAction(`assertion:${assertion.id}`, () =>
      WorkspaceCognition.patchAssertion(workspace.slug, assertion.id, {
        disclosureLevel,
      })
    );
  }

  async function approvePosition(position, meetingDisclosure) {
    return runAction(`position:${position.id}`, () =>
      WorkspaceCognition.patchPosition(workspace.slug, position.id, {
        meetingDisclosure,
      })
    );
  }

  async function approveEvidence(evidence, disclosureLevel) {
    return runAction(`evidence:${evidence.id}`, () =>
      WorkspaceCognition.patchEvidence(workspace.slug, evidence.id, {
        disclosureLevel,
      })
    );
  }

  async function rebuildProfile() {
    await runAction("profile", () =>
      WorkspaceCognition.rebuildProfile(workspace.slug)
    );
  }

  async function backfill() {
    const threadSlugs = selectedThreadSlugs.length
      ? selectedThreadSlugs
      : threadSlug
        ? [threadSlug]
        : [];
    if (!threadSlugs.length) {
      showToast("请至少选择一个历史线程。", "warning", { clear: true });
      return;
    }
    await runAction("backfill", () =>
      WorkspaceCognition.extractThread(workspace.slug, { threadSlugs })
    );
  }

  async function toggleArchive(thread) {
    const key = `archive:${thread.slug}`;
    setBusyId(key);
    const result = thread.archivedAt
      ? await WorkspaceThread.restore(workspace.slug, thread.slug)
      : await WorkspaceThread.archive(workspace.slug, thread.slug);
    setBusyId(null);
    if (!result?.success) {
      showToast(result?.error || "线程归档操作失败", "error", { clear: true });
      return;
    }
    setHistoryThreads((threads) =>
      threads.map((item) =>
        item.slug === thread.slug ? result.thread || item : item
      )
    );
    await load();
  }

  async function importAccountMemories() {
    if (!selectedMemoryIds.length) {
      showToast("请先选择要导入的账号记忆。", "warning", { clear: true });
      return;
    }
    const ok = await runAction("account-memory", () =>
      WorkspaceCognition.importAccountMemory(workspace.slug, selectedMemoryIds)
    );
    if (ok) setSelectedMemoryIds([]);
  }

  async function createDispute() {
    const left = Number(disputeDraft.left);
    const right = Number(disputeDraft.right);
    if (!left || !right || left === right) {
      showToast("请输入两个不同的认知项 ID。", "warning", { clear: true });
      return;
    }
    const ok = await runAction("dispute", () =>
      WorkspaceCognition.createRelation(workspace.slug, {
        fromAssertionId: left,
        toAssertionId: right,
        relationType: "conflicts_with",
      })
    );
    if (ok) setDisputeDraft({ left: "", right: "" });
  }

  async function createMeetingPacket() {
    if (!meetingDraft.title.trim()) {
      showToast("请填写会议名称。", "warning", { clear: true });
      return;
    }
    if (meetingDraft.authorizationEnabled && !meetingDraft.actionType.trim()) {
      showToast("启用有限承诺时必须填写承诺类型。", "warning", {
        clear: true,
      });
      return;
    }
    const rebuilt = await WorkspaceCognition.rebuildProfile(workspace.slug);
    if (!rebuilt.success) {
      showToast(rebuilt.error || "无法重建 Cognitive Profile。", "error", {
        clear: true,
      });
      return;
    }
    const approvedAssertions = items.assertions.filter(
      (assertion) =>
        ["source_backed", "user_confirmed", "contested"].includes(
          assertion.verificationStatus
        ) &&
        ["meeting_allowed", "meeting_redacted"].includes(
          assertion.disclosureLevel
        )
    );
    const approvedAssertionIds = new Set(
      approvedAssertions.map((assertion) => assertion.id)
    );
    const approvedPositions = confirmedPositions.filter(
      (position) =>
        approvedAssertionIds.has(position.assertionId) &&
        ["meeting_allowed", "meeting_redacted"].includes(
          position.meetingDisclosure
        ) &&
        (!user?.id || Number(position.subjectUserId) === Number(user.id))
    );
    const approvedEvidence = items.evidence.filter(
      (evidence) =>
        approvedAssertionIds.has(evidence.assertionId) &&
        evidence.freshness === "current" &&
        evidence.sourceType !== "thread_capsule_origin" &&
        ["meeting_allowed", "meeting_redacted"].includes(
          evidence.disclosureLevel
        )
    );
    if (!approvedAssertions.length) {
      showToast("请先批准至少一个正式认知项进入会议。", "warning", {
        clear: true,
      });
      return;
    }
    await runAction("meeting:create", async () => {
      const created = await WorkspaceCognition.createMeetingPacket(
        workspace.slug,
        {
          title: meetingDraft.title.trim(),
          objective: meetingDraft.objective.trim(),
          delegateUserId: user?.id || null,
          profileRevision: rebuilt.profile?.revision || null,
          selection: {
            assertionIds: approvedAssertions.map((item) => item.id),
            positionIds: approvedPositions.map((item) => item.id),
            evidenceIds: approvedEvidence.map((item) => item.id),
          },
          sourceWhitelist: {
            documentIds: meetingDraft.documentIds
              .split(/[，,\s]+/)
              .map((item) => item.trim())
              .filter(Boolean),
            documentPathPrefixes: meetingDraft.documentPathPrefixes
              .split(/[，,\n]+/)
              .map((item) => item.trim())
              .filter(Boolean),
            knowledgeNodeKeys: meetingDraft.knowledgeNodeKeys
              .split(/[，,\n]+/)
              .map((item) => item.trim())
              .filter(Boolean),
          },
          redactionRules: [
            { type: "email" },
            { type: "phone" },
            ...meetingDraft.redactionTerms
              .split(/\n+/)
              .map((item) => item.trim())
              .filter(Boolean)
              .map((match) => ({ match, replacement: "[REDACTED]" })),
          ],
          authorizations: meetingDraft.authorizationEnabled
            ? [
                {
                  actionType: meetingDraft.actionType.trim(),
                  targetScope: {
                    allowedTargets: meetingDraft.allowedTargets
                      .split(/[，,\n]+/)
                      .map((item) => item.trim())
                      .filter(Boolean),
                  },
                  limits: {
                    maxAmount: meetingDraft.maxAmount || null,
                    maxQuantity: meetingDraft.maxQuantity || null,
                    maxDurationMinutes: meetingDraft.maxDurationMinutes || null,
                    latestDueAt: meetingDraft.latestDueAt || null,
                  },
                  validUntil: meetingDraft.validUntil || null,
                  allowConditional: meetingDraft.allowConditional,
                  requiresSecondApproval: meetingDraft.requiresSecondApproval,
                },
              ]
            : [],
        }
      );
      if (!created.success) return created;
      const frozen = await WorkspaceCognition.freezeMeetingPacket(
        workspace.slug,
        created.packet.id
      );
      if (frozen.success) {
        setMeetingDraft({
          title: "",
          objective: "",
          documentIds: "",
          documentPathPrefixes: "",
          knowledgeNodeKeys: "",
          redactionTerms: "",
          authorizationEnabled: false,
          actionType: "",
          allowedTargets: "",
          maxAmount: "",
          maxQuantity: "",
          maxDurationMinutes: "",
          latestDueAt: "",
          validUntil: "",
          allowConditional: false,
          requiresSecondApproval: false,
        });
      }
      return frozen;
    });
  }

  async function startMeeting(packet) {
    setBusyId(`packet:${packet.id}`);
    const result = await WorkspaceCognition.startMeetingSession(
      workspace.slug,
      packet.id
    );
    setBusyId(null);
    if (!result.success) {
      showToast(result.error || "启动会议失败", "error", { clear: true });
      return;
    }
    setMeetingSession({
      id: result.session.id,
      packet: result.packet,
      messages: [],
      input: "",
      sending: false,
      metadata: null,
      liveEnabled: false,
      liveDocumentIds: "",
      liveQuery: "",
      commitmentEnabled: false,
      commitmentActionType: "",
      commitmentTarget: "",
      commitmentAmount: "",
      commitmentQuantity: "",
      commitmentDurationMinutes: "",
      commitmentDueAt: "",
      commitmentConditional: false,
      audit: [],
    });
  }

  async function revokeMeeting(packet) {
    await runAction(`packet:revoke:${packet.id}`, () =>
      WorkspaceCognition.revokeMeetingPacket(workspace.slug, packet.id)
    );
  }

  return (
    <section className="overview-glass-card mt-5 rounded-[24px] p-5">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center justify-between gap-4 text-left"
      >
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-[color:var(--overview-text-primary)]">
            <Brain size={19} className="text-[color:var(--overview-accent)]" />
            Workspace Cognitive Center
          </div>
          <p className="mt-1 text-xs leading-5 text-[color:var(--overview-text-secondary)]">
            区分资料事实、用户观点、AI
            推论、确认结论、争议和开放问题，并生成可冻结会议代表。
          </p>
        </div>
        <span className="overview-glass-pill shrink-0 px-3 py-1.5 text-xs">
          {expanded
            ? "收起"
            : `${pendingCanonicalCandidates.length || candidatePositions.length || ""} 打开`}
        </span>
      </button>

      {expanded && (
        <div className="mt-5">
          <div className="flex flex-wrap items-center gap-2 border-b border-[color:var(--overview-glass-border)] pb-3">
            {TABS.map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                className={`rounded-lg px-3 py-1.5 text-xs ${
                  tab === key
                    ? "bg-sky-600 text-white"
                    : "overview-glass-pill text-[color:var(--overview-text-primary)]"
                }`}
              >
                {label}
                {key === "candidates" &&
                pendingCanonicalCandidates.length + candidatePositions.length >
                  0
                  ? ` ${pendingCanonicalCandidates.length + candidatePositions.length}`
                  : ""}
              </button>
            ))}
            <button
              type="button"
              onClick={load}
              disabled={loading}
              className="ml-auto rounded-lg p-2 text-[color:var(--overview-text-secondary)] hover:bg-white/50"
              aria-label="刷新认知中心"
            >
              <ArrowsClockwise
                size={16}
                className={loading ? "animate-spin" : ""}
              />
            </button>
          </div>

          <div className="mt-4">
            {tab === "overview" && (
              <OverviewTab
                profile={profile}
                candidateCount={
                  pendingCanonicalCandidates.length + candidateAssertions.length
                }
                onRebuild={rebuildProfile}
                rebuilding={busyId === "profile"}
              />
            )}
            {tab === "candidates" && (
              <div className="space-y-4">
                <CanonicalCandidatesTab
                  candidates={pendingCanonicalCandidates}
                  busyId={busyId}
                  onReview={reviewCanonicalCandidate}
                  onEdit={editCanonicalCandidate}
                  onSplit={splitCanonicalCandidate}
                />
                {(candidatePositions.length > 0 ||
                  candidateAssertions.length > 0) && (
                  <div>
                    <p className="mb-2 text-xs font-medium text-[color:var(--overview-text-secondary)]">
                      迁移前候选
                    </p>
                    <CandidatesTab
                      assertions={items.assertions}
                      positions={candidatePositions}
                      busyId={busyId}
                      onConfirm={confirmPosition}
                      onReject={rejectPosition}
                      onConfirmAssertion={confirmAssertion}
                      onRejectAssertion={rejectAssertion}
                      onEditAssertion={editAssertion}
                      onSplitAssertion={splitAssertion}
                      canManageShared={canManageShared}
                      currentUserId={user?.id || null}
                    />
                  </div>
                )}
              </div>
            )}
            {tab === "positions" && (
              <PositionsTab
                assertions={items.assertions}
                positions={confirmedPositions}
                busyId={busyId}
                onApproveMeeting={approvePosition}
                currentUserId={user?.id || null}
                singleUserMode={!user?.role}
              />
            )}
            {tab === "legacy" && (
              <LegacyCandidates candidates={legacyCandidates} />
            )}
            {tab === "disputes" && (
              <DisputesTab
                relations={items.relations}
                assertions={items.assertions}
                draft={disputeDraft}
                setDraft={setDisputeDraft}
                busy={busyId === "dispute"}
                onCreate={createDispute}
              />
            )}
            {tab === "questions" && (
              <AssertionList assertions={openQuestions} />
            )}
            {tab === "evidence" && (
              <EvidenceTab
                evidence={items.evidence}
                assertions={items.assertions}
                busyId={busyId}
                onApproveMeeting={approveEvidence}
                canManageShared={canManageShared}
              />
            )}
            {tab === "ledger" && (
              <LedgerTab
                ledger={ledger}
                view={ledgerView}
                setView={setLedgerView}
              />
            )}
            {tab === "account-memory" && (
              <AccountMemoryTab
                memories={accountMemories}
                selectedIds={selectedMemoryIds}
                setSelectedIds={setSelectedMemoryIds}
                loading={memoryLoading}
                importing={busyId === "account-memory"}
                onImport={importAccountMemories}
              />
            )}
            {tab === "meetings" && (
              <MeetingsTab
                assertions={items.assertions}
                positions={confirmedPositions}
                packets={packets}
                draft={meetingDraft}
                setDraft={setMeetingDraft}
                busyId={busyId}
                onApproveAssertion={approveAssertion}
                onCreate={createMeetingPacket}
                onStart={startMeeting}
                onRevoke={revokeMeeting}
              />
            )}
            {tab === "backfill" && (
              <div className="space-y-4">
                <ExtractionStatus
                  state={extraction}
                  busyId={busyId}
                  onRetry={retryExtractionJob}
                />
                <BackfillTab
                  threads={historyThreads}
                  selectedSlugs={selectedThreadSlugs}
                  setSelectedSlugs={setSelectedThreadSlugs}
                  busy={busyId === "backfill"}
                  onBackfill={backfill}
                  busyId={busyId}
                  onToggleArchive={toggleArchive}
                />
              </div>
            )}
          </div>
        </div>
      )}
      {meetingSession && (
        <MeetingSessionModal
          workspace={workspace}
          state={meetingSession}
          setState={setMeetingSession}
          onClose={() => setMeetingSession(null)}
        />
      )}
    </section>
  );
}

function OverviewTab({ profile, candidateCount, onRebuild, rebuilding }) {
  const cards = [
    ["资料事实", profile?.facts?.length || 0, FileText],
    ["确认结论", profile?.conclusions?.length || 0, Check],
    [
      "用户观点",
      Object.values(profile?.positionsByUser || {}).flat().length,
      UsersThree,
    ],
    ["争议", profile?.disputes?.length || 0, WarningCircle],
    ["开放问题", profile?.openQuestions?.length || 0, Question],
    ["待确认候选", candidateCount, Brain],
  ];
  return (
    <div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        {cards.map(([label, count, Icon]) => (
          <div
            key={label}
            className="rounded-2xl border border-[color:var(--overview-glass-border)] bg-white/40 p-4"
          >
            <Icon size={17} className="text-[color:var(--overview-accent)]" />
            <div className="mt-2 text-xl font-semibold text-[color:var(--overview-text-primary)]">
              {count}
            </div>
            <div className="text-xs text-[color:var(--overview-text-secondary)]">
              {label}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-[color:var(--overview-text-secondary)]">
        <span>Profile revision {profile?.revision || 0}</span>
        <span
          className={
            profile?.stale ? "font-medium text-amber-700" : "text-emerald-700"
          }
        >
          {profile?.stale
            ? `等待重建 ${profile?.rebuiltGeneration || 0}/${profile?.dirtyGeneration || 0}`
            : "Profile 已同步"}
        </span>
        <span>
          证据覆盖率{" "}
          {Math.round(Number(profile?.evidenceCoverage?.ratio || 0) * 100)}%
        </span>
        <span>
          过期证据 {profile?.evidenceCoverage?.staleEvidenceCount || 0}
        </span>
        <SmallButton onClick={onRebuild} disabled={rebuilding}>
          {rebuilding ? "正在重建…" : "重建正式 Profile"}
        </SmallButton>
      </div>
    </div>
  );
}

function CanonicalCandidatesTab({
  candidates,
  busyId,
  onReview,
  onEdit,
  onSplit,
}) {
  if (!candidates.length)
    return <SectionEmpty>暂无批量抽取产生的待确认候选。</SectionEmpty>;
  return (
    <div className="space-y-3">
      {candidates.map((candidate) => {
        const relation = candidate.suggestedRelation || {};
        const adjustRelation = () => {
          const relationType = window.prompt(
            "关系类型：confirms / extends / qualifies / contradicts / supersedes / withdraws / duplicates",
            relation.relationType || ""
          );
          if (relationType === null) return;
          const targetItemId = window.prompt(
            "目标 Cognitive Item ID",
            relation.targetItemId || ""
          );
          if (!relationType.trim() || !Number(targetItemId)) return;
          onReview(candidate, "confirmed", {
            relation: {
              relationType: relationType.trim(),
              targetItemId: Number(targetItemId),
            },
          });
        };
        const assertion = {
          assertionType: candidate.assertionType,
          verificationStatus: "candidate",
          confidence: candidate.confidence,
          statement: candidate.statement,
        };
        return (
          <CognitiveItem
            key={candidate.id}
            assertion={assertion}
            actions={
              <>
                <SmallButton
                  tone="primary"
                  disabled={busyId === `candidate:${candidate.id}`}
                  onClick={() => onReview(candidate, "confirmed")}
                >
                  确认并写入长期认知
                </SmallButton>
                {relation.relationType && (
                  <>
                    <SmallButton
                      disabled={busyId === `candidate:${candidate.id}`}
                      onClick={() =>
                        onReview(candidate, "confirmed", {
                          relation: { relationType: null, targetItemId: null },
                        })
                      }
                    >
                      作为新项确认
                    </SmallButton>
                    <SmallButton
                      disabled={busyId === `candidate:${candidate.id}`}
                      onClick={adjustRelation}
                    >
                      调整关系并确认
                    </SmallButton>
                  </>
                )}
                {candidate.assertionType === "user_position" && (
                  <SmallButton
                    disabled={busyId === `candidate:${candidate.id}`}
                    onClick={() => onReview(candidate, "temporary_confirmed")}
                  >
                    标记暂时观点
                  </SmallButton>
                )}
                <SmallButton
                  disabled={busyId === `candidate:${candidate.id}`}
                  onClick={() => onEdit(candidate)}
                >
                  修改
                </SmallButton>
                <SmallButton
                  disabled={busyId === `candidate:${candidate.id}`}
                  onClick={() => onSplit(candidate)}
                >
                  拆分
                </SmallButton>
                <SmallButton
                  tone="danger"
                  disabled={busyId === `candidate:${candidate.id}`}
                  onClick={() => onReview(candidate, "rejected")}
                >
                  拒绝
                </SmallButton>
              </>
            }
          >
            <div className="mt-2 space-y-1 text-xs text-[color:var(--overview-text-secondary)]">
              <p>
                来源：{candidate.origin} · Chat{" "}
                {candidate.sourceChatIds?.join(", ") || "-"}
              </p>
              {candidate.quality?.retentionReason && (
                <p>
                  保留理由：{candidate.quality.retentionReason} · 工作区相关度{" "}
                  {Math.round(
                    Number(candidate.quality.workspaceRelevance || 0) * 100
                  )}
                  % · 长期价值{" "}
                  {Math.round(Number(candidate.quality.durability || 0) * 100)}%
                  · 用户中心度{" "}
                  {Math.round(
                    Number(candidate.quality.userCentrality || 0) * 100
                  )}
                  %
                </p>
              )}
              {candidate.quality?.possibleDuplicateCandidateId && (
                <p>
                  可能重复候选 #{candidate.quality.possibleDuplicateCandidateId}
                </p>
              )}
              {relation.relationType && (
                <p>
                  模型建议：{relation.relationType} → Cognitive Item #
                  {relation.targetItemId}
                  {relation.rationale ? ` · ${relation.rationale}` : ""}
                </p>
              )}
              <p>候选原文与后续审核事件均只追加保存。</p>
            </div>
          </CognitiveItem>
        );
      })}
    </div>
  );
}

function LegacyCandidates({ candidates }) {
  if (!candidates.length)
    return <SectionEmpty>没有旧版流水线候选。</SectionEmpty>;
  return (
    <div className="space-y-3">
      <p className="text-xs text-[color:var(--overview-text-secondary)]">
        以下记录仅供审计，已从当前候选、认知索引和 Profile 中隔离。
      </p>
      {candidates.map((candidate) => (
        <article
          key={candidate.id}
          className="rounded-2xl border border-amber-200 bg-amber-50/60 p-4"
        >
          <div className="flex flex-wrap gap-2 text-[11px] text-amber-800">
            <span>Legacy v{candidate.pipelineVersion || 2}</span>
            <span>
              {TYPE_LABELS[candidate.assertionType] || candidate.assertionType}
            </span>
            <span>{candidate.reviewStatus}</span>
          </div>
          <p className="mt-2 text-sm leading-6 text-slate-800">
            {candidate.statement}
          </p>
          <p className="mt-2 text-xs text-slate-500">
            Chat {candidate.sourceChatIds?.join(", ") || "-"}
          </p>
        </article>
      ))}
    </div>
  );
}

function ExtractionStatus({ state, busyId, onRetry }) {
  const activeJobs = (state.jobs || []).filter((job) =>
    ["pending", "running", "retry_wait", "failed", "budget_blocked"].includes(
      job.status
    )
  );
  return (
    <div className="rounded-2xl border border-[color:var(--overview-glass-border)] bg-white/40 p-4">
      <div className="flex flex-wrap gap-4 text-xs text-[color:var(--overview-text-secondary)]">
        <span>
          待处理轮次{" "}
          {state.threads?.reduce(
            (sum, row) => sum + Number(row.pendingTurnCount || 0),
            0
          ) || 0}
        </span>
        <span>活动/失败任务 {activeJobs.length}</span>
        <span>
          粗筛聚合 {state.aggregation?.groupProgress || 0}/
          {state.aggregation?.groupSize || 3}
        </span>
        <span>待聚合结果 {state.aggregation?.readyCount || 0}</span>
        <span>静默阈值 10 分钟</span>
      </div>
      {activeJobs.length > 0 && (
        <div className="mt-3 space-y-2">
          {activeJobs.slice(0, 10).map((job) => (
            <div
              key={job.id}
              className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200/80 px-3 py-2 text-xs"
            >
              <span>Job #{job.id}</span>
              <span>v{job.pipelineVersion || 2}</span>
              <span>{job.jobType || job.pipeline}</span>
              {job.partialGroup && <span>部分精筛</span>}
              {job.roughResultIds?.length > 0 && (
                <span>Rough #{job.roughResultIds.join(", #")}</span>
              )}
              <span>{job.phase}</span>
              <span>{job.status}</span>
              <span>
                {job.attemptCount}/{job.maxAttempts}
              </span>
              {job.errorCode && (
                <span className="text-rose-700">{job.errorCode}</span>
              )}
              {job.metadata?.assistantEvidenceDeferred && (
                <span className="text-amber-700">AI 证据因预算延后</span>
              )}
              {Number(job.tokenUsage?.totalTokens || 0) > 0 && (
                <span>
                  Token {job.tokenUsage.promptTokens || 0}+
                  {job.tokenUsage.completionTokens || 0}=
                  {job.tokenUsage.totalTokens || 0}
                </span>
              )}
              {job.attempts?.length > 0 &&
                (() => {
                  const attempt = job.attempts[job.attempts.length - 1];
                  return (
                    <span>
                      最近调用 {attempt.stage} · {attempt.model || "-"} · 预算
                      {attempt.budgetDecision || "allowed"} · 预估输入
                      {attempt.estimatedPromptTokens || 0} · 实际
                      {attempt.promptTokens || 0}/
                      {attempt.completionTokens || 0}· Thinking{" "}
                      {attempt.thinkingMode || "disabled"} · Finish
                      {attempt.finishReason || "-"} · Reasoning
                      {attempt.reasoningTokens || 0}
                    </span>
                  );
                })()}
              {["failed", "budget_blocked"].includes(job.status) && (
                <SmallButton
                  disabled={busyId === `job:${job.id}`}
                  onClick={() => onRetry(job)}
                >
                  {job.status === "budget_blocked"
                    ? "授权一次高成本重试"
                    : "手动重试"}
                </SmallButton>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CandidatesTab({
  assertions,
  positions,
  busyId,
  onConfirm,
  onReject,
  onConfirmAssertion,
  onRejectAssertion,
  onEditAssertion,
  onSplitAssertion,
  canManageShared,
  currentUserId,
}) {
  const positionedAssertionIds = new Set(
    positions.map((position) => Number(position.assertionId))
  );
  const standaloneAssertions = assertions.filter(
    (assertion) =>
      assertion.verificationStatus === "candidate" &&
      !positionedAssertionIds.has(Number(assertion.id))
  );
  if (!positions.length && !standaloneAssertions.length)
    return <SectionEmpty>暂无需要确认的认知候选。</SectionEmpty>;
  return (
    <div className="space-y-3">
      {positions.map((position) => {
        const assertion = itemById(assertions, position.assertionId);
        return (
          <CognitiveItem
            key={position.id}
            assertion={assertion}
            actions={
              <>
                <SmallButton
                  tone="primary"
                  disabled={busyId === `position:${position.id}`}
                  onClick={() => onConfirm(position)}
                >
                  <span className="inline-flex items-center gap-1">
                    <Check size={13} /> 确认是我的观点
                  </span>
                </SmallButton>
                <SmallButton
                  disabled={busyId === `assertion:${assertion?.id}`}
                  onClick={() => onSplitAssertion(assertion, position)}
                >
                  拆分
                </SmallButton>
                <SmallButton
                  tone="danger"
                  disabled={busyId === `position:${position.id}`}
                  onClick={() => onReject(position)}
                >
                  <span className="inline-flex items-center gap-1">
                    <X size={13} /> 不是我的观点
                  </span>
                </SmallButton>
              </>
            }
          >
            <p className="mt-2 text-xs text-[color:var(--overview-text-secondary)]">
              立场：{position.stance} {position.rationale || ""}
            </p>
          </CognitiveItem>
        );
      })}
      {standaloneAssertions.map((assertion) => {
        const canEdit =
          canManageShared ||
          (currentUserId &&
            Number(assertion.createdByUserId) === Number(currentUserId));
        return (
          <CognitiveItem
            key={`assertion-${assertion.id}`}
            assertion={assertion}
            actions={
              <>
                {canManageShared && (
                  <SmallButton
                    tone="primary"
                    disabled={busyId === `assertion:${assertion.id}`}
                    onClick={() => onConfirmAssertion(assertion)}
                  >
                    确认为共享认知
                  </SmallButton>
                )}
                {canEdit && (
                  <>
                    <SmallButton
                      disabled={busyId === `assertion:${assertion.id}`}
                      onClick={() => onEditAssertion(assertion)}
                    >
                      修改
                    </SmallButton>
                    <SmallButton
                      disabled={busyId === `assertion:${assertion.id}`}
                      onClick={() => onSplitAssertion(assertion)}
                    >
                      拆分
                    </SmallButton>
                    <SmallButton
                      tone="danger"
                      disabled={busyId === `assertion:${assertion.id}`}
                      onClick={() => onRejectAssertion(assertion)}
                    >
                      拒绝
                    </SmallButton>
                  </>
                )}
              </>
            }
          >
            <p className="mt-2 text-xs text-[color:var(--overview-text-secondary)]">
              来源：{assertion.createdByType} · 候选不会自动进入正式 Profile
            </p>
          </CognitiveItem>
        );
      })}
    </div>
  );
}

function PositionsTab({
  assertions,
  positions,
  busyId,
  onApproveMeeting,
  currentUserId,
  singleUserMode,
}) {
  if (!positions.length)
    return <SectionEmpty>暂无已确认用户观点。</SectionEmpty>;
  return (
    <div className="space-y-3">
      {positions.map((position) => {
        const ownsPosition =
          singleUserMode ||
          (currentUserId &&
            Number(position.subjectUserId) === Number(currentUserId));
        return (
          <CognitiveItem
            key={position.id}
            assertion={itemById(assertions, position.assertionId)}
            actions={
              ownsPosition ? (
                <DisclosureSelect
                  value={position.meetingDisclosure}
                  disabled={busyId === `position:${position.id}`}
                  onChange={(value) => onApproveMeeting(position, value)}
                />
              ) : (
                <span className="text-xs text-[color:var(--overview-text-secondary)]">
                  仅观点本人可设置会议披露
                </span>
              )
            }
          >
            <p className="mt-2 text-xs text-[color:var(--overview-text-secondary)]">
              用户 #{position.subjectUserId} · {position.stance}
            </p>
          </CognitiveItem>
        );
      })}
    </div>
  );
}

function DisputesTab({
  relations,
  assertions,
  draft,
  setDraft,
  busy,
  onCreate,
}) {
  const conflicts = relations.filter(
    (item) => item.relationType === "conflicts_with"
  );
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-[color:var(--overview-glass-border)] bg-white/40 p-3">
        <input
          value={draft.left}
          onChange={(event) =>
            setDraft((value) => ({ ...value, left: event.target.value }))
          }
          placeholder="认知项 A ID"
          className="w-32 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900"
        />
        <span className="text-xs text-[color:var(--overview-text-secondary)]">
          与
        </span>
        <input
          value={draft.right}
          onChange={(event) =>
            setDraft((value) => ({ ...value, right: event.target.value }))
          }
          placeholder="认知项 B ID"
          className="w-32 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900"
        />
        <SmallButton disabled={busy} onClick={onCreate}>
          建立冲突关系
        </SmallButton>
      </div>
      {!conflicts.length && <SectionEmpty>暂无结构化争议。</SectionEmpty>}
      {conflicts.map((relation) => (
        <div
          key={relation.id}
          className="rounded-2xl border border-amber-300/70 bg-amber-50/50 p-4 text-sm"
        >
          <p>{itemById(assertions, relation.fromAssertionId)?.statement}</p>
          <p className="my-2 text-xs font-semibold text-amber-700">
            与下列命题冲突
          </p>
          <p>{itemById(assertions, relation.toAssertionId)?.statement}</p>
        </div>
      ))}
    </div>
  );
}

function AssertionList({ assertions }) {
  if (!assertions.length) return <SectionEmpty />;
  return (
    <div className="space-y-3">
      {assertions.map((item) => (
        <CognitiveItem key={item.id} assertion={item} />
      ))}
    </div>
  );
}

function AccountMemoryTab({
  memories,
  selectedIds,
  setSelectedIds,
  loading,
  importing,
  onImport,
}) {
  function toggle(id) {
    setSelectedIds((values) =>
      values.includes(id)
        ? values.filter((value) => value !== id)
        : [...values, id]
    );
  }
  if (loading) return <SectionEmpty>正在读取账号长期记忆…</SectionEmpty>;
  return (
    <div className="space-y-3">
      <div className="rounded-2xl border border-amber-200 bg-amber-50/60 p-4 text-xs leading-5 text-amber-900">
        账号长期记忆不会自动进入 Workspace
        Delegate。只有你选择的项目会以候选形式导入，仍需再次确认。
      </div>
      {memories.length ? (
        memories.map((memory) => (
          <label
            key={memory.id}
            className="flex cursor-pointer gap-3 rounded-xl border border-[color:var(--overview-glass-border)] bg-white/40 p-3"
          >
            <input
              type="checkbox"
              checked={selectedIds.includes(memory.id)}
              onChange={() => toggle(memory.id)}
            />
            <span className="min-w-0">
              <span className="block text-xs font-semibold text-[color:var(--overview-text-primary)]">
                {memory.title || memory.category || `记忆 #${memory.id}`}
              </span>
              <span className="mt-1 block line-clamp-2 text-xs text-[color:var(--overview-text-secondary)]">
                {memory.detail || memory.content || ""}
              </span>
            </span>
          </label>
        ))
      ) : (
        <SectionEmpty>没有可导入的账号长期记忆。</SectionEmpty>
      )}
      <SmallButton
        tone="primary"
        disabled={importing || !selectedIds.length}
        onClick={onImport}
      >
        {importing ? "正在导入…" : `导入 ${selectedIds.length} 项为候选`}
      </SmallButton>
    </div>
  );
}

function BackfillTab({
  threads,
  selectedSlugs,
  setSelectedSlugs,
  busy,
  onBackfill,
  busyId,
  onToggleArchive,
}) {
  function toggle(slug) {
    setSelectedSlugs((values) =>
      values.includes(slug)
        ? values.filter((value) => value !== slug)
        : [...values, slug]
    );
  }
  return (
    <div className="rounded-2xl border border-[color:var(--overview-glass-border)] bg-white/40 p-5">
      <div className="flex items-center gap-2 text-sm font-semibold text-[color:var(--overview-text-primary)]">
        <FileText size={18} /> 按需回填历史线程
      </div>
      <p className="mt-2 text-xs leading-5 text-[color:var(--overview-text-secondary)]">
        原始聊天是主要来源；Conversation State Capsule
        只用于定位，不会成为事实引用。回填结果全部进入候选区。
      </p>
      <div className="my-4 max-h-56 space-y-2 overflow-y-auto">
        {threads.map((thread) => (
          <div
            key={thread.slug}
            className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white/50 px-3 py-2 text-xs text-[color:var(--overview-text-primary)]"
          >
            <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={selectedSlugs.includes(thread.slug)}
                onChange={() => toggle(thread.slug)}
              />
              <span className="truncate">
                {thread.name || thread.title || thread.slug}
              </span>
              {thread.archivedAt && (
                <span className="text-amber-700">已归档</span>
              )}
            </label>
            <SmallButton
              disabled={busyId === `archive:${thread.slug}`}
              onClick={() => onToggleArchive(thread)}
            >
              {thread.archivedAt ? "恢复" : "归档"}
            </SmallButton>
          </div>
        ))}
        {!threads.length && <SectionEmpty>没有可回填的历史线程。</SectionEmpty>}
      </div>
      <SmallButton
        tone="primary"
        disabled={!selectedSlugs.length || busy}
        onClick={onBackfill}
      >
        {busy ? "正在回填…" : `提取 ${selectedSlugs.length} 个线程`}
      </SmallButton>
    </div>
  );
}

function LedgerTab({ ledger, view, setView }) {
  const visible = (ledger.items || []).filter(
    (item) => view === "history" || item.active
  );
  return (
    <div>
      <div className="mb-3 flex gap-2">
        {[
          ["current", "当前有效认知"],
          ["history", "完整历史版本"],
        ].map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setView(key)}
            className={`rounded-lg px-3 py-1.5 text-xs ${
              view === key
                ? "bg-sky-600 text-white"
                : "overview-glass-pill text-[color:var(--overview-text-primary)]"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {!visible.length ? (
        <SectionEmpty>暂无正式认知账本记录。</SectionEmpty>
      ) : (
        <div className="space-y-2">
          {visible.map((item) => {
            const outgoing = (ledger.relations || []).filter(
              (relation) => relation.fromItemId === item.id
            );
            return (
              <div
                key={item.id}
                className="rounded-2xl border border-[color:var(--overview-glass-border)] bg-white/40 p-4"
              >
                <div className="flex flex-wrap gap-2 text-[11px] text-[color:var(--overview-text-secondary)]">
                  <span>
                    {TYPE_LABELS[item.assertionType] || item.assertionType}
                  </span>
                  <span>version {item.version}</span>
                  <span>{item.active ? "当前有效" : "历史保留"}</span>
                  {item.isTemporary && <span>temporary</span>}
                  <span>itemKey {item.itemKey}</span>
                </div>
                <p className="mt-2 text-sm leading-6 text-[color:var(--overview-text-primary)]">
                  {item.statement}
                </p>
                {outgoing.length > 0 && (
                  <p className="mt-2 text-xs text-[color:var(--overview-text-secondary)]">
                    {outgoing
                      .map(
                        (relation) =>
                          `${relation.relationType} → #${relation.toItemId}`
                      )
                      .join("；")}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function EvidenceTab({
  evidence,
  assertions,
  busyId,
  onApproveMeeting,
  canManageShared,
}) {
  if (!evidence.length) return <SectionEmpty>暂无证据账本记录。</SectionEmpty>;
  return (
    <div className="space-y-3">
      {evidence.map((item) => (
        <div
          key={item.id}
          className="rounded-2xl border border-[color:var(--overview-glass-border)] bg-white/40 p-4"
        >
          <div className="flex flex-wrap gap-2 text-[11px] text-[color:var(--overview-text-secondary)]">
            <span>{item.sourceType}</span>
            <span>{item.evidenceKind}</span>
            <span>{item.freshness}</span>
          </div>
          <p className="mt-2 text-xs font-medium text-[color:var(--overview-text-primary)]">
            {itemById(assertions, item.assertionId)?.statement}
          </p>
          {item.excerpt && (
            <p className="mt-2 line-clamp-3 text-xs leading-5 text-[color:var(--overview-text-secondary)]">
              {item.excerpt}
            </p>
          )}
          <div className="mt-3">
            {item.sourceType === "thread_capsule_origin" ? (
              <span className="text-xs text-amber-700">
                Capsule 仅可定位，禁止作为会议事实证据
              </span>
            ) : (
              <DisclosureSelect
                value={item.disclosureLevel}
                disabled={!canManageShared || busyId === `evidence:${item.id}`}
                onChange={(value) => onApproveMeeting(item, value)}
              />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function MeetingsTab({
  assertions,
  positions,
  packets,
  draft,
  setDraft,
  busyId,
  onApproveAssertion,
  onCreate,
  onStart,
  onRevoke,
}) {
  const formal = assertions.filter((item) =>
    ["source_backed", "user_confirmed", "contested"].includes(
      item.verificationStatus
    )
  );
  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-[color:var(--overview-glass-border)] bg-white/40 p-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-[color:var(--overview-text-primary)]">
          <Gavel size={18} /> 创建冻结 Meeting Packet
        </div>
        <p className="mt-2 text-xs leading-5 text-[color:var(--overview-text-secondary)]">
          下方会自动收集已批准披露的正式认知、本人观点和证据。未批准或 blocked
          内容不会进入快照。
        </p>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <input
            value={draft.title}
            onChange={(event) =>
              setDraft((value) => ({ ...value, title: event.target.value }))
            }
            placeholder="会议名称"
            className="rounded-xl border border-slate-300 bg-white/70 px-3 py-2 text-sm text-slate-900"
          />
          <input
            value={draft.documentIds}
            onChange={(event) =>
              setDraft((value) => ({
                ...value,
                documentIds: event.target.value,
              }))
            }
            placeholder="实时检索白名单 docId，以逗号分隔"
            className="rounded-xl border border-slate-300 bg-white/70 px-3 py-2 text-sm text-slate-900"
          />
          <input
            value={draft.documentPathPrefixes}
            onChange={(event) =>
              setDraft((value) => ({
                ...value,
                documentPathPrefixes: event.target.value,
              }))
            }
            placeholder="允许的资料目录前缀，以逗号分隔"
            className="rounded-xl border border-slate-300 bg-white/70 px-3 py-2 text-sm text-slate-900"
          />
          <input
            value={draft.knowledgeNodeKeys}
            onChange={(event) =>
              setDraft((value) => ({
                ...value,
                knowledgeNodeKeys: event.target.value,
              }))
            }
            placeholder="允许的知识节点 key，以逗号分隔"
            className="rounded-xl border border-slate-300 bg-white/70 px-3 py-2 text-sm text-slate-900"
          />
          <textarea
            value={draft.objective}
            onChange={(event) =>
              setDraft((value) => ({ ...value, objective: event.target.value }))
            }
            placeholder="会议目标"
            className="min-h-20 rounded-xl border border-slate-300 bg-white/70 px-3 py-2 text-sm text-slate-900 md:col-span-2"
          />
          <textarea
            value={draft.redactionTerms}
            onChange={(event) =>
              setDraft((value) => ({
                ...value,
                redactionTerms: event.target.value,
              }))
            }
            placeholder="自定义脱敏词，每行一个；邮箱和手机号默认脱敏"
            className="min-h-16 rounded-xl border border-slate-300 bg-white/70 px-3 py-2 text-sm text-slate-900 md:col-span-2"
          />
        </div>
        <label className="mt-4 flex items-center gap-2 text-xs font-medium text-[color:var(--overview-text-primary)]">
          <input
            type="checkbox"
            checked={draft.authorizationEnabled}
            onChange={(event) =>
              setDraft((value) => ({
                ...value,
                authorizationEnabled: event.target.checked,
              }))
            }
          />
          添加有限承诺授权
        </label>
        {draft.authorizationEnabled && (
          <div className="mt-3 grid gap-3 rounded-xl border border-amber-200 bg-amber-50/60 p-3 md:grid-cols-3">
            <input
              value={draft.actionType}
              onChange={(event) =>
                setDraft((value) => ({
                  ...value,
                  actionType: event.target.value,
                }))
              }
              placeholder="承诺类型，如 delivery_date"
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900"
            />
            <input
              value={draft.allowedTargets}
              onChange={(event) =>
                setDraft((value) => ({
                  ...value,
                  allowedTargets: event.target.value,
                }))
              }
              placeholder="允许对象，以逗号分隔"
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 md:col-span-2"
            />
            <input
              type="number"
              min="0"
              value={draft.maxAmount}
              onChange={(event) =>
                setDraft((value) => ({
                  ...value,
                  maxAmount: event.target.value,
                }))
              }
              placeholder="金额上限"
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900"
            />
            <input
              type="number"
              min="0"
              value={draft.maxQuantity}
              onChange={(event) =>
                setDraft((value) => ({
                  ...value,
                  maxQuantity: event.target.value,
                }))
              }
              placeholder="数量上限"
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900"
            />
            <input
              type="number"
              min="0"
              value={draft.maxDurationMinutes}
              onChange={(event) =>
                setDraft((value) => ({
                  ...value,
                  maxDurationMinutes: event.target.value,
                }))
              }
              placeholder="时长上限（分钟）"
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900"
            />
            <label className="text-[11px] text-slate-600">
              最迟履约时间
              <input
                type="datetime-local"
                value={draft.latestDueAt}
                onChange={(event) =>
                  setDraft((value) => ({
                    ...value,
                    latestDueAt: event.target.value,
                  }))
                }
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900"
              />
            </label>
            <label className="text-[11px] text-slate-600">
              授权有效期
              <input
                type="datetime-local"
                value={draft.validUntil}
                onChange={(event) =>
                  setDraft((value) => ({
                    ...value,
                    validUntil: event.target.value,
                  }))
                }
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900"
              />
            </label>
            <div className="flex flex-col justify-end gap-2 pb-2 text-[11px] text-slate-700">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={draft.allowConditional}
                  onChange={(event) =>
                    setDraft((value) => ({
                      ...value,
                      allowConditional: event.target.checked,
                    }))
                  }
                />
                允许条件性承诺
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={draft.requiresSecondApproval}
                  onChange={(event) =>
                    setDraft((value) => ({
                      ...value,
                      requiresSecondApproval: event.target.checked,
                    }))
                  }
                />
                每次需要二次批准
              </label>
            </div>
          </div>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <SmallButton
            tone="primary"
            disabled={busyId === "meeting:create"}
            onClick={onCreate}
          >
            {busyId === "meeting:create" ? "正在冻结…" : "生成并冻结会议包"}
          </SmallButton>
          <span className="text-xs text-[color:var(--overview-text-secondary)]">
            正式认知 {formal.length} · 已确认观点 {positions.length}
          </span>
        </div>
      </div>
      <div>
        <h4 className="mb-2 text-xs font-semibold text-[color:var(--overview-text-primary)]">
          认知项会议披露
        </h4>
        <div className="flex flex-wrap gap-2">
          {formal.map((assertion) => (
            <div
              key={assertion.id}
              className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white/50 px-2 py-1"
            >
              <span className="text-xs text-[color:var(--overview-text-primary)]">
                #{assertion.id} {TYPE_LABELS[assertion.assertionType]}
              </span>
              <DisclosureSelect
                value={assertion.disclosureLevel}
                disabled={busyId === `assertion:${assertion.id}`}
                onChange={(value) => onApproveAssertion(assertion, value)}
              />
            </div>
          ))}
        </div>
      </div>
      <div className="space-y-3">
        {packets.length ? (
          packets.map((packet) => (
            <div
              key={packet.id}
              className="rounded-2xl border border-[color:var(--overview-glass-border)] bg-white/40 p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-[color:var(--overview-text-primary)]">
                    {packet.title}
                  </p>
                  <p className="text-xs text-[color:var(--overview-text-secondary)]">
                    revision {packet.revision} · {packet.status}{" "}
                    {packet.contentHash
                      ? `· ${packet.contentHash.slice(0, 12)}`
                      : ""}
                  </p>
                </div>
                {packet.status === "frozen" && (
                  <div className="flex gap-2">
                    <SmallButton
                      tone="primary"
                      disabled={busyId === `packet:${packet.id}`}
                      onClick={() => onStart(packet)}
                    >
                      启动会议代表
                    </SmallButton>
                    <SmallButton
                      tone="danger"
                      disabled={busyId === `packet:revoke:${packet.id}`}
                      onClick={() => onRevoke(packet)}
                    >
                      撤销
                    </SmallButton>
                  </div>
                )}
              </div>
            </div>
          ))
        ) : (
          <SectionEmpty>还没有 Meeting Packet。</SectionEmpty>
        )}
      </div>
    </div>
  );
}

function MeetingSessionModal({ workspace, state, setState, onClose }) {
  async function refreshAudit() {
    const result = await WorkspaceCognition.meetingAudit(
      workspace.slug,
      state.id
    );
    if (result.success) {
      setState((value) => ({ ...value, audit: result.audit || [] }));
    }
  }

  async function send() {
    const message = state.input.trim();
    if (!message || state.sending) return;
    if (state.commitmentEnabled && !state.commitmentActionType.trim()) {
      showToast("提出承诺时必须填写承诺类型。", "warning", { clear: true });
      return;
    }
    setState((value) => ({
      ...value,
      input: "",
      sending: true,
      messages: [...value.messages, { role: "user", text: message }],
    }));
    let assistantText = "";
    const commitmentProposal = state.commitmentEnabled
      ? {
          actionType: state.commitmentActionType.trim(),
          target: state.commitmentTarget.trim() || null,
          amount: state.commitmentAmount || null,
          quantity: state.commitmentQuantity || null,
          durationMinutes: state.commitmentDurationMinutes || null,
          dueAt: state.commitmentDueAt || null,
          conditional: state.commitmentConditional,
        }
      : null;
    await WorkspaceCognition.streamMeetingSession({
      slug: workspace.slug,
      sessionId: state.id,
      body: {
        message,
        liveRetrieve: {
          enabled: state.liveEnabled,
          query: state.liveQuery.trim() || message,
          documentIds: state.liveDocumentIds
            .split(/[，,\s]+/)
            .map((item) => item.trim())
            .filter(Boolean),
        },
        commitmentProposal,
      },
      async onMessage(event) {
        if (event.type === "toolApprovalRequest") {
          const approved = window.confirm(
            event.description || "会议代表请求额外授权，是否批准？"
          );
          await WorkspaceCognition.respondMeetingApproval(
            workspace.slug,
            state.id,
            event.requestId,
            approved
          );
          return;
        }
        if (event.type === "textResponseChunk")
          assistantText += event.textResponse || "";
        if (event.type === "meetingStatement")
          setState((value) => ({ ...value, metadata: event.metadata || null }));
        if (event.type === "finalizeResponseStream") {
          setState((value) => ({
            ...value,
            sending: false,
            messages: [
              ...value.messages,
              { role: "assistant", text: assistantText },
            ],
          }));
          refreshAudit();
        }
        if (event.type === "abort") {
          setState((value) => ({
            ...value,
            sending: false,
            messages: [
              ...value.messages,
              { role: "assistant", text: event.error || "会议发言失败" },
            ],
          }));
        }
      },
      onError(error) {
        setState((value) => ({
          ...value,
          sending: false,
          messages: [
            ...value.messages,
            { role: "assistant", text: error.message },
          ],
        }));
      },
    });
  }
  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/55 p-4"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div className="flex max-h-[86vh] w-full max-w-3xl flex-col rounded-3xl bg-white p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 pb-4">
          <div>
            <h3 className="font-semibold text-slate-900">
              Meeting Delegate · {state.packet.title}
            </h3>
            <p className="mt-1 text-xs text-slate-500">
              冻结哈希 {state.packet.contentHash?.slice(0, 16)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-2 text-slate-500 hover:bg-slate-100"
          >
            <X size={18} />
          </button>
        </div>
        <div className="min-h-48 flex-1 space-y-3 overflow-y-auto py-4">
          {state.messages.length ? (
            state.messages.map((message, index) => (
              <div
                key={`${message.role}-${index}`}
                className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-6 ${message.role === "user" ? "ml-auto bg-sky-600 text-white" : "bg-slate-100 text-slate-800"}`}
              >
                {message.text}
              </div>
            ))
          ) : (
            <SectionEmpty>
              输入会议问题，Delegate 只会使用冻结快照和获准资料。
            </SectionEmpty>
          )}
          {state.sending && (
            <p className="text-xs text-slate-500">会议代表正在组织发言…</p>
          )}
        </div>
        {state.metadata && (
          <div className="mb-3 rounded-xl bg-slate-50 px-3 py-2 text-[11px] text-slate-600">
            类型 {state.metadata.statementType} · 可信度{" "}
            {Math.round(Number(state.metadata.confidence || 0) * 100)}% · 证据{" "}
            {state.metadata.evidenceRefs?.length || 0}
          </div>
        )}
        <details className="mb-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
          <summary className="cursor-pointer text-xs font-medium text-slate-700">
            受控实时检索与有限承诺
          </summary>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <label className="flex items-center gap-2 text-xs text-slate-700">
              <input
                type="checkbox"
                checked={state.liveEnabled}
                onChange={(event) =>
                  setState((value) => ({
                    ...value,
                    liveEnabled: event.target.checked,
                  }))
                }
              />
              本轮启用实时检索
            </label>
            <input
              value={state.liveDocumentIds}
              onChange={(event) =>
                setState((value) => ({
                  ...value,
                  liveDocumentIds: event.target.value,
                }))
              }
              placeholder="本轮 docId（白名单外会请求批准）"
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900"
            />
            <input
              value={state.liveQuery}
              onChange={(event) =>
                setState((value) => ({
                  ...value,
                  liveQuery: event.target.value,
                }))
              }
              placeholder="检索查询，留空则使用会议问题"
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 md:col-span-2"
            />
            <label className="flex items-center gap-2 text-xs text-slate-700 md:col-span-2">
              <input
                type="checkbox"
                checked={state.commitmentEnabled}
                onChange={(event) =>
                  setState((value) => ({
                    ...value,
                    commitmentEnabled: event.target.checked,
                  }))
                }
              />
              本轮提出承诺（由服务端授权策略校验）
            </label>
            {state.commitmentEnabled && (
              <>
                <input
                  value={state.commitmentActionType}
                  onChange={(event) =>
                    setState((value) => ({
                      ...value,
                      commitmentActionType: event.target.value,
                    }))
                  }
                  placeholder="承诺类型"
                  className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900"
                />
                <input
                  value={state.commitmentTarget}
                  onChange={(event) =>
                    setState((value) => ({
                      ...value,
                      commitmentTarget: event.target.value,
                    }))
                  }
                  placeholder="承诺对象"
                  className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900"
                />
                <input
                  type="number"
                  min="0"
                  value={state.commitmentAmount}
                  onChange={(event) =>
                    setState((value) => ({
                      ...value,
                      commitmentAmount: event.target.value,
                    }))
                  }
                  placeholder="金额"
                  className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900"
                />
                <input
                  type="number"
                  min="0"
                  value={state.commitmentQuantity}
                  onChange={(event) =>
                    setState((value) => ({
                      ...value,
                      commitmentQuantity: event.target.value,
                    }))
                  }
                  placeholder="数量"
                  className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900"
                />
                <input
                  type="number"
                  min="0"
                  value={state.commitmentDurationMinutes}
                  onChange={(event) =>
                    setState((value) => ({
                      ...value,
                      commitmentDurationMinutes: event.target.value,
                    }))
                  }
                  placeholder="时长（分钟）"
                  className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900"
                />
                <input
                  type="datetime-local"
                  value={state.commitmentDueAt}
                  onChange={(event) =>
                    setState((value) => ({
                      ...value,
                      commitmentDueAt: event.target.value,
                    }))
                  }
                  className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900"
                />
                <label className="flex items-center gap-2 text-xs text-slate-700 md:col-span-2">
                  <input
                    type="checkbox"
                    checked={state.commitmentConditional}
                    onChange={(event) =>
                      setState((value) => ({
                        ...value,
                        commitmentConditional: event.target.checked,
                      }))
                    }
                  />
                  条件性承诺
                </label>
              </>
            )}
          </div>
        </details>
        <div className="mb-3 flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2 text-[11px] text-slate-600">
          <span>审计事件 {state.audit.length}</span>
          <SmallButton onClick={refreshAudit}>刷新审计</SmallButton>
        </div>
        <div className="flex gap-2 border-t border-slate-200 pt-4">
          <textarea
            value={state.input}
            onChange={(event) =>
              setState((value) => ({ ...value, input: event.target.value }))
            }
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                send();
              }
            }}
            placeholder="输入会议发言或问题"
            className="min-h-12 flex-1 rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-900"
          />
          <SmallButton
            tone="primary"
            disabled={state.sending || !state.input.trim()}
            onClick={send}
          >
            发送
          </SmallButton>
        </div>
      </div>
    </div>
  );
}
