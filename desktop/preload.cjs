const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopRuntime", {
  getStartupError: () => ipcRenderer.invoke("desktop:get-startup-error"),
  retryStart: () => ipcRenderer.invoke("desktop:retry-start"),
  chooseStorageDir: () => ipcRenderer.invoke("desktop:choose-storage-dir"),
  onStartupError: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("desktop-startup-error", listener);
    return () => ipcRenderer.removeListener("desktop-startup-error", listener);
  },
});

contextBridge.exposeInMainWorld("athenaBrowserNode", {
  nodeId: () => ipcRenderer.sendSync("browser-node:info")?.nodeId,
  version: () => process.versions.electron,
  capabilities: () =>
    ipcRenderer.sendSync("browser-node:info")?.capabilities || {},
  attach: (options) => ipcRenderer.invoke("browser-node:attach", options),
  detach: () => ipcRenderer.invoke("browser-node:detach"),
  setBounds: (bounds) => ipcRenderer.invoke("browser-node:set-bounds", bounds),
  navigate: (url) => ipcRenderer.invoke("browser-node:navigate", url),
  command: (action) => ipcRenderer.invoke("browser-node:command", action),
  newTab: (url) => ipcRenderer.invoke("browser-node:new-tab", url),
  selectTab: (tabId) => ipcRenderer.invoke("browser-node:select-tab", tabId),
  closeTab: (tabId) => ipcRenderer.invoke("browser-node:close-tab", tabId),
  cookies: () => ipcRenderer.invoke("browser-node:cookies"),
  clearCookieSite: (domain) =>
    ipcRenderer.invoke("browser-node:clear-cookie-site", domain),
  permissionSummary: () =>
    ipcRenderer.invoke("browser-node:permission-summary"),
  setSitePermission: (name, allowed) =>
    ipcRenderer.invoke("browser-node:set-site-permission", name, allowed),
  find: (term) => ipcRenderer.invoke("browser-node:find", term),
  setZoom: (factor) => ipcRenderer.invoke("browser-node:set-zoom", factor),
  capture: () => ipcRenderer.invoke("browser-node:capture"),
  printToPdf: () => ipcRenderer.invoke("browser-node:print-to-pdf"),
  installEgressConfig: (sealedConfig) =>
    ipcRenderer.invoke("browser-node:install-egress-config", sealedConfig),
  applyNetworkRoute: (networkRoute) =>
    ipcRenderer.invoke("browser-node:apply-network-route", networkRoute),
  openSystemChrome: (options) =>
    ipcRenderer.invoke("browser-node:open-system-chrome", options),
  onState: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("browser-node:state", listener);
    return () => ipcRenderer.removeListener("browser-node:state", listener);
  },
});
