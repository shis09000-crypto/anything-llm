export function normalizeEmailInput(value = "") {
  return String(value || "")
    .normalize("NFKC")
    .replace(/。/g, ".")
    .toLowerCase()
    .replace(/\s/g, "")
    .replace(/[^a-z0-9.!#$%&'*+/=?^_`{|}~@-]/g, "");
}
