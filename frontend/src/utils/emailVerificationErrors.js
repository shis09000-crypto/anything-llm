const EMAIL_VERIFICATION_ERROR_KEYS = {
  verification_code_not_found: "not_found",
  verification_code_invalid_format: "invalid_format",
  verification_code_expired: "expired",
  verification_code_consumed: "consumed",
  verification_code_attempts_exceeded: "attempts_exceeded",
  verification_code_mismatch: "mismatch",
  verification_resend_cooldown: "resend_cooldown",
  email_smtp_not_configured: "smtp_not_configured",
};

export function emailVerificationErrorMessage(t, result = {}) {
  const errorCode = result?.errorCode || result?.code || "";
  const key = EMAIL_VERIFICATION_ERROR_KEYS[errorCode];
  if (key) return t(`email_verification_errors.${key}`);
  return result?.error || t("email_verification_errors.default");
}
