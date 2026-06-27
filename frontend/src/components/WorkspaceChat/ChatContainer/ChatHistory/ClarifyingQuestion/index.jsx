import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import useTimeoutProgress from "@/hooks/useTimeoutProgress";
import Header from "./Header";
import InputForm from "./InputForm";
import ChoiceForm from "./ChoiceForm";
import Footer from "./Footer";
import SurveyBody from "./SurveyBody";
import { answerForDraft, emptyDraftFor } from "./utils";

function TimeoutProgressBar({ percent }) {
  return (
    <div className="absolute bottom-0 left-0 right-0 h-1 bg-zinc-700 light:bg-slate-300">
      <div
        className="h-full bg-sky-500 light:bg-sky-600 transition-none"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

function CardWrapper({ children }) {
  return (
    <div className="flex justify-center w-full my-1 pr-4">
      <div className="w-full flex flex-col">
        <div className="relative border border-solid border-zinc-700 light:border-zinc-300 bg-transparent p-[18px] flex flex-col gap-[18px] overflow-hidden rounded-lg">
          {children}
        </div>
      </div>
    </div>
  );
}

function ActiveInputForm({
  question,
  draft,
  updateDraft,
  onSubmit,
  disabled = false,
}) {
  if (question?.kind !== "input") return null;
  return (
    <InputForm
      question={question}
      draft={draft}
      onChange={(value) => updateDraft({ skipped: false, value })}
      onSubmit={onSubmit}
      disabled={disabled}
    />
  );
}

function ActiveChoiceForm({
  question,
  draft,
  updateDraft,
  onAutoAdvance,
  disabled = false,
}) {
  if (question?.kind !== "choice") return null;
  return (
    <ChoiceForm
      question={question}
      draft={draft}
      onChange={(patch) => updateDraft({ skipped: false, ...patch })}
      onAutoAdvance={
        question.multiSelect
          ? null
          : (patch) => onAutoAdvance({ skipped: false, ...patch })
      }
      disabled={disabled}
    />
  );
}

function ActiveFooter({
  question,
  draft,
  isSingle,
  isLast,
  allowSkip,
  answeredCount,
  total,
  onSkipThis,
  onNext,
  onSubmitAll,
  disabled = false,
}) {
  const isChoice = question?.kind === "choice";
  const isInput = question?.kind === "input";
  const showFooter =
    isInput || (isChoice && (question.multiSelect || draft?.otherSelected));

  if (!showFooter) return null;

  return (
    <Footer
      isSingle={isSingle}
      isLast={isLast}
      allowSkip={allowSkip && isInput}
      answeredCount={answeredCount}
      total={total}
      onSkipThis={onSkipThis}
      onNext={onNext}
      onSubmitAll={onSubmitAll}
      disabled={disabled}
    />
  );
}

function CompletedSurvey({ questions, drafts, submittedResult }) {
  const result =
    submittedResult?.timedOut || submittedResult?.skipped
      ? submittedResult
      : { answers: questions.map((q, i) => answerForDraft(q, drafts[i])) };

  return <SurveyBody questions={questions} result={result} />;
}

export default function ClarifyingQuestionCard({
  requestId,
  questions = [],
  allowSkip = true,
  timeoutMs = null,
  onRespond,
}) {
  const { t } = useTranslation();
  const [index, setIndex] = useState(0);
  const [responded, setResponded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [submittedResult, setSubmittedResult] = useState(null);
  const [drafts, setDrafts] = useState(() =>
    questions.map((q) => emptyDraftFor(q))
  );

  const progressPercent = useTimeoutProgress(timeoutMs, {
    active: !responded,
    onTimeout: () => {
      send({ timedOut: true });
    },
  });

  const total = questions.length;
  const isSingle = total === 1;
  const isFirst = index === 0;
  const isLast = index === total - 1;
  const currentQuestion = questions[index];
  const currentDraft = drafts[index];

  const answeredCount = useMemo(
    () =>
      questions.reduce((acc, q, i) => {
        const result = answerForDraft(q, drafts[i]);
        return acc + (result.skipped ? 0 : 1);
      }, 0),
    [questions, drafts]
  );

  if (!total) return null;

  function updateDraft(patch) {
    if (submitting) return;
    setDrafts((prev) =>
      prev.map((draft, i) => (i === index ? { ...draft, ...patch } : draft))
    );
  }

  async function send(payload) {
    if (responded || submitting) return false;
    setSubmitting(true);
    setSubmitError(null);

    try {
      const result = await onRespond?.(requestId, payload);
      if (result?.ok === false) {
        throw new Error(result.reason || "clarification_send_failed");
      }

      setResponded(true);
      setSubmittedResult(payload);
      return true;
    } catch (error) {
      if (import.meta.env.DEV) {
        window.__lastClarifyingCardError = {
          requestId,
          message: error?.message || String(error || "unknown"),
          stack: error?.stack || null,
        };
        console.warn(
          `[clarification] card response failed ${JSON.stringify(
            window.__lastClarifyingCardError
          )}`
        );
      }
      setSubmitError(
        error?.message ||
          t("chat_window.agent_invocation.clarifying_send_failed")
      );
      return false;
    } finally {
      setSubmitting(false);
    }
  }

  function handleSkipThis() {
    if (submitting) return;
    const skipPatch = { skipped: true };
    updateDraft(skipPatch);
    if (isLast) return handleSubmitAll(skipPatch);
    setIndex(index + 1);
  }

  function handleNext() {
    if (submitting) return;
    if (isLast) return handleSubmitAll();
    setIndex(index + 1);
  }

  function handleAutoAdvance(pendingPatch) {
    if (submitting) return;
    if (isLast) return handleSubmitAll(pendingPatch);
    setIndex(index + 1);
  }

  function handlePrev() {
    if (submitting) return;
    if (isFirst) return;
    setIndex(index - 1);
  }

  function handleSubmitAll(pendingPatch) {
    if (submitting) return;
    const resolved = pendingPatch
      ? drafts.map((draft, i) =>
          i === index ? { ...draft, ...pendingPatch } : draft
        )
      : drafts;
    const answers = questions.map((q, i) => answerForDraft(q, resolved[i]));
    send({ skipped: false, answers });
  }

  function handleClose() {
    if (submitting) return;
    send({ skipped: true });
  }

  return (
    <CardWrapper>
      {!responded && (
        <>
          <Header
            question={currentQuestion?.question}
            index={index}
            total={total}
            isSingle={isSingle}
            responded={responded}
            onPrev={handlePrev}
            onNext={handleNext}
            onClose={handleClose}
            isFirst={isFirst}
            isLast={isLast}
          />
          <ActiveInputForm
            question={currentQuestion}
            draft={currentDraft}
            updateDraft={updateDraft}
            onSubmit={isSingle ? handleSubmitAll : handleNext}
            disabled={submitting}
          />
          <ActiveChoiceForm
            question={currentQuestion}
            draft={currentDraft}
            updateDraft={updateDraft}
            onAutoAdvance={handleAutoAdvance}
            allowSkip={allowSkip}
            onSkip={handleSkipThis}
            disabled={submitting}
          />
          {submitError && (
            <div className="text-xs text-red-400 light:text-red-600">
              {t("chat_window.agent_invocation.clarifying_send_failed")}
            </div>
          )}
          <ActiveFooter
            question={currentQuestion}
            draft={currentDraft}
            isSingle={isSingle}
            isLast={isLast}
            allowSkip={allowSkip}
            answeredCount={answeredCount}
            total={total}
            onSkipThis={handleSkipThis}
            onNext={handleNext}
            onSubmitAll={handleSubmitAll}
            disabled={submitting}
          />
        </>
      )}
      {responded && (
        <CompletedSurvey
          questions={questions}
          drafts={drafts}
          submittedResult={submittedResult}
        />
      )}
      {timeoutMs && !responded && (
        <TimeoutProgressBar percent={progressPercent} />
      )}
    </CardWrapper>
  );
}
