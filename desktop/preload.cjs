const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopRuntime", {
  getStartupError: () => ipcRenderer.invoke("desktop:get-startup-error"),
  retryStart: () => ipcRenderer.invoke("desktop:retry-start"),
  chooseStorageDir: () => ipcRenderer.invoke("desktop:choose-storage-dir"),
  onStartupError: (callback) =>
    ipcRenderer.on("desktop-startup-error", (_, payload) => callback(payload)),
});
