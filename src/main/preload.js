const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopApi", {
  getState: () => ipcRenderer.invoke("app:get-state"),
  updateSection: (section, payload) => ipcRenderer.invoke("app:update-section", section, payload),
  startProxy: (payload) => ipcRenderer.invoke("proxy:start", payload),
  stopProxy: () => ipcRenderer.invoke("proxy:stop"),
  clearProxy: () => ipcRenderer.invoke("proxy:clear"),
  trustCertificate: () => ipcRenderer.invoke("proxy:trust-cert"),
  revealCertificate: () => ipcRenderer.invoke("proxy:reveal-cert"),
  openProxySettings: () => ipcRenderer.invoke("proxy:open-settings"),
  enableSystemProxy: () => ipcRenderer.invoke("proxy:enable-system"),
  disableSystemProxy: () => ipcRenderer.invoke("proxy:disable-system"),
  getSessionSummary: () => ipcRenderer.invoke("session:get-summary"),
  startBooking: (task) => ipcRenderer.invoke("booking:start", task),
  stopBooking: () => ipcRenderer.invoke("booking:stop"),
  openExternal: (url) => ipcRenderer.invoke("app:open-external", url),
  onProxyStatus: (callback) => ipcRenderer.on("proxy:status", (_event, payload) => callback(payload)),
  onProxyLog: (callback) => ipcRenderer.on("proxy:log", (_event, payload) => callback(payload)),
  onSessionUpdate: (callback) => ipcRenderer.on("session:update", (_event, payload) => callback(payload)),
  onBookingStatus: (callback) => ipcRenderer.on("booking:status", (_event, payload) => callback(payload)),
  onBookingLog: (callback) => ipcRenderer.on("booking:log", (_event, payload) => callback(payload)),
  onBookingHit: (callback) => ipcRenderer.on("booking:hit", (_event, payload) => callback(payload))
});
