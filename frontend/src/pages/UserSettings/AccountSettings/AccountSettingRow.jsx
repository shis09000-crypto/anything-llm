import { CaretRight } from "@phosphor-icons/react";

export default function AccountSettingRow({
  icon,
  title,
  subtitle,
  status,
  action,
  danger = false,
  children,
  onClick,
}) {
  const interactive = Boolean(onClick);
  const Wrapper = interactive ? "button" : "div";

  return (
    <Wrapper
      type={interactive ? "button" : undefined}
      onClick={onClick}
      className={[
        "account-setting-row",
        "group flex w-full items-center gap-4 px-1 py-4 text-left",
        interactive ? "cursor-pointer rounded-2xl hover:bg-slate-50" : "",
      ].join(" ")}
    >
      <div
        className={[
          "account-setting-row__icon",
          "flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border",
          danger
            ? "border-red-100 bg-red-50 text-red-500"
            : "border-slate-200 bg-slate-50 text-slate-600",
        ].join(" ")}
      >
        {icon}
      </div>
      <div className="account-setting-row__body min-w-0 flex-1">
        <div
          className={[
            "text-sm font-semibold",
            danger ? "text-red-600" : "text-slate-950",
          ].join(" ")}
        >
          {title}
        </div>
        {subtitle && (
          <div className="mt-1 text-sm leading-5 text-slate-500">
            {subtitle}
          </div>
        )}
        {children}
      </div>
      {status && (
        <div className="account-setting-row__status shrink-0 text-sm">
          {status}
        </div>
      )}
      {action && (
        <div className="account-setting-row__action shrink-0">{action}</div>
      )}
      {interactive && (
        <CaretRight
          className="account-setting-row__caret h-4 w-4 shrink-0 text-slate-300 transition group-hover:text-slate-500"
          weight="bold"
        />
      )}
    </Wrapper>
  );
}
