import { useMemo, useState } from "react";
import {
  ArrowRight,
  CaretDown,
  CaretUp,
  CheckCircle,
  Circle,
  CircleNotch,
  ListChecks,
  Play,
  X,
} from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";

const STATUS_ICON = {
  completed: CheckCircle,
  in_progress: CircleNotch,
  pending: Circle,
};

export default function PlanPanel({
  plan,
  disabled = false,
  onExecute,
  onRevise,
  onClose,
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(true);
  const [revision, setRevision] = useState("");
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  const completed = steps.filter((step) => step.status === "completed").length;
  const busy = ["drafting", "executing"].includes(plan?.status);
  const executable = plan?.status === "ready" && steps.length > 0;
  const progress = useMemo(
    () => (steps.length ? Math.round((completed / steps.length) * 100) : 0),
    [completed, steps.length]
  );

  function submitRevision(event) {
    event.preventDefault();
    const value = revision.trim();
    if (!value || disabled || busy) return;
    onRevise?.(value);
    setRevision("");
  }

  return (
    <section className="mx-2 mt-2 hidden overflow-hidden rounded-2xl border border-violet-400/25 bg-violet-500/[0.08] text-white shadow-sm light:border-violet-200 light:bg-violet-50/90 light:text-slate-700 md:block">
      <header className="flex min-h-11 items-center gap-2 px-3 py-2">
        <ListChecks
          size={18}
          weight="duotone"
          className="shrink-0 text-violet-300 light:text-violet-600"
        />
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-2 border-none bg-transparent p-0 text-left text-current"
          aria-expanded={expanded}
        >
          <span className="truncate text-sm font-medium">
            {plan?.title ||
              t("chat_window.controls.composerMenu.planCreating", {
                defaultValue: "Creating plan",
              })}
          </span>
          <span className="shrink-0 text-[11px] text-white/50 light:text-slate-500">
            {steps.length ? `${completed}/${steps.length}` : ""}
          </span>
          {busy && (
            <CircleNotch
              size={13}
              className="shrink-0 animate-spin text-violet-300 light:text-violet-600"
            />
          )}
          {expanded ? <CaretUp size={14} /> : <CaretDown size={14} />}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="flex h-7 w-7 items-center justify-center rounded-lg border-none bg-transparent text-white/50 hover:bg-white/10 hover:text-white light:text-slate-500 light:hover:bg-slate-200"
          aria-label={t("chat_window.controls.composerMenu.closePlan", {
            defaultValue: "Close plan",
          })}
        >
          <X size={14} />
        </button>
      </header>

      {expanded && (
        <div className="border-t border-white/10 px-3 pb-3 pt-2 light:border-violet-100">
          {steps.length > 0 && (
            <div
              className="mb-3 space-y-1.5"
              aria-label={t("chat_window.controls.composerMenu.planSteps", {
                defaultValue: "Plan steps",
              })}
            >
              <div className="mb-2 h-1 overflow-hidden rounded-full bg-white/10 light:bg-violet-100">
                <div
                  className="h-full rounded-full bg-violet-400 transition-[width] duration-300 light:bg-violet-600"
                  style={{ width: `${progress}%` }}
                />
              </div>
              {steps.map((step) => {
                const Icon = STATUS_ICON[step.status] || Circle;
                return (
                  <div
                    key={step.id}
                    className="flex items-start gap-2 text-xs leading-5 text-white/75 light:text-slate-600"
                  >
                    <Icon
                      size={14}
                      weight={step.status === "completed" ? "fill" : "regular"}
                      className={`${
                        step.status === "in_progress" ? "animate-spin" : ""
                      } mt-0.5 shrink-0 text-violet-300 light:text-violet-600`}
                    />
                    <span
                      className={
                        step.status === "completed"
                          ? "line-through opacity-65"
                          : ""
                      }
                    >
                      {step.step}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          <div className="mb-2 flex items-center gap-2">
            <button
              type="button"
              disabled={!executable || disabled}
              onClick={onExecute}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-violet-300/40 bg-violet-500 px-3 text-xs font-medium text-white hover:bg-violet-400 disabled:cursor-not-allowed disabled:opacity-45 light:border-violet-600 light:bg-violet-600 light:hover:bg-violet-700"
            >
              <Play size={13} weight="fill" />
              {t("chat_window.controls.composerMenu.executePlan", {
                defaultValue: "Execute plan",
              })}
            </button>
            <span className="text-[11px] text-white/45 light:text-slate-500">
              {t(
                `chat_window.controls.composerMenu.planStatus.${plan?.status}`,
                {
                  defaultValue: plan?.status || "",
                }
              )}
            </span>
          </div>

          <form
            onSubmit={submitRevision}
            className="flex min-h-9 items-center gap-1 rounded-xl border border-white/10 bg-black/10 px-2 light:border-violet-200 light:bg-white"
          >
            <input
              value={revision}
              onChange={(event) => setRevision(event.target.value)}
              disabled={disabled || busy}
              className="h-8 min-w-0 flex-1 border-none bg-transparent px-1 text-xs text-white outline-none placeholder:text-white/35 light:text-slate-700 light:placeholder:text-slate-400"
              placeholder={t(
                "chat_window.controls.composerMenu.planRevisionPlaceholder",
                { defaultValue: "Add requirements or adjust the next steps" }
              )}
            />
            <button
              type="submit"
              disabled={!revision.trim() || disabled || busy}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border-none bg-transparent text-violet-300 hover:bg-white/10 disabled:opacity-30 light:text-violet-600 light:hover:bg-violet-50"
              aria-label={t(
                "chat_window.controls.composerMenu.submitPlanRevision",
                { defaultValue: "Revise plan" }
              )}
            >
              <ArrowRight size={14} weight="bold" />
            </button>
          </form>
        </div>
      )}
    </section>
  );
}
