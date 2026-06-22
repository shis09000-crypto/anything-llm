import { getJson, postJson } from "@/lib/communication/apiClient";

const LiveDocumentSync = {
  featureFlag: "experimental_live_file_sync",
  toggleFeature: async function (updatedStatus = false) {
    return await postJson("/experimental/toggle-live-sync", { updatedStatus })
      .then((res) => res)
      .then(() => true)
      .catch((e) => {
        console.error(e);
        return false;
      });
  },
  queues: async function () {
    return await getJson("/experimental/live-sync/queues")
      .then(({ data }) => data)
      .then((res) => res?.queues || [])
      .catch((e) => {
        console.error(e);
        return [];
      });
  },

  // Should be in Workspaces but is here for now while in preview
  setWatchStatusForDocument: async function (slug, docPath, watchStatus) {
    return postJson(`/workspace/${slug}/update-watch-status`, {
      docPath,
      watchStatus,
    })
      .then(() => true)
      .catch((e) => {
        console.error(e);
        return false;
      });
  },
};

export default LiveDocumentSync;
