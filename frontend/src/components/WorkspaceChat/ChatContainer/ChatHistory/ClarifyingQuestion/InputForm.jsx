const SHARED_CLASS =
  "w-full border border-solid border-zinc-700 light:border-slate-500 bg-zinc-800 light:bg-white text-white light:text-slate-900 placeholder:text-zinc-500 light:placeholder:text-slate-500 text-sm leading-5 rounded-lg focus:outline-white light:focus:outline-slate-400 outline-none px-[14px] py-[10px]";

function TextareaInput({ value, placeholder, onChange, disabled = false }) {
  return (
    <textarea
      autoFocus
      disabled={disabled}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className={`${SHARED_CLASS} min-h-[128px] resize-y`}
    />
  );
}

function TextInput({
  type,
  value,
  placeholder,
  onChange,
  onSubmit,
  disabled = false,
}) {
  function handleKeyDown(e) {
    if (e.key === "Enter") {
      e.preventDefault();
      onSubmit?.();
    }
  }

  return (
    <input
      autoFocus
      disabled={disabled}
      type={type}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={handleKeyDown}
      className={SHARED_CLASS}
    />
  );
}

export default function InputForm({
  question,
  draft,
  onChange,
  onSubmit,
  disabled = false,
}) {
  const inputType = question.inputType || "text";
  const value = draft.value || "";
  const placeholder = question.placeholder || "";

  if (inputType === "textarea") {
    return (
      <TextareaInput
        value={value}
        placeholder={placeholder}
        onChange={onChange}
        disabled={disabled}
      />
    );
  }

  return (
    <TextInput
      type={inputType}
      value={value}
      placeholder={placeholder}
      onChange={onChange}
      onSubmit={onSubmit}
      disabled={disabled}
    />
  );
}
