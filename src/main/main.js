const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, ipcMain, shell, dialog, session: electronSession } = require("electron");
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
  loadEnvFiles(userDataDir);

  store = new StateStore(userDataDir);
  proxyService = new ProxyService(userDataDir);
  bookingService = new BookingService({
    executeInPage: (apiPath, payload) => proxyService.executeInPage(apiPath, payload)
  });

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
  const summary = mergeSessionSummaries(store?.get()?.sessionData, buildSessionSummary(proxyService.getEntries()));
  applyCapturedSecrets(summary);
  return summary;
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

ipcMain.handle("app:clear-cache", async () => {
  proxyService.clearEntries();
  const current = store.get();
  store.set({
    sessionData: null,
    booking: {
      ...store.defaultState().booking
    },
    proxy: {
      ...current.proxy
    }
  });

  await electronSession.defaultSession.clearCache();
  await electronSession.defaultSession.clearStorageData({
    storages: ["appcache", "cookies", "filesystem", "indexdb", "localstorage", "shadercache", "websql", "serviceworkers", "cachestorage"]
  });

  const sessionSummary = getSessionSummary();
  emit("session:update", sessionSummary);
  emit("proxy:status", proxyService.getStatus());
  return {
    persisted: store.get(),
    proxy: proxyService.getStatus(),
    session: sessionSummary,
    booking: bookingService.getStatus()
  };
});

ipcMain.handle("config:import-secrets", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "导入接口配置",
    properties: ["openFile"],
    filters: [
      { name: "Config", extensions: ["env", "json"] },
      { name: "All Files", extensions: ["*"] }
    ]
  });
  if (result.canceled || !result.filePaths?.[0]) {
    return { canceled: true };
  }

  const normalized = normalizeSecrets(parseSecretsFile(result.filePaths[0]));
  const missing = ["TRASEN_APP_ID", "TRASEN_APP_SECRET", "TRASEN_AES_KEY"].filter((key) => !normalized[key]);
  if (missing.length > 0) {
    throw new Error("接口配置文件缺少: " + missing.join(", "));
  }

  Object.assign(process.env, normalized);
  const envPath = path.join(app.getPath("userData"), ".env");
  fs.writeFileSync(
    envPath,
    [
      "TRASEN_APP_ID=" + normalized.TRASEN_APP_ID,
      "TRASEN_APP_SECRET=" + normalized.TRASEN_APP_SECRET,
      "TRASEN_AES_KEY=" + normalized.TRASEN_AES_KEY,
      ""
    ].join("\n"),
    "utf8"
  );

  return {
    canceled: false,
    filePath: result.filePaths[0],
    savedTo: envPath
  };
});

ipcMain.handle("proxy:start", async (_event, payload) => {
  const next = await proxyService.start(payload);
  emit("proxy:status", next);
  return next;
});

ipcMain.handle("proxy:start-all", async (_event, payload) => {
  const status = await proxyService.start(payload);
  emit("proxy:status", status);

  try {
    await proxyService.trustCertificate();
  } catch (error) {
    emit("proxy:log", "Certificate trust step failed: " + (error.message || error));
  }

  try {
    await proxyService.enableSystemProxy();
  } catch (error) {
    emit("proxy:log", "System proxy enable step failed: " + (error.message || error));
  }

  const next = proxyService.getStatus();
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

ipcMain.handle("session:export", async () => {
  const summary = getSessionSummary();
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "导出会话文件",
    defaultPath: "autobuy-session.json",
    filters: [{ name: "JSON", extensions: ["json"] }]
  });
  if (result.canceled || !result.filePath) {
    return { canceled: true };
  }

  fs.writeFileSync(
    result.filePath,
    JSON.stringify(
      {
        schema: "autobuy-session",
        version: 1,
        exportedAt: new Date().toISOString(),
        session: summary
      },
      null,
      2
    ),
    "utf8"
  );
  return { canceled: false, filePath: result.filePath };
});

ipcMain.handle("session:import", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "导入会话文件",
    properties: ["openFile"],
    filters: [{ name: "JSON", extensions: ["json"] }]
  });
  if (result.canceled || !result.filePaths?.[0]) {
    return { canceled: true };
  }

  const raw = fs.readFileSync(result.filePaths[0], "utf8");
  const parsed = JSON.parse(raw);
  const session = normalizeImportedSession(parsed.session || parsed);
  store.updateSection("sessionData", session);
  const next = getSessionSummary();
  emit("session:update", next);
  return { canceled: false, filePath: result.filePaths[0], session: next };
});

ipcMain.handle("session:refresh-metadata", async (_event, payload = {}) => {
  const current = getSessionSummary();
  const token = payload.token || current.tokensSeen[0] || "";
  const orgCode = payload.orgCode || current.orgCodesSeen[0] || "";
  if (!token) {
    throw new Error("没有可用 token，先采集或导入会话。");
  }
  if (!orgCode) {
    throw new Error("没有可用 orgCode，先采集或导入会话。");
  }

  const nextSession = normalizeImportedSession(current);
  const task = { token, orgCode };

  if (payload.doctors !== false && shouldRefreshDoctors(nextSession)) {
    try {
      const doctors = await bookingService.queryDoctors(task);
      nextSession.doctors = mergeDoctors(nextSession.doctors, doctors.map(normalizeDoctor));
    } catch (error) {
      emit("booking:log", "页面刷新医生列表未响应，继续使用已捕获资料: " + (error.message || error));
    }
  }

  if (payload.doctor && shouldRefreshPatients(nextSession)) {
    const regionId = payload.doctor.hospRegionCode || orgCode;
    try {
      const patients = await bookingService.queryPatients({
        token,
        orgCode: regionId || orgCode,
        regionId,
        orgId: payload.doctor.orgId || regionId
      });
      const normalized = normalizePatientsAndCards(patients);
      nextSession.patients = uniqueBy(nextSession.patients.concat(normalized.patients), (item) => String(item.id || ""));
      nextSession.cards = uniqueBy(nextSession.cards.concat(normalized.cards), (item) => String(item.id || ""));
    } catch (error) {
      emit("booking:log", "页面刷新就诊人未响应，继续使用已捕获资料: " + (error.message || error));
    }
  }

  store.updateSection("sessionData", nextSession);
  const merged = getSessionSummary();
  emit("session:update", merged);
  return merged;
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

function normalizeImportedSession(session) {
  if (!session || typeof session !== "object") {
    throw new Error("Invalid session file.");
  }

  return {
    tokensSeen: arrayOf(session.tokensSeen),
    tokenDetails: arrayOf(session.tokenDetails),
    orgCodesSeen: arrayOf(session.orgCodesSeen),
    appIdsSeen: arrayOf(session.appIdsSeen),
    appSecretsSeen: arrayOf(session.appSecretsSeen),
    aesKeysSeen: arrayOf(session.aesKeysSeen),
    patients: arrayOf(session.patients),
    cards: arrayOf(session.cards),
    doctors: arrayOf(session.doctors),
    scheduleRows: arrayOf(session.scheduleRows),
    scheduleTimes: arrayOf(session.scheduleTimes),
    orders: arrayOf(session.orders)
  };
}

function mergeSessionSummaries(importedSession, capturedSession) {
  const imported = normalizeImportedSession(importedSession || {});
  const captured = normalizeImportedSession(capturedSession || {});

  return {
    tokensSeen: uniqueByValue(imported.tokensSeen.concat(captured.tokensSeen)),
    tokenDetails: uniqueBy(imported.tokenDetails.concat(captured.tokenDetails), (item) => item.token || ""),
    orgCodesSeen: uniqueByValue(imported.orgCodesSeen.concat(captured.orgCodesSeen)),
    appIdsSeen: uniqueByValue(imported.appIdsSeen.concat(captured.appIdsSeen)),
    appSecretsSeen: uniqueByValue(imported.appSecretsSeen.concat(captured.appSecretsSeen)),
    aesKeysSeen: uniqueByValue(imported.aesKeysSeen.concat(captured.aesKeysSeen)),
    patients: uniqueBy(imported.patients.concat(captured.patients), (item) => String(item.id || "")),
    cards: uniqueBy(imported.cards.concat(captured.cards), (item) => String(item.id || "")),
    doctors: mergeDoctors(imported.doctors, captured.doctors),
    scheduleRows: imported.scheduleRows.concat(captured.scheduleRows),
    scheduleTimes: imported.scheduleTimes.concat(captured.scheduleTimes),
    orders: imported.orders.concat(captured.orders)
  };
}

function shouldRefreshDoctors(session) {
  return !session.doctors.length || session.doctors.some((doctor) => !doctor.doctorName);
}

function shouldRefreshPatients(session) {
  return !session.patients.length || !session.cards.length;
}

function mergeDoctors(existing, incoming) {
  const result = existing.slice();
  for (const doctor of incoming) {
    const match = result.find((item) => sameDoctor(item, doctor));
    if (match) {
      for (const [key, value] of Object.entries(doctor)) {
        if ((match[key] === undefined || match[key] === null || match[key] === "") && value) {
          match[key] = value;
        }
      }
    } else {
      result.push(doctor);
    }
  }
  return uniqueBy(
    result,
    (item) => [item.doctorCode, item.deptCode, item.hospRegionCode, item.doctorId].join("|")
  );
}

function sameDoctor(left, right) {
  return (
    String(left.doctorCode || "") === String(right.doctorCode || "") &&
    String(left.deptCode || "") === String(right.deptCode || "") &&
    String(left.hospRegionCode || "") === String(right.hospRegionCode || "")
  );
}

function arrayOf(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueByValue(items) {
  return Array.from(new Set(items.filter(Boolean).map((item) => String(item))));
}

function uniqueBy(items, keyOf) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = keyOf(item);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(item);
  }
  return result;
}

function applyCapturedSecrets(session) {
  const mappings = [
    ["TRASEN_APP_ID", session.appIdsSeen?.[0]],
    ["TRASEN_APP_SECRET", session.appSecretsSeen?.[0]],
    ["TRASEN_AES_KEY", session.aesKeysSeen?.[0]]
  ];
  for (const [key, value] of mappings) {
    if (!process.env[key] && value) {
      process.env[key] = String(value);
    }
  }
}

function normalizeDoctor(item) {
  return {
    doctorId: item.doctorId,
    doctorCode: item.doctorCode,
    doctorName: item.doctorName,
    deptId: item.deptId,
    deptCode: item.deptCode,
    deptName: item.deptName,
    hospRegionCode: item.hospRegionCode,
    hospRegionName: item.hospRegionName,
    levelName: item.levelName,
    scheduleDateList: item.scheduleDateList,
    scheduleDates: item.scheduleDates
  };
}

function normalizePatientsAndCards(rawPatients) {
  const patients = [];
  const cards = [];
  for (const patient of rawPatients || []) {
    patients.push({
      id: patient.id,
      name: patient.name,
      certificateType: patient.certificateType,
      certificateNoMasked: patient.certificateNoMasked,
      birthday: patient.birthday,
      regionId: patient.regionId
    });
    for (const card of patient.wisdomPatientCardList || []) {
      cards.push({
        patientId: patient.id,
        id: card.id,
        cardType: card.cardType,
        cardNoMasked: card.cardNoMasked,
        cardNo: card.cardNo
      });
    }
  }
  return { patients, cards };
}

function loadEnvFiles(userDataDir) {
  const candidates = [
    path.join(process.cwd(), ".env"),
    path.join(path.dirname(app.getPath("exe")), ".env"),
    path.join(userDataDir, ".env")
  ];

  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) {
      continue;
    }
    const raw = fs.readFileSync(filePath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      const index = trimmed.indexOf("=");
      if (index <= 0) {
        continue;
      }
      const key = trimmed.slice(0, index).trim();
      const value = unquoteEnvValue(trimmed.slice(index + 1).trim());
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  }
}

function unquoteEnvValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseSecretsFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  if (path.extname(filePath).toLowerCase() === ".json") {
    return JSON.parse(raw);
  }

  const parsed = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const index = trimmed.indexOf("=");
    if (index <= 0) {
      continue;
    }
    parsed[trimmed.slice(0, index).trim()] = unquoteEnvValue(trimmed.slice(index + 1).trim());
  }
  return parsed;
}

function normalizeSecrets(input) {
  return {
    TRASEN_APP_ID: String(input.TRASEN_APP_ID || input.appid || input.appId || ""),
    TRASEN_APP_SECRET: String(input.TRASEN_APP_SECRET || input.app_secret || input.appSecret || ""),
    TRASEN_AES_KEY: String(input.TRASEN_AES_KEY || input.aes_key || input.aesKey || "")
  };
}
