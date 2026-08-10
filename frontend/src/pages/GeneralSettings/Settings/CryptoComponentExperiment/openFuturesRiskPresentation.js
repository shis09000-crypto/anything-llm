export const LIQUIDATION_RISK_META = Object.freeze({
  safe: Object.freeze({ label: "安全", lights: 1 }),
  watch: Object.freeze({ label: "注意", lights: 2 }),
  danger: Object.freeze({ label: "高危", lights: 3 }),
  critical: Object.freeze({ label: "危险", lights: 4 }),
  extreme: Object.freeze({ label: "极危", lights: 5 }),
  unavailable: Object.freeze({ label: "暂不可用", lights: 0 }),
});

export function liquidationRiskPresentation(level) {
  return LIQUIDATION_RISK_META[level] || LIQUIDATION_RISK_META.unavailable;
}
