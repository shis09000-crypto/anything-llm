import { PencilSimple } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";

function OptionButton({
  label,
  description,
  index,
  selected,
  onClick,
  disabled = false,
}) {
  const { t } = useTranslation();
  const badge =
    index === 0
      ? t("chat_window.agent_invocation.clarifying_recommended")
      : t("chat_window.agent_invocation.clarifying_backup");

  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onClick}
      className={`border-none w-full flex items-center gap-[9px] p-2 rounded-lg text-left transition-colors ${
        disabled ? "opacity-60 cursor-not-allowed" : ""
      } ${
        selected
          ? "bg-zinc-800 light:bg-slate-200"
          : "bg-transparent hover:bg-zinc-800/60 light:hover:bg-slate-200/60"
      }`}
    >
      <span className="flex items-center justify-center shrink-0 w-7 h-7 rounded-lg bg-zinc-700 light:bg-slate-300 text-white light:text-slate-900 text-base font-medium leading-6">
        {index + 1}
      </span>
      <span className="flex flex-col min-w-0">
        <span className="flex items-center gap-2 min-w-0">
          <span className="text-white light:text-slate-900 text-sm leading-5 break-words min-w-0 flex-1">
            {label}
          </span>
          <span
            className={`shrink-0 text-[10px] leading-4 px-1.5 rounded ${
              index === 0
                ? "bg-sky-500/20 text-sky-200 light:bg-sky-100 light:text-sky-700"
                : "bg-zinc-700 text-zinc-300 light:bg-slate-300 light:text-slate-700"
            }`}
          >
            {badge}
          </span>
        </span>
        {description && (
          <span className="text-xs text-zinc-400 light:text-slate-500 leading-4">
            {description}
          </span>
        )}
      </span>
    </button>
  );
}

function CustomAnswerInput({ value, onChange, disabled = false }) {
  const { t } = useTranslation();
  return (
    <div className="mt-1 flex items-center gap-[9px] p-2 rounded-lg bg-zinc-900/50 light:bg-slate-100/70">
      <span className="flex items-center justify-center shrink-0 w-7 h-7 rounded-lg bg-zinc-700 light:bg-slate-300 text-white light:text-slate-900 text-base font-medium leading-6">
        4
      </span>
      <label className="flex flex-col gap-1 min-w-0 flex-1">
        <span className="text-sm leading-5 text-zinc-300 light:text-slate-700">
          {t("chat_window.agent_invocation.clarifying_other")}
        </span>
        <input
          type="text"
          disabled={disabled}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={t(
            "chat_window.agent_invocation.clarifying_other_placeholder"
          )}
          className="w-full border border-solid border-zinc-700 light:border-slate-500 bg-zinc-800 light:bg-white text-white light:text-slate-900 placeholder:text-zinc-500 light:placeholder:text-slate-500 text-sm rounded-lg focus:outline-white light:focus:outline-slate-400 outline-none px-2 py-1.5"
        />
      </label>
    </div>
  );
}

function OtherRow({ selected, onToggle, disabled = false }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onToggle}
      className={`border-none flex flex-1 min-w-0 items-center gap-[9px] p-2 rounded-lg text-left transition-colors ${
        disabled ? "opacity-60 cursor-not-allowed" : ""
      } ${
        selected
          ? "bg-zinc-800 light:bg-slate-200"
          : "bg-transparent hover:bg-zinc-800/60 light:hover:bg-slate-200/60"
      }`}
    >
      <span className="flex items-center justify-center shrink-0 w-7 h-7 rounded-lg bg-zinc-700 light:bg-slate-300 text-white light:text-slate-900">
        <PencilSimple size={16} />
      </span>
      <span
        className={`text-sm leading-5 ${
          selected
            ? "text-white light:text-slate-900"
            : "text-zinc-400 light:text-slate-600"
        }`}
      >
        {t("chat_window.agent_invocation.clarifying_other")}
      </span>
    </button>
  );
}

export default function ChoiceForm({
  question,
  draft,
  onChange,
  onAutoAdvance,
  disabled = false,
}) {
  const showOther = question.allowOther !== false;
  const options = Array.isArray(question.options)
    ? question.options.slice(0, 3)
    : [];

  function isChecked(opt) {
    if (question.multiSelect)
      return Array.isArray(draft.selected) && draft.selected.includes(opt);
    return draft.selected === opt;
  }

  function handleSelect(opt) {
    if (disabled) return;
    if (question.multiSelect) {
      const list = Array.isArray(draft.selected) ? draft.selected : [];
      const next = list.includes(opt)
        ? list.filter((o) => o !== opt)
        : [...list, opt];
      onChange({ selected: next, otherSelected: false });
      return;
    }
    const patch = { selected: opt, otherSelected: false };
    onChange(patch);
    onAutoAdvance?.(patch);
  }

  function handleOtherToggle() {
    if (disabled) return;
    if (question.multiSelect) {
      onChange({ otherSelected: !draft.otherSelected });
      return;
    }
    onChange({ selected: null, otherSelected: !draft.otherSelected });
  }

  function handleCustomAnswer(text) {
    if (disabled) return;
    const hasText = text.trim().length > 0;
    if (question.multiSelect) {
      onChange({ otherText: text, otherSelected: hasText });
      return;
    }
    onChange({ selected: null, otherText: text, otherSelected: hasText });
  }

  return (
    <div className="flex flex-col w-full">
      {options.map((opt, idx) => (
        <OptionButton
          key={`${opt}-${idx}`}
          label={opt}
          description={question.optionDescriptions?.[idx]}
          index={idx}
          selected={isChecked(opt)}
          onClick={() => handleSelect(opt)}
          disabled={disabled}
        />
      ))}
      {showOther && question.multiSelect && (
        <OtherRow
          selected={!!draft.otherSelected}
          onToggle={handleOtherToggle}
          disabled={disabled}
        />
      )}
      {showOther && !question.multiSelect && (
        <CustomAnswerInput
          value={draft.otherText || ""}
          onChange={handleCustomAnswer}
          disabled={disabled}
        />
      )}
      {showOther && question.multiSelect && draft.otherSelected && (
        <CustomAnswerInput
          value={draft.otherText || ""}
          onChange={(text) => onChange({ otherText: text })}
          disabled={disabled}
        />
      )}
    </div>
  );
}
