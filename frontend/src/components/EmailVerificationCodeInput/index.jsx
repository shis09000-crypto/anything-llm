import { useEffect, useRef, useState } from "react";

export default function EmailVerificationCodeInput({
  disabled = false,
  onComplete,
  inputClassName = "",
  resetSignal = 0,
}) {
  const [digits, setDigits] = useState(Array(6).fill(""));
  const refs = useRef([]);
  const lastSubmittedRef = useRef("");

  useEffect(() => {
    setDigits(Array(6).fill(""));
    lastSubmittedRef.current = "";
    refs.current[0]?.focus();
  }, [resetSignal]);

  useEffect(() => {
    const code = digits.join("");
    if (code.length !== 6 || digits.some((digit) => digit === "")) return;
    if (code === lastSubmittedRef.current) return;
    lastSubmittedRef.current = code;
    onComplete?.(code);
  }, [digits, onComplete]);

  function updateDigit(index, value) {
    const nextDigit = String(value || "")
      .replace(/\D/g, "")
      .slice(-1);
    setDigits((current) => {
      const next = [...current];
      next[index] = nextDigit;
      return next;
    });
    if (nextDigit && index < 5) refs.current[index + 1]?.focus();
  }

  function handlePaste(event) {
    const pasted = event.clipboardData
      .getData("text")
      .replace(/\D/g, "")
      .slice(0, 6);
    if (!pasted) return;
    event.preventDefault();
    const next = Array(6).fill("");
    pasted.split("").forEach((digit, index) => {
      next[index] = digit;
    });
    setDigits(next);
    refs.current[Math.min(pasted.length, 5)]?.focus();
  }

  function handleKeyDown(index, event) {
    if (event.key !== "Backspace" || digits[index]) return;
    refs.current[Math.max(index - 1, 0)]?.focus();
  }

  return (
    <div className="flex items-center gap-2" onPaste={handlePaste}>
      {digits.map((digit, index) => (
        <input
          key={index}
          ref={(node) => {
            refs.current[index] = node;
          }}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={1}
          disabled={disabled}
          value={digit}
          aria-label={`Verification code digit ${index + 1}`}
          onChange={(event) => updateDigit(index, event.target.value)}
          onKeyDown={(event) => handleKeyDown(index, event)}
          className={
            inputClassName ||
            "h-11 w-10 rounded-lg border border-white/10 bg-zinc-800 text-center text-lg font-semibold text-zinc-100 outline-none focus:border-sky-300 light:border-slate-200 light:bg-slate-100 light:text-slate-900"
          }
        />
      ))}
    </div>
  );
}
