const { SystemSettings } = require("../models/systemSettings");
const { EventLogRepository: EventLogs } = require("./eventLogRepository");
const { diagnosticSummary } = require("../utils/environment");
const {
  confirmRepair,
  getRun,
  previewRepair,
  runSystemPatrol,
  status: patrolStatus,
} = require("../utils/systemPatrol");
const {
  sanitizeValue,
  SENSITIVE_FIELD_KEY,
} = require("../utils/dataAccess/dataAccessPolicy");

function settingEnvelope(setting = null) {
  if (!setting) return null;
  const sensitive = SENSITIVE_FIELD_KEY.test(setting.label || "");
  return {
    label: setting.label,
    value: sensitive ? "[redacted]" : sanitizeValue(setting.value),
    sensitive,
    createdAt: setting.createdAt || null,
    updatedAt: setting.updatedAt || null,
  };
}

const AdminSystemRepository = {
  dataDomain: "admin-system",
  repositoryName: "AdminSystemRepository",

  get saneDefaultSystemPrompt() {
    return SystemSettings.saneDefaultSystemPrompt;
  },

  diagnosticSummary() {
    return sanitizeValue(diagnosticSummary());
  },

  async get(clause = {}) {
    return SystemSettings.get(clause);
  },

  async getSetting({ label } = {}) {
    return settingEnvelope(await SystemSettings.get({ label }));
  },

  async getValueOrFallback(clause = {}, fallback = null) {
    return SystemSettings.getValueOrFallback(clause, fallback);
  },

  async getSettingValue({ label, fallback = null } = {}) {
    const value = await SystemSettings.getValueOrFallback({ label }, fallback);
    return SENSITIVE_FIELD_KEY.test(label || "")
      ? "[redacted]"
      : sanitizeValue(value);
  },

  async listSettings({ clause = {}, limit = null } = {}) {
    const settings = await SystemSettings.where(clause, limit);
    return settings.map((setting) => settingEnvelope(setting));
  },

  async updateSettings(updates = {}) {
    return SystemSettings.updateSettings(updates);
  },

  async _updateSettings(updates = {}) {
    return SystemSettings._updateSettings(updates);
  },

  async isMultiUserMode() {
    return SystemSettings.isMultiUserMode();
  },

  async deleteSetting({ label } = {}) {
    return SystemSettings.delete({ label });
  },

  async eventLogs({
    clause = {},
    limit = null,
    orderBy = null,
    offset = null,
  } = {}) {
    const logs = await EventLogs.where(clause, limit, orderBy, offset);
    return logs.map((log) => ({
      ...log,
      metadata: sanitizeValue(log.metadata),
    }));
  },

  async eventLogCount(clause = {}) {
    return EventLogs.count(clause);
  },

  async deleteEventLogs(clause = {}) {
    return EventLogs.delete(clause);
  },

  async patrolStatus() {
    return patrolStatus();
  },

  async patrolRun(options = {}) {
    return runSystemPatrol(options);
  },

  async patrolGetRun(runId) {
    return getRun(runId);
  },

  async patrolPreviewRepair(repairId) {
    return previewRepair(repairId);
  },

  async patrolConfirmRepair(repairId, options = {}) {
    return confirmRepair(repairId, options);
  },

  async snapshot() {
    return {
      environment: this.diagnosticSummary(),
      patrol: await this.patrolStatus(),
    };
  },
};

module.exports = { AdminSystemRepository, settingEnvelope };
