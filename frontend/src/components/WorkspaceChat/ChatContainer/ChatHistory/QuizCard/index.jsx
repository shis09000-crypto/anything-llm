import { useEffect, useMemo, useRef, useState } from "react";
import { CircleNotch, Star, XCircle } from "@phosphor-icons/react";
import Workspace from "@/models/workspace";
import { useChatThreadDrafts } from "@/contexts/ChatThreadDraftProvider";
import showToast from "@/utils/toast";

function mergeQuestions(existing = [], incoming = []) {
  const byId = new Map();
  for (const question of [...existing, ...incoming]) {
    if (!question?.id) continue;
    byId.set(question.id, { ...(byId.get(question.id) || {}), ...question });
  }
  return [...byId.values()];
}

function progressVersionOf(quiz = {}) {
  return Number(quiz?.progress?.progressVersion ?? quiz?.progressVersion ?? 0);
}

function progressOf(quiz = {}) {
  return {
    answers: quiz?.progress?.answers || quiz?.answers || {},
    currentIndex: Number.isFinite(
      Number(quiz?.progress?.currentIndex ?? quiz?.currentIndex)
    )
      ? Number(quiz?.progress?.currentIndex ?? quiz?.currentIndex)
      : 0,
    progressVersion: progressVersionOf(quiz),
    updatedAt: quiz?.progress?.updatedAt || quiz?.progressUpdatedAt || null,
  };
}

function mergeQuiz(previous, next, { preserveLocalProgress = true } = {}) {
  if (!next) return previous;
  const previousProgress = progressOf(previous || {});
  const nextProgress = progressOf(next || {});
  const shouldUseNextProgress =
    !preserveLocalProgress ||
    !previous ||
    nextProgress.progressVersion > previousProgress.progressVersion;
  const progress = shouldUseNextProgress ? nextProgress : previousProgress;
  return {
    ...previous,
    ...next,
    answers: progress.answers || {},
    currentIndex: progress.currentIndex || 0,
    progress,
    questions: mergeQuestions(previous?.questions || [], next.questions || []),
  };
}

function isGenerating(quiz = {}) {
  if (quiz.abandoned) return false;
  return (quiz.pendingTypes || []).length > 0;
}

function formatAnswer(answer, question = {}) {
  if (answer === undefined || answer === null || answer === "") return "未作答";
  const options = new Map(
    (question.options || []).map((item) => [item.id, item])
  );
  const renderOne = (value) => {
    const option = options.get(value);
    return option ? `${option.id}. ${option.text}` : String(value);
  };
  if (Array.isArray(answer)) return answer.map(renderOne).join("；");
  return renderOne(answer);
}

function answerIds(answer) {
  if (answer === undefined || answer === null || answer === "") return [];
  if (Array.isArray(answer)) return answer.map((value) => String(value));
  return [String(answer)];
}

function correctAnswerIds(question = {}, result = null) {
  const answer = result?.correctAnswer ?? question.correctAnswer;
  if (Array.isArray(answer)) return answer.map((value) => String(value));
  if (answer && typeof answer === "object") {
    if (Array.isArray(answer.answers))
      return answer.answers.map((value) => String(value));
    if (Array.isArray(answer.optionIds))
      return answer.optionIds.map((value) => String(value));
    if (answer.id) return [String(answer.id)];
  }
  if (answer === undefined || answer === null || answer === "") return [];
  return [String(answer)];
}
const quizSurfaceClass =
  "w-full rounded-[28px] border border-sky-100/70 bg-white/95 backdrop-blur-xl p-4 text-slate-900 shadow-[0_24px_70px_rgba(148,163,184,0.16),0_0_36px_rgba(186,230,253,0.12),inset_0_1px_0_rgba(255,255,255,0.98)]";
const quizCardAtmosphereSvg = encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="980" viewBox="0 0 1600 980">
  <defs>
    <radialGradient id="centerGlow" cx="50%" cy="42%" r="68%">
      <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.96"/>
      <stop offset="48%" stop-color="#F8FCFF" stop-opacity="0.72"/>
      <stop offset="100%" stop-color="#E0F2FE" stop-opacity="0.52"/>
    </radialGradient>
    <radialGradient id="skyBloomLeft" cx="12%" cy="18%" r="42%">
      <stop offset="0%" stop-color="#BAE6FD" stop-opacity="0.30"/>
      <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="skyBloomRight" cx="88%" cy="82%" r="42%">
      <stop offset="0%" stop-color="#BFDBFE" stop-opacity="0.24"/>
      <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/>
    </radialGradient>
    <pattern id="dotField" width="44" height="44" patternUnits="userSpaceOnUse">
      <circle cx="1.4" cy="1.4" r="1.15" fill="#0284C7" opacity="0.14"/>
      <circle cx="24" cy="29" r="0.8" fill="#38BDF8" opacity="0.12"/>
    </pattern>
    <pattern id="gridField" width="96" height="96" patternUnits="userSpaceOnUse">
      <path d="M96 0H0V96" fill="none" stroke="#38BDF8" stroke-width="1" stroke-opacity="0.08"/>
    </pattern>
    <linearGradient id="lineFade" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0%" stop-color="#7DD3FC" stop-opacity="0.07"/>
      <stop offset="48%" stop-color="#38BDF8" stop-opacity="0.22"/>
      <stop offset="100%" stop-color="#93C5FD" stop-opacity="0.07"/>
    </linearGradient>
  </defs>
  <rect width="1600" height="980" fill="url(#centerGlow)"/>
  <rect width="1600" height="980" fill="url(#skyBloomLeft)"/>
  <rect width="1600" height="980" fill="url(#skyBloomRight)"/>
  <rect width="1600" height="980" fill="url(#gridField)" opacity="0.60"/>
  <rect width="1600" height="980" fill="url(#dotField)" opacity="0.78"/>
  <g fill="none" stroke="url(#lineFade)" stroke-width="1.3">
    <path d="M190 168C330 112 430 128 560 212S820 328 990 246 1268 96 1414 154"/>
    <path d="M134 742C300 684 462 690 624 764S938 874 1128 782 1366 690 1480 724"/>
    <path d="M1160 158l116 68 134-36 70 90"/>
    <path d="M174 356l92 52 102-34 92 70"/>
    <path d="M512 540C644 456 770 450 900 520S1148 612 1288 522"/>
    <path d="M88 492C230 442 346 458 474 532"/>
  </g>
  <g fill="none" stroke="#0EA5E9" stroke-opacity="0.105" stroke-width="1">
    <circle cx="1250" cy="276" r="78"/>
    <circle cx="1250" cy="276" r="124"/>
    <path d="M320 206h108v108H320z" transform="rotate(-9 374 260)"/>
    <path d="M1038 662h146v146h-146z" transform="rotate(12 1111 735)"/>
  </g>
  <g fill="none" stroke="#0284C7" stroke-linecap="round" stroke-linejoin="round" opacity="0.13">
    <g transform="translate(1030 112) rotate(-10)">
      <path d="M0 38L32 18L66 38L66 76L32 96L0 76Z" stroke-width="2"/>
      <path d="M8 41L32 26L57 41M57 73L32 88L8 73" stroke-width="1.2"/>
      <path d="M66 38L104 16M66 76L104 98" stroke-width="1.5"/>
      <text x="110" y="18" font-size="19" fill="#0369A1" opacity="0.92">OH</text>
      <text x="110" y="106" font-size="19" fill="#0369A1" opacity="0.92">NH₂</text>
    </g>
    <g transform="translate(178 700) rotate(8)">
      <path d="M0 44L36 24L72 44L72 84L36 104L0 84Z" stroke-width="2"/>
      <path d="M72 44L112 20L154 44L154 84L112 108L72 84" stroke-width="1.6"/>
      <path d="M154 44L196 24M154 84L196 106" stroke-width="1.5"/>
      <text x="202" y="27" font-size="18" fill="#0369A1" opacity="0.9">CH₃</text>
      <text x="202" y="113" font-size="18" fill="#0369A1" opacity="0.9">O</text>
    </g>
    <g transform="translate(1188 600) rotate(-7)">
      <path d="M0 70C36 18 74 18 110 70S184 122 220 70" stroke-width="1.8"/>
      <path d="M0 110C36 162 74 162 110 110S184 58 220 110" stroke-width="1.8"/>
      <path d="M34 43L60 137M86 43L112 137M138 137L164 43M190 137L216 43" stroke-width="1"/>
    </g>
  </g>
  <g font-family="-apple-system,BlinkMacSystemFont,'SF Pro Display','Inter','Segoe UI',sans-serif" font-weight="500" fill="#0369A1">
    <text x="132" y="142" font-size="42" opacity="0.105" transform="rotate(-10 132 142)">∑</text>
    <text x="402" y="256" font-size="34" opacity="0.092" transform="rotate(7 402 256)">∫</text>
    <text x="704" y="128" font-size="36" opacity="0.096" transform="rotate(-5 704 128)">π</text>
    <text x="1184" y="172" font-size="38" opacity="0.092" transform="rotate(9 1184 172)">√</text>
    <text x="1394" y="392" font-size="34" opacity="0.088" transform="rotate(-8 1394 392)">λ</text>
    <text x="236" y="642" font-size="36" opacity="0.088" transform="rotate(8 236 642)">Δ</text>
    <text x="690" y="808" font-size="38" opacity="0.096" transform="rotate(-7 690 808)">θ</text>
    <text x="1278" y="756" font-size="32" opacity="0.076" transform="rotate(6 1278 756)">∂</text>
    <text x="958" y="340" font-size="30" opacity="0.070" transform="rotate(-12 958 340)">∞</text>
  </g>
  <g font-family="-apple-system,BlinkMacSystemFont,'SF Pro Text','Inter','Segoe UI',sans-serif" fill="#0369A1" font-size="20" font-weight="500">
    <text x="188" y="226" opacity="0.115" transform="rotate(-7 188 226)">E = mc²</text>
    <text x="520" y="170" opacity="0.098" transform="rotate(5 520 170)">PV = nRT</text>
    <text x="806" y="254" opacity="0.090" transform="rotate(-6 806 254)">∇·E = ρ/ε₀</text>
    <text x="1282" y="474" opacity="0.100" transform="rotate(7 1282 474)">λ = h / p</text>
    <text x="454" y="706" opacity="0.108" transform="rotate(-5 454 706)">ΔG = ΔH − TΔS</text>
    <text x="820" y="742" opacity="0.096" transform="rotate(6 820 742)">C₆H₁₂O₆ + 6O₂</text>
    <text x="102" y="444" opacity="0.090" transform="rotate(6 102 444)">∫ f(x) dx</text>
    <text x="1010" y="878" opacity="0.085" transform="rotate(-4 1010 878)">ATP + H₂O → ADP + Pi</text>
  </g>
</svg>
`);
const quizSurfaceStyle = {
  backgroundImage: `url("data:image/svg+xml,${quizCardAtmosphereSvg}"), radial-gradient(circle at 50% 42%, rgba(255,255,255,0.98) 0%, rgba(255,255,255,0.94) 38%, rgba(240,249,255,0.88) 74%, rgba(224,242,254,0.72) 100%)`,
  backgroundPosition: "center, center",
  backgroundRepeat: "no-repeat, no-repeat",
  backgroundSize: "cover, cover",
};
const quizPanelClass =
  "rounded-2xl border border-slate-200 bg-white shadow-[0_12px_32px_rgba(15,23,42,0.10),inset_0_1px_0_rgba(255,255,255,0.95)]";
const quizButtonBaseClass =
  "border rounded-2xl px-4 py-2.5 text-sm font-medium shadow-[0_10px_24px_rgba(15,23,42,0.10),inset_0_1px_0_rgba(255,255,255,0.95)] transition-all duration-200 hover:-translate-y-0.5 focus:outline-none focus:ring-2 focus:ring-sky-300/60 focus:ring-offset-2 focus:ring-offset-white disabled:opacity-40 disabled:hover:translate-y-0 disabled:hover:shadow-[0_10px_24px_rgba(15,23,42,0.10),inset_0_1px_0_rgba(255,255,255,0.95)]";
const quizButtonSecondaryClass = `${quizButtonBaseClass} border-slate-200 bg-white text-slate-700 hover:bg-slate-50`;
const quizButtonPrimaryClass = `${quizButtonBaseClass} border-sky-300/40 bg-sky-500 text-white font-semibold shadow-[0_12px_32px_rgba(14,165,233,0.28),0_0_22px_rgba(125,211,252,0.22),inset_0_1px_0_rgba(255,255,255,0.24)] hover:bg-sky-400 hover:shadow-[0_16px_42px_rgba(14,165,233,0.36),0_0_30px_rgba(125,211,252,0.28),inset_0_1px_0_rgba(255,255,255,0.28)] disabled:hover:bg-sky-500 disabled:hover:shadow-[0_12px_32px_rgba(14,165,233,0.28),0_0_22px_rgba(125,211,252,0.22),inset_0_1px_0_rgba(255,255,255,0.24)]`;
const quizIconButtonClass =
  "border border-slate-200 rounded-full bg-white p-1.5 text-slate-500 shadow-[0_8px_20px_rgba(15,23,42,0.10),inset_0_1px_0_rgba(255,255,255,0.95)] transition-all duration-200 hover:-translate-y-0.5 hover:text-red-500 hover:shadow-[0_12px_28px_rgba(15,23,42,0.14)]";

function questionTypeLabel(type) {
  return (
    {
      single_choice: "单选题",
      multiple_choice: "多选题",
      fill_blank: "填空题",
    }[type] || "题目"
  );
}

function difficultyLabel(difficulty) {
  return (
    {
      easy: "简单",
      medium: "中等",
      high: "困难",
      extreme: "极难",
    }[difficulty] ||
    difficulty ||
    "默认"
  );
}

export default function QuizCard({
  quiz: initialQuiz,
  workspace,
  chatKey,
  turnId,
}) {
  const [quiz, setQuiz] = useState(initialQuiz || {});
  const [answers, setAnswers] = useState(initialQuiz?.answers || {});
  const [currentIndex, setCurrentIndex] = useState(
    initialQuiz?.currentIndex || 0
  );
  const [submitting, setSubmitting] = useState(false);
  const [waitingForMore, setWaitingForMore] = useState(false);
  const [favoriteSaving, setFavoriteSaving] = useState(null);
  const [wrongSaving, setWrongSaving] = useState(false);
  const pollingRef = useRef(null);
  const progressTimerRef = useRef(null);
  const { updateAssistantTurn } = useChatThreadDrafts();

  function publishQuiz(nextQuiz, finalContent) {
    if (!chatKey || !turnId) return;
    updateAssistantTurn(chatKey, turnId, {
      ...(finalContent !== undefined ? { finalContent } : {}),
      outputs: [{ type: "QuizCard", payload: nextQuiz }],
      sources: nextQuiz.sourceRefs || [],
    });
  }

  function setAndPublishQuiz(updater, finalContent) {
    setQuiz((previous) => {
      const next = typeof updater === "function" ? updater(previous) : updater;
      publishQuiz(next, finalContent);
      return next;
    });
  }

  useEffect(() => {
    const incoming = initialQuiz || {};
    const incomingProgress = progressOf(incoming);
    setQuiz((previous) => {
      const sameQuiz = previous?.id && previous.id === incoming.id;
      const merged = mergeQuiz(previous, incoming, {
        preserveLocalProgress: sameQuiz,
      });
      const shouldUseIncoming =
        !sameQuiz ||
        incomingProgress.progressVersion > progressVersionOf(previous);
      if (shouldUseIncoming) {
        setAnswers(merged.answers || {});
        setCurrentIndex(merged.currentIndex || 0);
      }
      return merged;
    });
  }, [initialQuiz]);

  const questions = quiz.questions || [];
  const safeIndex = Math.min(currentIndex, Math.max(questions.length - 1, 0));
  const currentQuestion = questions[safeIndex] || null;
  const expectedTotal = quiz.expectedTotalQuestions || questions.length;
  const generating = isGenerating(quiz);
  const submitted = !!quiz.submitted;
  const abandoned = !!quiz.abandoned;
  const isLastGenerated = safeIndex >= questions.length - 1;
  const canSubmit = !generating && isLastGenerated && questions.length > 0;

  useEffect(() => {
    if (!workspace?.slug || !quiz?.id || !generating || submitted) return;

    pollingRef.current = setInterval(async () => {
      const status = await Workspace.quizStatus(workspace.slug, quiz.id);
      if (!status?.quiz) return;
      setQuiz((previous) => {
        const next = mergeQuiz(previous, status.quiz);
        if ((next.questions || []).length > (previous.questions || []).length) {
          setWaitingForMore(false);
        }
        publishQuiz(next);
        return next;
      });
      if (!status.pendingTypes?.length || status.status === "abandoned") {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
        setWaitingForMore(false);
      }
    }, 2500);

    return () => {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    };
  }, [workspace?.slug, quiz?.id, generating, submitted, chatKey, turnId]);

  function persistProgress(nextAnswers = answers, nextIndex = currentIndex) {
    if (!workspace?.slug || !quiz?.id || submitted || abandoned) return;
    clearTimeout(progressTimerRef.current);
    progressTimerRef.current = setTimeout(() => {
      Workspace.saveQuizProgress(workspace.slug, quiz.id, {
        answers: nextAnswers,
        currentIndex: nextIndex,
      });
    }, 250);
  }

  function setQuestionIndex(nextIndex, nextAnswers = answers) {
    setCurrentIndex(nextIndex);
    setAndPublishQuiz((previous) => ({
      ...previous,
      answers: nextAnswers || previous.answers || {},
      currentIndex: nextIndex,
      progress: {
        ...(previous.progress || {}),
        answers: nextAnswers || previous.answers || {},
        currentIndex: nextIndex,
      },
    }));
  }

  async function refreshQuiz() {
    const status = await Workspace.quizStatus(workspace.slug, quiz.id);
    if (!status?.quiz) return null;
    const nextQuiz = mergeQuiz(quiz, status.quiz, {
      preserveLocalProgress: false,
    });
    setQuiz(nextQuiz);
    setAnswers(nextQuiz.answers || answers);
    setCurrentIndex(nextQuiz.currentIndex ?? currentIndex);
    publishQuiz(nextQuiz, nextQuiz.analysis || undefined);
    return nextQuiz;
  }

  async function submit(nextAnswers = answers) {
    if (!workspace?.slug || !quiz?.id || submitting || abandoned) return;
    if (isGenerating(quiz)) {
      setWaitingForMore(true);
      return;
    }
    setSubmitting(true);
    let streamedAnalysis = "";
    const runningQuiz = {
      ...quiz,
      answers: nextAnswers,
      analysisStatus: "running",
      analysisError: null,
      analysis: "",
    };
    setAndPublishQuiz(runningQuiz, "");
    try {
      await Workspace.submitQuizStream(
        workspace.slug,
        quiz.id,
        nextAnswers,
        (event) => {
          if (event.type === "abort") {
            throw new Error(event.error || "分析中断");
          }
          if (event.type !== "textResponseChunk" || event.close) return;
          streamedAnalysis += event.textResponse || "";
          setAndPublishQuiz(
            (previous) => ({
              ...previous,
              analysis: streamedAnalysis,
              analysisStatus: "running",
            }),
            streamedAnalysis
          );
        }
      );
      await refreshQuiz();
    } catch (error) {
      const failedQuiz = {
        ...quiz,
        answers: nextAnswers,
        analysis: streamedAnalysis,
        analysisStatus: "failed",
        analysisError: error.message || "分析中断",
      };
      setAndPublishQuiz(failedQuiz, streamedAnalysis);
      showToast("分析中断，可以重新分析。", "error");
    } finally {
      setSubmitting(false);
    }
  }

  function goNext(nextAnswers = answers) {
    if (!currentQuestion) return;
    if (submitted) {
      setQuestionIndex(Math.min(safeIndex + 1, questions.length - 1));
      return;
    }
    if (canSubmit) {
      submit(nextAnswers);
      return;
    }
    if (isLastGenerated && generating) {
      setWaitingForMore(true);
      return;
    }
    const nextIndex = Math.min(safeIndex + 1, questions.length - 1);
    setQuestionIndex(nextIndex, nextAnswers);
    persistProgress(nextAnswers, nextIndex);
  }

  function goPrevious() {
    const nextIndex = Math.max(0, safeIndex - 1);
    setQuestionIndex(nextIndex, answers);
    persistProgress(answers, nextIndex);
  }

  function setAnswer(questionId, value) {
    const nextAnswers = { ...answers, [questionId]: value };
    setAnswers(nextAnswers);
    setAndPublishQuiz((previous) => ({
      ...previous,
      answers: nextAnswers,
      progress: {
        ...(previous.progress || {}),
        answers: nextAnswers,
        currentIndex: safeIndex,
      },
    }));
    persistProgress(nextAnswers, safeIndex);
    return nextAnswers;
  }

  function selectSingle(optionId) {
    if (!currentQuestion) return;
    const nextAnswers = setAnswer(currentQuestion.id, optionId);
    goNext(nextAnswers);
  }

  function toggleMulti(optionId) {
    if (!currentQuestion) return;
    const existing = Array.isArray(answers[currentQuestion.id])
      ? answers[currentQuestion.id]
      : [];
    const next = existing.includes(optionId)
      ? existing.filter((id) => id !== optionId)
      : [...existing, optionId];
    setAnswer(currentQuestion.id, next);
  }

  async function abandon() {
    if (!window.confirm("放弃后本次测试不会生成分析，也不会计入学习记录。"))
      return;
    const result = await Workspace.abandonQuiz(workspace.slug, quiz.id);
    if (!result?.success) {
      showToast(result?.error || "放弃测试失败。", "error");
      return;
    }
    const nextQuiz = mergeQuiz(quiz, result.quiz);
    setAndPublishQuiz(nextQuiz, "本次测试已放弃，不会计入学习记录。");
  }

  async function saveWrongQuestions() {
    setWrongSaving(true);
    const result = await Workspace.saveQuizWrongQuestions(
      workspace.slug,
      quiz.id
    );
    setWrongSaving(false);
    if (!result?.success) {
      const message =
        result?.error === "quiz_question_results_unreliable"
          ? "结构化判题失败，无法保存错题，可重新分析。"
          : result?.error || "保存错题失败。";
      showToast(message, "error");
      return;
    }
    const nextQuiz = {
      ...mergeQuiz(quiz, result.quiz),
      currentIndex: safeIndex,
    };
    setAndPublishQuiz(nextQuiz, nextQuiz.analysis || undefined);
    showToast(`已保存 ${result.count || 0} 道错题。`, "success");
  }

  async function toggleFavorite(questionId) {
    const favorited =
      quiz.favoritedQuestionIds?.includes(questionId) ||
      currentQuestion?.favorited;
    setFavoriteSaving(questionId);
    const result = favorited
      ? await Workspace.unfavoriteQuizQuestion(
          workspace.slug,
          quiz.id,
          questionId
        )
      : await Workspace.favoriteQuizQuestion(
          workspace.slug,
          quiz.id,
          questionId
        );
    setFavoriteSaving(null);
    if (!result?.success) {
      showToast(result?.error || "收藏题目失败。", "error");
      return;
    }
    const nextQuiz = {
      ...mergeQuiz(quiz, result.quiz),
      currentIndex: safeIndex,
    };
    setAndPublishQuiz(nextQuiz, nextQuiz.analysis || undefined);
  }

  const selectedAnswer = currentQuestion ? answers[currentQuestion.id] : null;
  const questionResult = useMemo(
    () =>
      (quiz.questionResults || []).find(
        (result) => result.questionId === currentQuestion?.id
      ),
    [quiz.questionResults, currentQuestion]
  );
  const sourceTitles = useMemo(() => {
    const refs = new Map((quiz.sourceRefs || []).map((ref) => [ref.id, ref]));
    return (questionResult?.sourceRefs || currentQuestion?.sourceRefs || [])
      .map((ref) => {
        const title = refs.get(ref)?.title || ref?.title || ref;
        return /^evidence-\d+$/i.test(String(title || "")) ? null : title;
      })
      .filter(Boolean);
  }, [quiz.sourceRefs, currentQuestion, questionResult]);

  if (abandoned) {
    return (
      <div className={quizSurfaceClass} style={quizSurfaceStyle}>
        <p className="m-0 text-sm font-semibold">
          {quiz.title || "Knowledge Quiz"}
        </p>
        <p className="m-0 mt-3 text-sm text-slate-600">
          本次测试已放弃，不会计入学习记录。
        </p>
      </div>
    );
  }

  if (!currentQuestion) return null;

  return (
    <div className={quizSurfaceClass} style={quizSurfaceStyle}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          {!submitted && (
            <button
              type="button"
              onClick={abandon}
              className={quizIconButtonClass}
              aria-label="放弃测试"
            >
              <XCircle size={18} />
            </button>
          )}
          <div>
            <p className="m-0 text-sm font-semibold">
              {quiz.title || "Knowledge Quiz"}
            </p>
            <p className="m-0 mt-1 text-xs text-slate-500">
              第 {Math.min(safeIndex + 1, expectedTotal)} / {expectedTotal} 题
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {submitted && (
            <FavoriteButton
              favorited={
                quiz.favoritedQuestionIds?.includes(currentQuestion.id) ||
                currentQuestion.favorited
              }
              saving={favoriteSaving === currentQuestion.id}
              onClick={() => toggleFavorite(currentQuestion.id)}
            />
          )}
          {generating && (
            <span className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-2.5 py-1 text-xs text-sky-600 shadow-[0_8px_18px_rgba(14,165,233,0.12)]">
              <CircleNotch size={14} className="animate-spin" />
              正在生成后续题目
            </span>
          )}
        </div>
      </div>

      <QuestionPromptCard
        question={currentQuestion}
        index={safeIndex}
        total={expectedTotal}
        sourceTitles={sourceTitles}
      />

      {submitted ? (
        <QuestionResult
          question={currentQuestion}
          result={questionResult}
          answer={answers[currentQuestion.id]}
        />
      ) : (
        <QuestionInput
          question={currentQuestion}
          selectedAnswer={selectedAnswer}
          onSingle={selectSingle}
          onMulti={toggleMulti}
          onFill={(value) => setAnswer(currentQuestion.id, value)}
        />
      )}

      <div className="mt-5 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={goPrevious}
          disabled={safeIndex === 0 || submitting}
          className={quizButtonSecondaryClass}
        >
          上一题
        </button>

        <button
          type="button"
          onClick={() => goNext()}
          disabled={
            submitting ||
            (isLastGenerated && generating) ||
            (submitted && safeIndex >= questions.length - 1)
          }
          className={`${quizButtonPrimaryClass} inline-flex items-center gap-2 px-5`}
        >
          {(submitting || (waitingForMore && generating)) && (
            <CircleNotch size={14} className="animate-spin" />
          )}
          {canSubmit ? "提交" : "下一题"}
        </button>
      </div>

      {quiz.analysisStatus === "failed" && (
        <div
          className={`${quizPanelClass} mt-4 border-red-200 bg-red-50 p-3 text-sm text-red-700`}
        >
          <p className="m-0">分析中断，可以重新分析。</p>
          <button
            type="button"
            onClick={() => submit(answers)}
            className={`${quizButtonPrimaryClass} mt-2 bg-red-500 hover:bg-red-400`}
          >
            重新分析
          </button>
        </div>
      )}

      {submitted && quiz.analysisStatus === "completed" && (
        <WrongQuestionSave
          quiz={quiz}
          saving={wrongSaving}
          onSave={saveWrongQuestions}
        />
      )}
    </div>
  );
}

function FavoriteButton({ favorited, saving, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={saving}
      className={`${quizButtonSecondaryClass} inline-flex items-center gap-1 px-3 py-1.5 text-xs disabled:opacity-60`}
    >
      {saving ? (
        <CircleNotch size={14} className="animate-spin" />
      ) : (
        <Star size={14} weight={favorited ? "fill" : "regular"} />
      )}
      {favorited ? "已收藏" : "收藏"}
    </button>
  );
}

function QuestionPromptCard({ question, index, total, sourceTitles = [] }) {
  return (
    <section className={`${quizPanelClass} mt-4 px-4 py-3`}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-sky-50 px-2.5 py-1 text-xs font-medium text-sky-700 shadow-[0_6px_14px_rgba(14,165,233,0.10)]">
          {questionTypeLabel(question.type)}
        </span>
        <span className="rounded-full bg-violet-50 px-2.5 py-1 text-xs font-medium text-violet-700 shadow-[0_6px_14px_rgba(124,58,237,0.10)]">
          {difficultyLabel(question.difficulty)}
        </span>
        <span className="rounded-full bg-slate-50 px-2.5 py-1 text-xs text-slate-600 shadow-[0_6px_14px_rgba(15,23,42,0.06)]">
          第 {index + 1} / {total} 题
        </span>
        {sourceTitles.length > 0 && (
          <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs text-emerald-700 shadow-[0_6px_14px_rgba(16,185,129,0.10)]">
            {sourceTitles.length} 个知识来源
          </span>
        )}
      </div>
      <p className="m-0 text-base font-semibold leading-7 text-slate-950">
        {question.question}
      </p>
      {sourceTitles.length > 0 && (
        <p className="m-0 mt-3 text-xs leading-5 text-slate-500">
          来源：{sourceTitles.join("、")}
        </p>
      )}
    </section>
  );
}

function QuestionResult({ question, result, answer }) {
  if (question.type !== "fill_blank") {
    return (
      <GradedOptions question={question} result={result} answer={answer} />
    );
  }

  return (
    <div className="mt-4 space-y-3 text-sm">
      <ResultLine label="你的答案" value={formatAnswer(answer, question)} />
      <ResultLine
        label="正确答案"
        value={formatAnswer(
          result?.correctAnswer ?? question.correctAnswer,
          question
        )}
      />
    </div>
  );
}

function GradedOptions({ question, result, answer }) {
  const selected = new Set(answerIds(answer));
  const correct = new Set(correctAnswerIds(question, result));

  return (
    <div className="mt-4 flex flex-col gap-2">
      {(question.options || []).map((option) => {
        const id = String(option.id);
        const isSelected = selected.has(id);
        const isCorrect = correct.has(id);
        const missedCorrect = isCorrect && !isSelected;
        let className =
          "border-slate-200 bg-white text-slate-800 shadow-[0_10px_24px_rgba(15,23,42,0.10),inset_0_1px_0_rgba(255,255,255,0.95)]";
        if (isSelected && isCorrect) {
          className =
            "border-emerald-400 bg-emerald-50 text-emerald-900 shadow-[0_0_24px_rgba(16,185,129,0.34),0_12px_28px_rgba(15,23,42,0.12),inset_0_1px_0_rgba(255,255,255,0.95)]";
        } else if (isSelected && !isCorrect) {
          className =
            "border-red-400 bg-red-50 text-red-900 shadow-[0_0_24px_rgba(248,113,113,0.34),0_12px_28px_rgba(15,23,42,0.12),inset_0_1px_0_rgba(255,255,255,0.95)]";
        } else if (missedCorrect) {
          className =
            "border-sky-400 bg-sky-50 text-sky-900 shadow-[0_0_24px_rgba(56,189,248,0.34),0_12px_28px_rgba(15,23,42,0.12),inset_0_1px_0_rgba(255,255,255,0.95)]";
        }

        return (
          <div
            key={option.id}
            className={`border rounded-2xl px-3 py-2.5 text-sm leading-6 ${className}`}
          >
            <span className="font-semibold mr-2">{option.id}.</span>
            {option.text}
          </div>
        );
      })}
    </div>
  );
}

function ResultLine({ label, value }) {
  return (
    <div className={`${quizPanelClass} p-3`}>
      <p className="m-0 text-xs text-slate-500">{label}</p>
      <p className="m-0 mt-1 leading-6 text-slate-900">{value}</p>
    </div>
  );
}

function WrongQuestionSave({ quiz, saving, onSave }) {
  if (quiz.questionResultsReliable === false) {
    return (
      <p className={`${quizPanelClass} m-0 mt-4 p-3 text-sm text-amber-700`}>
        结构化判题失败，无法保存错题，可重新分析。
      </p>
    );
  }

  if (quiz.wrongQuestionsSaved) {
    return (
      <p className={`${quizPanelClass} m-0 mt-4 p-3 text-sm text-emerald-700`}>
        已保存 {quiz.wrongQuestionCount || 0} 道错题
      </p>
    );
  }
  return (
    <div className={`${quizPanelClass} mt-4 p-3`}>
      <p className="m-0 text-sm">是否保存本次错题到错题库？</p>
      <button
        type="button"
        onClick={onSave}
        disabled={saving}
        className={`${quizButtonPrimaryClass} mt-2 inline-flex items-center gap-2 disabled:opacity-60`}
      >
        {saving && <CircleNotch size={14} className="animate-spin" />}
        保存错题
      </button>
    </div>
  );
}

function QuestionInput({
  question,
  selectedAnswer,
  onSingle,
  onMulti,
  onFill,
}) {
  if (question.type === "fill_blank") {
    return (
      <textarea
        value={selectedAnswer || ""}
        onChange={(event) => onFill(event.target.value)}
        className={`${quizPanelClass} mt-4 min-h-[120px] w-full p-3 text-sm text-slate-900 outline-none transition-all duration-200 focus:ring-2 focus:ring-sky-300/60`}
        placeholder="输入你的答案"
      />
    );
  }

  const multiSelected = Array.isArray(selectedAnswer) ? selectedAnswer : [];
  const baseOptionClass =
    "border text-left rounded-2xl px-3 py-2.5 text-sm leading-6 transition-all duration-150 shadow-[0_10px_24px_rgba(15,23,42,0.10),inset_0_1px_0_rgba(255,255,255,0.95)] hover:-translate-y-0.5 hover:shadow-[0_14px_32px_rgba(15,23,42,0.14),0_0_18px_rgba(125,211,252,0.18),inset_0_1px_0_rgba(255,255,255,0.95)]";
  return (
    <div className="mt-4 flex flex-col gap-2">
      {(question.options || []).map((option) => {
        const selected =
          question.type === "single_choice"
            ? selectedAnswer === option.id
            : multiSelected.includes(option.id);
        return (
          <button
            key={option.id}
            type="button"
            onClick={() =>
              question.type === "single_choice"
                ? onSingle(option.id)
                : onMulti(option.id)
            }
            className={`${baseOptionClass} ${
              selected
                ? "border-blue-400 bg-blue-50 text-blue-900 ring-1 ring-blue-300/30"
                : "border-slate-200 bg-white text-slate-800"
            }`}
          >
            <span className="font-semibold mr-2">{option.id}.</span>
            {option.text}
          </button>
        );
      })}
    </div>
  );
}
