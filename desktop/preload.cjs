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
