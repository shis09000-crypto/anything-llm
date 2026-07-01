import { Warning, X } from "@phosphor-icons/react";
import { SoftModalSurface } from "@/components/SoftSettings";

export default function ChangeWarningModal({
  warningText = "",
  onClose,
  onConfirm,
}) {
  return (
    <SoftModalSurface>
      <div className="relative px-6 py-5 border-b border-slate-200/80 dark:border-white/10">
        <div className="w-full flex gap-x-2 items-center">
          <Warning className="text-red-500 w-6 h-6" weight="fill" />
          <h3 className="text-xl font-bold text-red-500 overflow-hidden overflow-ellipsis whitespace-nowrap">
            WARNING - This action is irreversible
          </h3>
        </div>
        <button
          onClick={onClose}
          type="button"
          className="absolute top-4 right-4 motion-hover bg-transparent rounded-lg text-sm p-1 inline-flex items-center hover:bg-slate-100 dark:hover:bg-white/10 border-transparent border"
        >
          <X
            size={24}
            weight="bold"
            className="text-[var(--soft-text-muted)]"
          />
        </button>
      </div>
      <div
        className="h-full w-full overflow-y-auto"
        style={{ maxHeight: "calc(100vh - 200px)" }}
      >
        <div className="py-7 px-9 space-y-2 flex-col">
          <p className="text-sm font-medium leading-6 text-[var(--soft-text-secondary)]">
            {warningText.split("\\n").map((line, index) => (
              <span key={index}>
                {line}
                <br />
              </span>
            ))}
            <br />
            <br />
            Are you sure you want to proceed?
          </p>
        </div>
      </div>
      <div className="flex w-full justify-end items-center p-6 space-x-2 border-t border-slate-200/80 dark:border-white/10">
        <button
          onClick={onClose}
          type="button"
          className="settings-soft-button settings-soft-button-outline settings-soft-button-md"
        >
          Cancel
        </button>
        <button
          onClick={onConfirm}
          type="submit"
          className="settings-soft-button settings-soft-button-danger settings-soft-button-md"
        >
          Confirm
        </button>
      </div>
    </SoftModalSurface>
  );
}
