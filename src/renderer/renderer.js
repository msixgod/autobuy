const state = {
  persisted: {
    proxy: {},
    booking: {}
  },
  proxy: null,
  session: null,
  booking: null
};

const refs = {};
let scheduledBookingTimer = null;
let metadataRefreshInFlight = false;

function $(id) {
  return document.getElementById(id);
}

function boot() {
  bindRefs();
  bindActions();
  subscribeEvents();
  refreshAll();
}

function bindRefs() {
  refs.globalStatus = $("global-status");
  refs.proxyHost = $("proxy-host");
  refs.proxyPort = $("proxy-port");
  refs.proxyStatus = $("proxy-status");
  refs.proxyLog = $("proxy-log");
  refs.proxyPill = $("proxy-pill");
  refs.sessionPill = $("session-pill");
  refs.bookingPill = $("booking-pill");
  refs.summaryTokenCount = $("summary-token-count");
  refs.summaryPatientCount = $("summary-patient-count");
  refs.summaryCardCount = $("summary-card-count");
  refs.summaryDoctorCount = $("summary-doctor-count");
  refs.tokenPreview = $("token-preview");
  refs.tokenExpiry = $("token-expiry");
  refs.orgcodePreview = $("orgcode-preview");
  refs.departmentSelect = $("department-select");
  refs.doctorSelect = $("doctor-select");
  refs.patientSelect = $("patient-select");
  refs.cardSelect = $("card-select");
  refs.dateMode = $("date-mode");
  refs.registerDate = $("register-date");
  refs.endDate = $("end-date");
  refs.noonSelect = $("noon-select");
  refs.startTime = $("start-time");
  refs.startAt = $("start-at");
  refs.pollInterval = $("poll-interval");
  refs.alertOnly = $("alert-only");
  refs.bookingLog = $("booking-log");
  refs.bookingHit = $("booking-hit");
}

function bindActions() {
  $("refresh-all").addEventListener("click", refreshAll);

  $("proxy-start-all").addEventListener("click", async () => {
    try {
      const payload = {
        host: refs.proxyHost.value.trim() || "127.0.0.1",
        port: Number(refs.proxyPort.value || 8080)
      };
      await window.desktopApi.updateSection("proxy", payload);
      appendLog(refs.proxyLog, "正在启动抓包、信任证书并启用系统代理。");
      state.proxy = await window.desktopApi.startProxyAll(payload);
      renderProxy();
    } catch (error) {
      appendLog(refs.proxyLog, "启动采集环境失败: " + formatError(error));
    }
  });

  $("proxy-stop").addEventListener("click", async () => {
    try {
      state.proxy = await window.desktopApi.stopProxy();
      renderProxy();
    } catch (error) {
      appendLog(refs.proxyLog, "停止采集环境失败: " + formatError(error));
    }
  });

  $("proxy-clear").addEventListener("click", async () => {
    try {
      state.proxy = await window.desktopApi.clearProxy();
      state.session = await window.desktopApi.getSessionSummary();
      renderProxy();
      renderSession();
      renderBookingOptions();
    } catch (error) {
      appendLog(refs.proxyLog, "清空抓包记录失败: " + formatError(error));
    }
  });

  $("clear-cache").addEventListener("click", async () => {
    try {
      clearScheduledBooking();
      const snapshot = await window.desktopApi.clearCache();
      state.persisted = snapshot.persisted || { proxy: {}, booking: {} };
      state.proxy = snapshot.proxy || null;
      state.session = snapshot.session || null;
      state.booking = snapshot.booking || null;
      refs.proxyLog.textContent = "";
      refs.bookingLog.textContent = "";
      refs.bookingHit.textContent = "暂无命中记录";
      hydratePersisted();
      renderGlobalStatus();
      renderProxy();
      renderSession();
      renderBookingOptions();
      renderBookingStatus(state.booking?.running);
      appendLog(refs.proxyLog, "缓存已清空。");
    } catch (error) {
      appendLog(refs.proxyLog, "清空缓存失败: " + formatError(error));
    }
  });

  $("session-export").addEventListener("click", async () => {
    try {
      const result = await window.desktopApi.exportSession();
      if (!result?.canceled) {
        appendLog(refs.bookingLog, "会话文件已导出: " + result.filePath);
      }
    } catch (error) {
      appendLog(refs.bookingLog, "导出会话文件失败: " + formatError(error));
    }
  });

  $("session-import").addEventListener("click", async () => {
    try {
      const result = await window.desktopApi.importSession();
      if (!result?.canceled) {
        state.session = result.session;
        renderSession();
        renderBookingOptions();
        appendLog(refs.bookingLog, "会话文件已导入: " + result.filePath);
        refreshSessionMetadata({ doctors: true });
      }
    } catch (error) {
      appendLog(refs.bookingLog, "导入会话文件失败: " + formatError(error));
    }
  });

  $("session-refresh-metadata").addEventListener("click", () => {
    const doctor = getSelectedDoctor();
    refreshSessionMetadata({
      doctors: true,
      doctor: doctor ? pickDoctorMetadata(doctor) : null
    });
  });

  refs.departmentSelect.addEventListener("change", async () => {
    await persistBookingSection({ departmentName: refs.departmentSelect.value, doctorKey: "" });
    renderBookingOptions();
  });

  refs.doctorSelect.addEventListener("change", async () => {
    await persistBookingSection({ doctorKey: refs.doctorSelect.value });
    renderBookingOptions();
    const doctor = getSelectedDoctor();
    if (doctor && (!state.session?.patients?.length || !state.session?.cards?.length)) {
      refreshSessionMetadata({ doctors: false, doctor: pickDoctorMetadata(doctor) });
    }
  });

  refs.patientSelect.addEventListener("change", async () => {
    await persistBookingSection({ patientId: refs.patientSelect.value, cardId: "" });
    renderBookingOptions();
  });

  refs.cardSelect.addEventListener("change", () => persistBookingSection({ cardId: refs.cardSelect.value }));
  refs.dateMode.addEventListener("change", () => persistBookingSection({ dateMode: refs.dateMode.value }));
  refs.registerDate.addEventListener("change", () => persistBookingSection({ registerDate: refs.registerDate.value }));
  refs.endDate.addEventListener("change", () => persistBookingSection({ endDate: refs.endDate.value }));
  refs.noonSelect.addEventListener("change", () => persistBookingSection({ noon: refs.noonSelect.value }));
  refs.startTime.addEventListener("input", () => persistBookingSection({ startTime: refs.startTime.value.trim() }));
  refs.startAt.addEventListener("change", () => persistBookingSection({ startAt: refs.startAt.value }));
  refs.pollInterval.addEventListener("change", () =>
    persistBookingSection({ pollIntervalSeconds: Number(refs.pollInterval.value || 3) })
  );
  refs.alertOnly.addEventListener("change", () => persistBookingSection({ alertOnly: refs.alertOnly.checked }));

  $("save-task").addEventListener("click", async () => {
    await persistBookingSection(readBookingForm());
    appendLog(refs.bookingLog, "配置已保存。");
  });

  $("booking-start").addEventListener("click", async () => {
    try {
      const task = buildTaskPayload();
      await persistBookingSection(task.persistOnly);
      scheduleBookingStart(task.runtimeOnly, task.persistOnly.startAt);
    } catch (error) {
      appendLog(refs.bookingLog, "启动任务失败: " + formatError(error));
    }
  });

  $("booking-stop").addEventListener("click", async () => {
    try {
      clearScheduledBooking();
      await window.desktopApi.stopBooking();
      renderBookingStatus(false);
    } catch (error) {
      appendLog(refs.bookingLog, "停止任务失败: " + formatError(error));
    }
  });
}

function subscribeEvents() {
  window.desktopApi.onProxyStatus((status) => {
    state.proxy = status;
    renderProxy();
  });

  window.desktopApi.onProxyLog((message) => appendLog(refs.proxyLog, message));

  window.desktopApi.onSessionUpdate((session) => {
    state.session = session;
    renderSession();
    renderBookingOptions();
  });

  window.desktopApi.onBookingStatus((booking) => {
    state.booking = booking;
    renderBookingStatus(booking?.running);
  });

  window.desktopApi.onBookingLog((message) => appendLog(refs.bookingLog, message));

  window.desktopApi.onBookingHit((payload) => {
    renderBookingStatus(false);
    if (payload.alertOnly) {
      refs.bookingHit.textContent =
        "命中号源: " + payload.row.registerDate + " " + payload.slot.startTime + "-" + payload.slot.endTime;
      return;
    }

    if (payload.paymentUrl) {
      refs.bookingHit.innerHTML =
        '下单成功，支付地址：<a href="#" id="payment-link">点击打开支付页</a>';
      const link = $("payment-link");
      link?.addEventListener("click", (event) => {
        event.preventDefault();
        window.desktopApi.openExternal(payload.paymentUrl);
      });
      return;
    }

    refs.bookingHit.textContent = "下单成功，但没有返回支付地址。";
  });
}

async function refreshAll() {
  const snapshot = await window.desktopApi.getState();
  state.persisted = snapshot.persisted || { proxy: {}, booking: {} };
  state.proxy = snapshot.proxy || null;
  state.session = snapshot.session || null;
  state.booking = snapshot.booking || null;
  hydratePersisted();
  renderGlobalStatus();
  renderProxy();
  renderSession();
  renderBookingOptions();
  renderBookingStatus(state.booking?.running);
}

function hydratePersisted() {
  const persisted = state.persisted || {};
  refs.proxyHost.value = persisted.proxy?.host || "127.0.0.1";
  refs.proxyPort.value = String(persisted.proxy?.port || 8080);
  refs.dateMode.value = persisted.booking?.dateMode || "earliest";
  refs.registerDate.value = persisted.booking?.registerDate || "";
  refs.endDate.value = persisted.booking?.endDate || "";
  refs.noonSelect.value = persisted.booking?.noon || "1";
  refs.startTime.value = persisted.booking?.startTime || "";
  refs.startAt.value = persisted.booking?.startAt || "";
  refs.pollInterval.value = String(persisted.booking?.pollIntervalSeconds || 3);
  refs.alertOnly.checked = !!persisted.booking?.alertOnly;
}

function renderGlobalStatus() {
  const token = state.session?.tokensSeen?.[0] || "未捕获";
  const orgCode = state.session?.orgCodesSeen?.[0] || "未捕获";
  const tokenExpiry = getTokenExpiryText();
  const hasApiConfig =
    !!state.session?.appIdsSeen?.length &&
    !!state.session?.appSecretsSeen?.length &&
    !!state.session?.aesKeysSeen?.length;
  const lines = [
    { label: "抓包内核", value: state.proxy?.running ? "运行中" : "未启动" },
    { label: "系统代理", value: state.proxy?.systemProxy?.enabled ? "已启用" : "未启用" },
    { label: "证书路径", value: state.proxy?.certPath || "-" },
    { label: "会话 Token", value: maskToken(token) },
    { label: "Token 过期", value: tokenExpiry || "-" },
    { label: "orgCode", value: orgCode },
    { label: "接口配置", value: hasApiConfig ? "已捕获" : "未完整" }
  ];
  refs.globalStatus.innerHTML = lines
    .map((line) => `<div><span>${escapeHtml(line.label)}</span><strong>${escapeHtml(line.value)}</strong></div>`)
    .join("");
}

function renderProxy() {
  const status = state.proxy || {};
  refs.proxyPill.textContent = status.running ? "运行中" : "未启动";
  refs.proxyPill.className = status.running ? "pill pill-active" : "pill pill-idle";
  refs.proxyStatus.innerHTML =
    `<p><strong>监听:</strong> ${escapeHtml(String(status.host || "-"))}:${escapeHtml(String(status.port || "-"))}</p>` +
    `<p><strong>系统代理:</strong> ${escapeHtml(status.systemProxy?.enabled ? "已启用" : "未启用")} ${status.systemProxy?.server ? "(" + escapeHtml(status.systemProxy.server) + ")" : ""}</p>` +
    `<p><strong>证书:</strong> ${escapeHtml(status.certPath || "-")}</p>` +
    `<p><strong>代理流量:</strong> tunnel ${escapeHtml(String(status.totalTunnels || 0))} / request ${escapeHtml(String(status.totalRequests || 0))}</p>` +
    `<p><strong>已抓到接口:</strong> ${escapeHtml(String(status.entriesCount || 0))} 条</p>` +
    `<p><strong>最近主机:</strong> ${escapeHtml((status.recentHosts || []).join(", ") || "-")}</p>`;
  renderGlobalStatus();
}

function renderSession() {
  const session = state.session || { tokensSeen: [], patients: [], cards: [], doctors: [], orgCodesSeen: [] };
  refs.sessionPill.textContent = session.tokensSeen.length ? "已捕获" : "未捕获";
  refs.sessionPill.className = session.tokensSeen.length ? "pill pill-active" : "pill pill-idle";
  refs.summaryTokenCount.textContent = String(session.tokensSeen.length);
  refs.summaryPatientCount.textContent = String(session.patients.length);
  refs.summaryCardCount.textContent = String(session.cards.length);
  refs.summaryDoctorCount.textContent = String(session.doctors.length);
  refs.tokenPreview.value = session.tokensSeen.join("\n");
  refs.tokenExpiry.value = getTokenExpiryText();
  refs.orgcodePreview.value = session.orgCodesSeen.join("\n");
  renderGlobalStatus();
}

function renderBookingOptions() {
  const booking = state.persisted?.booking || {};
  const session = state.session || { doctors: [], patients: [], cards: [] };

  populateSelect(
    refs.departmentSelect,
    uniqueByKey(session.doctors, departmentKeyOf)
      .map((doctor) => ({
        value: departmentKeyOf(doctor),
        label: departmentLabelOf(doctor)
      }))
      .sort((a, b) => a.label.localeCompare(b.label, "zh-CN")),
    booking.departmentName,
    "请选择院区 / 门诊部 / 科室"
  );

  const doctorOptions = session.doctors
    .filter((doctor) => !booking.departmentName || departmentKeyOf(doctor) === booking.departmentName)
    .map((doctor) => ({
      value: doctorKeyOf(doctor),
      label: doctorNameOf(doctor)
    }));
  populateSelect(refs.doctorSelect, doctorOptions, booking.doctorKey, "请选择医生");

  const patientOptions = session.patients.map((patient) => ({
    value: String(patient.id),
    label: `${patient.name} | ${patient.certificateNoMasked || ""}`
  }));
  populateSelect(refs.patientSelect, patientOptions, booking.patientId, "请选择就诊人");

  const cardOptions = session.cards
    .filter((card) => !booking.patientId || String(card.patientId) === String(booking.patientId))
    .map((card) => ({
      value: String(card.id),
      label: `${cardTypeLabel(card.cardType)} | ${card.cardNoMasked || card.cardNo || ""}`
    }));
  populateSelect(refs.cardSelect, cardOptions, booking.cardId, "请选择就诊卡");
}

async function refreshSessionMetadata(payload) {
  if (metadataRefreshInFlight) {
    return;
  }
  if (!state.session?.tokensSeen?.length) {
    appendLog(refs.bookingLog, "没有 token，无法刷新医生和就诊人资料。");
    return;
  }

  metadataRefreshInFlight = true;
  try {
    appendLog(refs.bookingLog, "正在通过已捕获登录态刷新医生和就诊人资料。");
    state.session = await window.desktopApi.refreshSessionMetadata(payload || { doctors: true });
    renderSession();
    renderBookingOptions();
    appendLog(
      refs.bookingLog,
      "资料刷新完成: 医生 " +
        String(state.session?.doctors?.length || 0) +
        " / 就诊人 " +
        String(state.session?.patients?.length || 0) +
        " / 就诊卡 " +
        String(state.session?.cards?.length || 0)
    );
  } catch (error) {
    appendLog(refs.bookingLog, "刷新资料失败: " + formatError(error));
  } finally {
    metadataRefreshInFlight = false;
  }
}

function renderBookingStatus(running) {
  refs.bookingPill.textContent = running ? "运行中" : "空闲";
  refs.bookingPill.className = running ? "pill pill-active" : "pill pill-idle";
}

function populateSelect(element, options, selectedValue, placeholder) {
  const current = String(selectedValue || "");
  const items = [`<option value="">${escapeHtml(placeholder)}</option>`].concat(
    options.map((option) => {
      const selected = current === String(option.value) ? " selected" : "";
      return `<option value="${escapeHtml(String(option.value))}"${selected}>${escapeHtml(option.label)}</option>`;
    })
  );
  element.innerHTML = items.join("");
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean))).sort((a, b) => a.localeCompare(b, "zh-CN"));
}

function uniqueByKey(items, keyOf) {
  const seen = new Set();
  const result = [];
  for (const item of items || []) {
    const key = keyOf(item);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(item);
  }
  return result;
}

function departmentKeyOf(doctor) {
  return [doctor.hospRegionCode, doctor.hospRegionName, doctor.deptId, doctor.deptCode, doctor.deptName].join("|");
}

function departmentLabelOf(doctor) {
  return [doctor.hospRegionName, doctor.deptName]
    .filter(Boolean)
    .join(" / ") || "已访问科室";
}

function doctorNameOf(doctor) {
  return doctor.doctorName || "医生姓名待刷新";
}

function doctorKeyOf(doctor) {
  return [doctor.doctorCode, doctor.deptCode, doctor.hospRegionCode, doctor.doctorId].join("|");
}

function getSelectedDoctor() {
  const key = state.persisted?.booking?.doctorKey;
  return state.session?.doctors?.find((doctor) => doctorKeyOf(doctor) === key) || null;
}

function pickDoctorMetadata(doctor) {
  return {
    doctorId: doctor.doctorId,
    doctorCode: doctor.doctorCode,
    deptId: doctor.deptId,
    deptCode: doctor.deptCode,
    hospRegionCode: doctor.hospRegionCode,
    orgId: doctor.hospRegionCode
  };
}

function readBookingForm() {
  return {
    departmentName: refs.departmentSelect.value,
    doctorKey: refs.doctorSelect.value,
    patientId: refs.patientSelect.value,
    cardId: refs.cardSelect.value,
    dateMode: refs.dateMode.value,
    registerDate: refs.registerDate.value,
    endDate: refs.endDate.value,
    noon: refs.noonSelect.value,
    startTime: refs.startTime.value.trim(),
    startAt: refs.startAt.value,
    pollIntervalSeconds: Number(refs.pollInterval.value || 3),
    alertOnly: refs.alertOnly.checked
  };
}

function buildTaskPayload() {
  const booking = readBookingForm();
  const doctor = state.session?.doctors?.find((item) => doctorKeyOf(item) === booking.doctorKey);
  if (!doctor) {
    if (!state.session?.doctors?.length) {
      throw new Error("还没有医生列表。请先启动采集环境，并在 PC 微信里进入目标医生页面。");
    }
    throw new Error("请先选择医生。");
  }

  const token = state.session?.tokensSeen?.[0];
  const orgCode = doctor.hospRegionCode || state.session?.orgCodesSeen?.[0] || "";
  if (!token) {
    throw new Error("还没有捕获到 token，请先启动抓包并在 PC 微信里打开页面。");
  }
  if (!booking.alertOnly && (!booking.patientId || !booking.cardId)) {
    throw new Error("请选择就诊人和就诊卡。");
  }

  return {
    persistOnly: booking,
    runtimeOnly: {
      token,
      orgCode,
      deptId: doctor.deptId,
      deptCode: doctor.deptCode,
      doctorId: doctor.doctorId,
      doctorCode: doctor.doctorCode,
      patientId: booking.patientId,
      cardId: booking.cardId,
      dateMode: booking.dateMode,
      registerDate: booking.registerDate,
      endDate: booking.endDate,
      noon: booking.noon,
      startTime: booking.startTime,
      pollIntervalSeconds: booking.pollIntervalSeconds,
      alertOnly: booking.alertOnly
    }
  };
}

function scheduleBookingStart(runtimeTask, startAtValue) {
  clearScheduledBooking();

  const startAt = startAtValue ? new Date(startAtValue) : null;
  const delayMs = startAt && !Number.isNaN(startAt.getTime()) ? startAt.getTime() - Date.now() : 0;

  if (delayMs > 0) {
    scheduledBookingTimer = window.setTimeout(() => {
      scheduledBookingTimer = null;
      startBookingNow(runtimeTask);
    }, delayMs);
    renderBookingStatus(false);
    refs.bookingPill.textContent = "等待启动";
    refs.bookingPill.className = "pill pill-active";
    appendLog(refs.bookingLog, "已预约监听启动时间: " + startAt.toLocaleString("zh-CN", { hour12: false }));
    return;
  }

  startBookingNow(runtimeTask);
}

function startBookingNow(runtimeTask) {
  renderBookingStatus(true);
  appendLog(refs.bookingLog, "开始监听目标号源。");
  window.desktopApi.startBooking(runtimeTask).catch((error) => {
    appendLog(refs.bookingLog, "自动任务失败: " + formatError(error));
    renderBookingStatus(false);
  });
}

function clearScheduledBooking() {
  if (scheduledBookingTimer) {
    window.clearTimeout(scheduledBookingTimer);
    scheduledBookingTimer = null;
    appendLog(refs.bookingLog, "已取消预约监听。");
  }
}

async function persistBookingSection(payload) {
  const next = await window.desktopApi.updateSection("booking", payload);
  state.persisted = state.persisted || { proxy: {}, booking: {} };
  state.persisted.booking = next;
  renderBookingOptions();
  renderGlobalStatus();
}

function appendLog(element, message) {
  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  element.textContent += `[${time}] ${message}\n`;
  element.scrollTop = element.scrollHeight;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatError(error) {
  return error?.message || String(error);
}

function maskToken(token) {
  const value = String(token || "");
  if (!value || value === "未捕获") {
    return value || "未捕获";
  }
  return value.slice(0, 6) + "..." + value.slice(-4);
}

function getTokenExpiryText() {
  const session = state.session || {};
  const firstToken = session.tokensSeen?.[0] || "";
  const detail = session.tokenDetails?.find((item) => item.token === firstToken);
  const expIso = detail?.jwt?.expIso || decodeJwtExpiry(firstToken);
  if (!expIso) {
    return "";
  }

  const date = new Date(expIso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const seconds = Math.floor((date.getTime() - Date.now()) / 1000);
  const remaining = seconds > 0 ? "剩余 " + formatDuration(seconds) : "已过期";
  return date.toLocaleString("zh-CN", { hour12: false }) + " (" + remaining + ")";
}

function decodeJwtExpiry(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) {
    return "";
  }
  try {
    let payloadText = parts[1].replaceAll("-", "+").replaceAll("_", "/");
    while (payloadText.length % 4) {
      payloadText += "=";
    }
    const payload = JSON.parse(atob(payloadText));
    return payload.exp ? new Date(Number(payload.exp) * 1000).toISOString() : "";
  } catch (_error) {
    return "";
  }
}

function formatDuration(totalSeconds) {
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (days > 0) {
    return days + "天" + hours + "小时";
  }
  if (hours > 0) {
    return hours + "小时" + minutes + "分钟";
  }
  return Math.max(0, minutes) + "分钟";
}

function cardTypeLabel(type) {
  switch (Number(type)) {
    case 1:
      return "诊疗卡";
    case 2:
      return "身份证";
    case 3:
      return "健康卡";
    case 4:
      return "社保卡";
    case 5:
      return "医保卡";
    case 6:
      return "市民卡";
    default:
      return "就诊卡";
  }
}

document.addEventListener("DOMContentLoaded", boot);
