import {
  deleteJson,
  getJson,
  postJson,
  putJson,
} from "@/lib/communication/apiClient";
import { apiErrorFallback as rawOrFallback } from "@/lib/communication/apiError";

const ScheduledJobs = {
  list: async function () {
    return await getJson("/scheduled-jobs")
      .then(({ data }) => data)
      .catch(() => ({ jobs: [] }));
  },

  create: async function (data) {
    return await postJson("/scheduled-jobs/new", data)
      .then(({ data }) => data)
      .catch(
        (e) =>
          rawOrFallback(e, null) || {
            job: null,
            error: "Failed to create scheduled job",
          }
      );
  },

  get: async function (id) {
    return await getJson(`/scheduled-jobs/${id}`)
      .then(({ data }) => data)
      .catch(() => ({ job: null }));
  },

  update: async function (id, data) {
    return await putJson(`/scheduled-jobs/${id}`, data)
      .then(({ data }) => data)
      .catch((e) => ({
        ...rawOrFallback(e, { job: null, error: e.message }),
      }));
  },

  delete: async function (id) {
    return await deleteJson(`/scheduled-jobs/${id}`)
      .then(({ data }) => data)
      .catch(() => ({ success: false }));
  },

  toggle: async function (id) {
    return await postJson(`/scheduled-jobs/${id}/toggle`)
      .then(({ data }) => data)
      .catch(() => ({ job: null }));
  },

  trigger: async function (id) {
    return await postJson(`/scheduled-jobs/${id}/trigger`)
      .then(({ data }) => data)
      .catch((e) => rawOrFallback(e, { success: false, error: e.message }));
  },

  runs: async function (id) {
    return await getJson(`/scheduled-jobs/${id}/runs`)
      .then(({ data }) => data)
      .catch(() => ({ runs: [] }));
  },

  getRun: async function (runId) {
    return await getJson(`/scheduled-jobs/runs/${runId}`)
      .then(({ data }) => data)
      .catch(() => ({ run: null, job: null }));
  },

  markRunRead: async function (runId) {
    return await postJson(`/scheduled-jobs/runs/${runId}/read`)
      .then(({ data }) => data)
      .catch(() => ({ success: false }));
  },

  continueInThread: async function (runId) {
    return await postJson(`/scheduled-jobs/runs/${runId}/continue`)
      .then(({ data }) => data)
      .catch((e) => ({
        ...rawOrFallback(e, {
          workspaceSlug: null,
          threadSlug: null,
          error: e.message,
        }),
      }));
  },

  availableTools: async function () {
    return await getJson("/scheduled-jobs/available-tools")
      .then(({ data }) => data)
      .catch(() => ({ tools: [] }));
  },

  killRun: async function (runId) {
    return await postJson(`/scheduled-jobs/runs/${runId}/kill`)
      .then(({ data }) => data)
      .catch((e) => rawOrFallback(e, { success: false, error: e.message }));
  },
};

export default ScheduledJobs;
