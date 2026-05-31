import LiveSyncToggle from "./Features/LiveSync/toggle";

export const configurableFeatures = {
  experimental_live_file_sync: {
    title: "Live Document Sync",
    titleKey: "experimental-features.liveSync.navTitle",
    component: LiveSyncToggle,
    key: "experimental_live_file_sync",
  },
};
