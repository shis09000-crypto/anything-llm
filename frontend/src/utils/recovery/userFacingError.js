import { API_ERROR_CODES } from "../../lib/communication/apiError.js";
import { RECOVERY_CLASSIFICATIONS } from "./errorClassifier.js";

export function userFacingError(error = null, classified = {}) {
  if (classified.silent) return null;

  switch (classified.classification) {
    case RECOVERY_CLASSIFICATIONS.retryable:
      if (classified.code === API_ERROR_CODES.INVALID_SIGNATURE) {
        return "安全签名已刷新，请稍后重试。";
      }
      if (classified.code === API_ERROR_CODES.SIGNING_SECRET_ROTATED) {
        return "安全凭证已更新，请稍后重试。";
      }
      return "网络连接不稳定，请稍后重试。";
    case RECOVERY_CLASSIFICATIONS.rollback:
      return "操作失败，已恢复到之前状态。";
    case RECOVERY_CLASSIFICATIONS.reauth:
      return "登录状态已过期，请重新登录。";
    case RECOVERY_CLASSIFICATIONS.permission:
      if (classified.code === API_ERROR_CODES.CLIENT_REVOKED) {
        return "当前设备授权已失效，请重新登录。";
      }
      return "没有权限执行此操作。";
    case RECOVERY_CLASSIFICATIONS.background:
      return "后台任务暂时未完成，系统会稍后继续处理。";
    case RECOVERY_CLASSIFICATIONS.fatal:
    default:
      return (
        error?.raw?.message ||
        error?.raw?.error ||
        error?.details?.message ||
        error?.message ||
        "操作失败，请稍后重试。"
      );
  }
}
