import { useTranslation } from "react-i18next";
import { formatAnswerDisplay } from "./utils";

function StatusMessage({ message }) {
  return (
    <div className="text-xs text-white/60 light:text-slate-600">{message}</div>
  );
}

function AnswerRow({ question, answer, index, showNumber, skippedLabel }) {
  return (
    <div className="flex gap-2">
      {showNumber && (
        <span className="text-white/50 light:text-slate-500 shrink-0">
          {index + 1}.
        </span>
      )}
      <div className="flex flex-col">
        <span className="text-white/60 light:text-slate-600">
          {question.question}
        </span>
        <span className="font-medium text-white light:text-slate-900">
          {formatAnswerDisplay(answer, skippedLabel)}
        </span>
      </div>
    </div>
  );
}

function AnswersList({ questions, answers }) {
  const { t } = useTranslation();
  const showNumbers = questions.length > 1;
  const skippedLabel = t("chat_window.agent_invocation.answer_skipped");

  return (
    <div className="flex flex-col gap-y-1.5 text-xs text-white/70 light:text-slate-700">
      {questions.map((question, i) => (
        <AnswerRow
          key={i}
          question={question}
          answer={answers[i] || { skipped: true }}
          index={i}
          showNumber={showNumbers}
          skippedLabel={skippedLabel}
        />
      ))}
    </div>
  );
}

export default function SurveyBody({ questions = [], result = {} }) {
  const { t } = useTranslation();

  if (result.timedOut) {
    return (
      <StatusMessage
        message={t("chat_window.agent_invocation.clarifying_timeout")}
      />
    );
  }

  if (result.skipped) {
    return (
      <StatusMessage
        message={t("chat_window.agent_invocation.clarifying_skipped")}
      />
    );
  }

  const answers = Array.isArray(result.answers) ? result.answers : [];
  return <AnswersList questions={questions} answers={answers} />;
}
