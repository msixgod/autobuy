const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, ipcMain, shell } = require("electron");
const { StateStore } = require("./stateStore");
const { ProxyService } = require("./proxyService");
const { BookingService } = require("./bookingService");
const { buildSessionSummary } = require("./summaryExtractor");

let mainWindow = null;
let store = null;
let proxyService = null;
let bookingService = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1300,
    height: 900,
    minWidth: 1080,
    minHeight: 760,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
}

function emit(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

app.whenReady().then(() => {
  const userDataDir = app.getPath("userData");
  fs.mkdirSync(userDataDir, { recursive: true });

  store = new StateStore(userDataDir);
  proxyService = new ProxyService(userDataDir);
  bookingService = new BookingService();

  proxyService.on("log", (message) => emit("proxy:log", message));
  proxyService.on("entry", () => emit("session:update", getSessionSummary()));

  bookingService.on("status", (status) => emit("booking:status", status));
  bookingService.on("log", (message) => emit("booking:log", message));
  bookingService.on("hit", (payload) => emit("booking:hit", payload));

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("before-quit", () => {
  proxyService?.stop().catch(() => {});
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

function getSessionSummary() {
  return buildSessionSummary(proxyService.getEntries());
}

ipcMain.handle("app:get-state", async () => {
  return {
    persisted: store.get(),
    proxy: proxyService.getStatus(),
    session: getSessionSummary(),
    booking: bookingService.getStatus()
  };
});

ipcMain.handle("app:update-section", async (_event, section, payload) => {
  return store.updateSection(section, payload);
});

ipcMain.handle("proxy:start", async (_event, payload) => {
  const next = await proxyService.start(payload);
  emit("proxy:status", next);
  return next;
});

ipcMain.handle("proxy:stop", async () => {
  const next = await proxyService.stop();
  emit("proxy:status", next);
  return next;
});

ipcMain.handle("proxy:clear", async () => {
  proxyService.clearEntries();
  emit("session:update", getSessionSummary());
  return proxyService.getStatus();
});

ipcMain.handle("proxy:trust-cert", async () => {
  return proxyService.trustCertificate();
});

ipcMain.handle("proxy:reveal-cert", async () => {
  return proxyService.revealCertificate();
});

ipcMain.handle("proxy:open-settings", async () => {
  return proxyService.openProxySettings();
});

ipcMain.handle("proxy:enable-system", async () => {
  const next = await proxyService.enableSystemProxy();
  emit("proxy:status", proxyService.getStatus());
  return next;
});

ipcMain.handle("proxy:disable-system", async () => {
  const next = await proxyService.disableSystemProxy();
  emit("proxy:status", proxyService.getStatus());
  return next;
});

ipcMain.handle("session:get-summary", async () => {
  return getSessionSummary();
});

ipcMain.handle("booking:start", async (_event, task) => {
  const mergedTask = {
    ...store.get().booking,
    ...task
  };
  return bookingService.start(mergedTask);
});

ipcMain.handle("booking:stop", async () => {
  return bookingService.stop();
});

ipcMain.handle("app:open-external", async (_event, target) => {
  return shell.openExternal(target);
});
