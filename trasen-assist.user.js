// ==UserScript==
// @name         Trasen Appointment Assist
// @namespace    https://example.local/
// @version      0.1.0
// @description  In-page watcher and order helper for the Trasen registration site.
// @match        *://cskq.trasen.womei.org/v2/weChat/html/register/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  function pageMain() {
    const APP_ID = "trasen-assist-panel-v1";
    const CONFIG_KEY = "trasen_assist_config_v1";
    const DEFAULT_CONFIG = {
      departmentName: "",
      doctorKey: "",
      dateMode: "earliest",
      registerDate: "",
      noon: "1",
      startTime: "",
      pollIntervalSeconds: 3,
      alertOnly: true,
      patientId: "",
      cardId: "",
    };

    const state = {
      config: loadConfig(),
      running: false,
      doctors: [],
      patients: [],
      cards: [],
      panel: null,
      els: {},
      loopTimer: null,
    };

    waitForDeps()
      .then(init)
      .catch((error) => {
        console.error("[Trasen Assist] init failed", error);
      });

    function waitForDeps() {
      return new Promise((resolve, reject) => {
        let attempts = 0;
        const timer = window.setInterval(() => {
          attempts += 1;
          if (window.$ && window.Storage && window.basisUrl) {
            window.clearInterval(timer);
            resolve();
            return;
          }
          if (attempts > 120) {
            window.clearInterval(timer);
            reject(new Error("Page globals were not ready in time"));
          }
        }, 500);
      });
    }

    function init() {
      if (document.getElementById(APP_ID)) {
        return;
      }
      injectStyles();
      buildPanel();
      bindEvents();
      refreshStatus();
      refreshDoctors()
        .then(() => refreshPatients())
        .catch((error) => log("初始化失败: " + formatError(error)));
    }

    function loadConfig() {
      try {
        const raw = window.localStorage.getItem(CONFIG_KEY);
        if (!raw) {
          return { ...DEFAULT_CONFIG };
        }
        return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
      } catch (error) {
        return { ...DEFAULT_CONFIG };
      }
    }

    function saveConfig() {
      window.localStorage.setItem(CONFIG_KEY, JSON.stringify(state.config));
    }

    function injectStyles() {
      const css =
        "#" +
        APP_ID +
        "{" +
        "position:fixed;top:16px;right:16px;z-index:2147483647;width:360px;max-height:calc(100vh - 32px);" +
        "overflow:hidden;background:rgba(17,24,39,.96);color:#f9fafb;border:1px solid rgba(148,163,184,.28);" +
        "border-radius:14px;box-shadow:0 18px 42px rgba(15,23,42,.4);font:12px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}" +
        "#" +
        APP_ID +
        " *{box-sizing:border-box;}" +
        "#" +
        APP_ID +
        " .ta-head{display:flex;align-items:center;justify-content:space-between;padding:12px 14px 10px;background:linear-gradient(135deg,#0f766e,#155e75);}" +
        "#" +
        APP_ID +
        " .ta-title{font-size:14px;font-weight:700;}" +
        "#" +
        APP_ID +
        " .ta-mini{font-size:11px;opacity:.85;}" +
        "#" +
        APP_ID +
        " .ta-toggle{border:0;background:rgba(255,255,255,.16);color:#fff;border-radius:999px;padding:4px 10px;cursor:pointer;}" +
        "#" +
        APP_ID +
        " .ta-body{padding:12px 14px 14px;max-height:calc(100vh - 92px);overflow:auto;}" +
        "#" +
        APP_ID +
        ".collapsed .ta-body{display:none;}" +
        "#" +
        APP_ID +
        " .ta-row{margin-bottom:10px;}" +
        "#" +
        APP_ID +
        " .ta-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;}" +
        "#" +
        APP_ID +
        " .ta-label{display:block;margin-bottom:4px;color:#cbd5e1;font-weight:600;}" +
        "#" +
        APP_ID +
        " .ta-input,#" +
        APP_ID +
        " .ta-select{width:100%;min-height:34px;border:1px solid rgba(148,163,184,.35);border-radius:10px;background:rgba(15,23,42,.75);color:#f8fafc;padding:8px 10px;}" +
        "#" +
        APP_ID +
        " .ta-input::placeholder{color:#94a3b8;}" +
        "#" +
        APP_ID +
        " .ta-checkline{display:flex;align-items:center;gap:8px;margin-top:4px;}" +
        "#" +
        APP_ID +
        " .ta-actions{display:flex;gap:8px;flex-wrap:wrap;}" +
        "#" +
        APP_ID +
        " .ta-btn{border:0;border-radius:10px;padding:8px 12px;cursor:pointer;color:#fff;font-weight:700;}" +
        "#" +
        APP_ID +
        " .ta-btn-main{background:#0f766e;}" +
        "#" +
        APP_ID +
        " .ta-btn-danger{background:#b91c1c;}" +
        "#" +
        APP_ID +
        " .ta-btn-ghost{background:#334155;}" +
        "#" +
        APP_ID +
        " .ta-status{padding:9px 10px;border-radius:10px;background:rgba(30,41,59,.9);color:#cbd5e1;white-space:pre-line;}" +
        "#" +
        APP_ID +
        " .ta-log{height:180px;overflow:auto;border-radius:10px;background:#020617;border:1px solid rgba(148,163,184,.2);padding:8px;white-space:pre-wrap;word-break:break-word;}" +
        "#" +
        APP_ID +
        " .ta-log-line{margin-bottom:6px;}";

      const style = document.createElement("style");
      style.textContent = css;
      document.head.appendChild(style);
    }

    function buildPanel() {
      const panel = document.createElement("section");
      panel.id = APP_ID;
      panel.innerHTML =
        '<div class="ta-head">' +
        '<div><div class="ta-title">Trasen Assist</div><div class="ta-mini">网页内监听与下单面板</div></div>' +
        '<button class="ta-toggle" type="button">收起</button>' +
        "</div>" +
        '<div class="ta-body">' +
        '<div class="ta-row ta-status" data-role="status">准备中...</div>' +
        '<div class="ta-row"><label class="ta-label" for="ta-department">科室 / 门诊部</label><select id="ta-department" class="ta-select"></select></div>' +
        '<div class="ta-row"><label class="ta-label" for="ta-doctor">医生</label><select id="ta-doctor" class="ta-select"></select></div>' +
        '<div class="ta-row ta-grid">' +
        '<div><label class="ta-label" for="ta-date-mode">日期模式</label><select id="ta-date-mode" class="ta-select"><option value="earliest">最早可用</option><option value="specific">指定日期</option></select></div>' +
        '<div><label class="ta-label" for="ta-date">指定日期</label><input id="ta-date" class="ta-input" type="date" /></div>' +
        "</div>" +
        '<div class="ta-row ta-grid">' +
        '<div><label class="ta-label" for="ta-noon">时段</label><select id="ta-noon" class="ta-select"><option value="1">上午</option><option value="2">下午</option><option value="4">全天</option></select></div>' +
        '<div><label class="ta-label" for="ta-start-time">开始时间</label><input id="ta-start-time" class="ta-input" type="text" placeholder="留空=该时段最早" /></div>' +
        "</div>" +
        '<div class="ta-row ta-grid">' +
        '<div><label class="ta-label" for="ta-poll">轮询秒数</label><input id="ta-poll" class="ta-input" type="number" min="1" step="1" /></div>' +
        '<div><label class="ta-label" for="ta-alert-only">模式</label><div class="ta-checkline"><input id="ta-alert-only" type="checkbox" /><span>只提醒，不下单</span></div></div>' +
        "</div>" +
        '<div class="ta-row"><label class="ta-label" for="ta-patient">就诊人</label><select id="ta-patient" class="ta-select"></select></div>' +
        '<div class="ta-row"><label class="ta-label" for="ta-card">就诊卡</label><select id="ta-card" class="ta-select"></select></div>' +
        '<div class="ta-row ta-actions"><button class="ta-btn ta-btn-ghost" type="button" data-role="refresh">刷新资料</button><button class="ta-btn ta-btn-main" type="button" data-role="start">开始监听</button><button class="ta-btn ta-btn-danger" type="button" data-role="stop">停止</button></div>' +
        '<div class="ta-row"><div class="ta-label">日志</div><div class="ta-log" data-role="log"></div></div>' +
        "</div>";

      document.body.appendChild(panel);
      state.panel = panel;
      state.els = {
        toggle: panel.querySelector(".ta-toggle"),
        status: panel.querySelector('[data-role="status"]'),
        log: panel.querySelector('[data-role="log"]'),
        refresh: panel.querySelector('[data-role="refresh"]'),
        start: panel.querySelector('[data-role="start"]'),
        stop: panel.querySelector('[data-role="stop"]'),
        department: panel.querySelector("#ta-department"),
        doctor: panel.querySelector("#ta-doctor"),
        dateMode: panel.querySelector("#ta-date-mode"),
        date: panel.querySelector("#ta-date"),
        noon: panel.querySelector("#ta-noon"),
        startTime: panel.querySelector("#ta-start-time"),
        poll: panel.querySelector("#ta-poll"),
        alertOnly: panel.querySelector("#ta-alert-only"),
        patient: panel.querySelector("#ta-patient"),
        card: panel.querySelector("#ta-card"),
      };
      syncControlsFromConfig();
    }

    function bindEvents() {
      state.els.toggle.addEventListener("click", () => {
        state.panel.classList.toggle("collapsed");
        state.els.toggle.textContent = state.panel.classList.contains("collapsed") ? "展开" : "收起";
      });

      state.els.refresh.addEventListener("click", async () => {
        try {
          await refreshDoctors();
          await refreshPatients();
        } catch (error) {
          log("刷新失败: " + formatError(error));
        }
      });

      state.els.start.addEventListener("click", startWatching);
      state.els.stop.addEventListener("click", stopWatching);

      state.els.department.addEventListener("change", () => {
        state.config.departmentName = state.els.department.value;
        state.config.doctorKey = "";
        saveConfig();
        renderDoctorOptions();
        refreshStatus();
      });

      state.els.doctor.addEventListener("change", async () => {
        state.config.doctorKey = state.els.doctor.value;
        saveConfig();
        applyDoctorContext(getSelectedDoctor());
        await refreshPatients();
        refreshStatus();
      });

      state.els.dateMode.addEventListener("change", () => {
        state.config.dateMode = state.els.dateMode.value;
        saveConfig();
      });

      state.els.date.addEventListener("change", () => {
        state.config.registerDate = state.els.date.value;
        saveConfig();
      });

      state.els.noon.addEventListener("change", () => {
        state.config.noon = state.els.noon.value;
        saveConfig();
      });

      state.els.startTime.addEventListener("input", () => {
        state.config.startTime = state.els.startTime.value.trim();
        saveConfig();
      });

      state.els.poll.addEventListener("input", () => {
        state.config.pollIntervalSeconds = Math.max(1, parseInt(state.els.poll.value || "3", 10));
        saveConfig();
      });

      state.els.alertOnly.addEventListener("change", () => {
        state.config.alertOnly = !!state.els.alertOnly.checked;
        saveConfig();
      });

      state.els.patient.addEventListener("change", () => {
        state.config.patientId = state.els.patient.value;
        saveConfig();
        renderCardOptions();
        refreshStatus();
      });

      state.els.card.addEventListener("change", () => {
        state.config.cardId = state.els.card.value;
        saveConfig();
        refreshStatus();
      });
    }

    function syncControlsFromConfig() {
      state.els.dateMode.value = state.config.dateMode;
      state.els.date.value = state.config.registerDate;
      state.els.noon.value = state.config.noon;
      state.els.startTime.value = state.config.startTime;
      state.els.poll.value = String(state.config.pollIntervalSeconds);
      state.els.alertOnly.checked = !!state.config.alertOnly;
    }

    function refreshStatus() {
      const token = safeStorageGet("token", { type: 0 });
      const campus = safeStorageGet("SelectedCampus", { type: 1 });
      const doctor = getSelectedDoctor();
      const patient = getSelectedPatient();
      const card = getSelectedCard();
      const lines = [
        "登录态: " + (token ? "已登录" : "未登录"),
        "当前院区: " + (campus ? campus.hospName || campus.hospitalName || campus.regionName || campus.hospitalCode || "已选择" : "未识别"),
        "目标科室: " + (state.config.departmentName || "未选择"),
        "目标医生: " + (doctor ? doctor.doctorName : "未选择"),
        "目标时段: " + noonText(state.config.noon),
        "就诊人: " + (patient ? patient.name : "未选择"),
        "就诊卡: " + (card ? maskCard(card.cardNoMasked || card.cardNo || "") : "未选择"),
        "模式: " + (state.config.alertOnly ? "只提醒" : "自动下单"),
        "状态: " + (state.running ? "监听中" : "空闲"),
      ];
      state.els.status.textContent = lines.join("\n");
    }

    function log(message) {
      const line = document.createElement("div");
      line.className = "ta-log-line";
      line.textContent = "[" + nowText() + "] " + message;
      state.els.log.appendChild(line);
      state.els.log.scrollTop = state.els.log.scrollHeight;
      console.log("[Trasen Assist]", message);
    }

    function nowText() {
      const date = new Date();
      const pad = (value) => String(value).padStart(2, "0");
      return [
        date.getFullYear(),
        "-",
        pad(date.getMonth() + 1),
        "-",
        pad(date.getDate()),
        " ",
        pad(date.getHours()),
        ":",
        pad(date.getMinutes()),
        ":",
        pad(date.getSeconds()),
      ].join("");
    }

    function safeStorageGet(key, options) {
      try {
        return window.Storage.get(key, options);
      } catch (error) {
        return null;
      }
    }

    function safeStorageSet(key, value, options) {
      try {
        window.Storage.set(key, value, options);
      } catch (error) {
        console.warn("[Trasen Assist] storage set failed", key, error);
      }
    }

    function api(path, payload) {
      return new Promise((resolve, reject) => {
        window.$.ajax({
          url: window.basisUrl + path,
          data: JSON.stringify(payload || {}),
          success(response) {
            resolve(response);
          },
          error(xhr, textStatus) {
            reject(new Error(textStatus || "request failed"));
          },
        });
      });
    }

    async function refreshDoctors() {
      const response = await api("basic/doctor/queryKqyyDoctor", {});
      if (response.code !== 0) {
        throw new Error(response.message || "queryKqyyDoctor failed");
      }
      state.doctors = (response.data || []).filter((item) => item && item.doctorName && item.deptName);
      renderDepartmentOptions();
      renderDoctorOptions();
      log("医生数据已刷新: " + state.doctors.length + " 条");
    }

    function renderDepartmentOptions() {
      const departments = [];
      const seen = new Set();
      state.doctors.forEach((doctor) => {
        if (!seen.has(doctor.deptName)) {
          seen.add(doctor.deptName);
          departments.push(doctor.deptName);
        }
      });
      departments.sort((a, b) => a.localeCompare(b, "zh-CN"));
      state.els.department.innerHTML = "";
      state.els.department.appendChild(new Option("请选择科室 / 门诊部", "", !state.config.departmentName, !state.config.departmentName));
      departments.forEach((name) => {
        state.els.department.appendChild(new Option(name, name, state.config.departmentName === name, state.config.departmentName === name));
      });
      if (!departments.includes(state.config.departmentName)) {
        state.config.departmentName = "";
        saveConfig();
      }
    }

    function doctorKeyOf(doctor) {
      return [doctor.doctorCode, doctor.deptCode, doctor.hospRegionCode, doctor.doctorId].join("|");
    }

    function renderDoctorOptions() {
      const doctors = state.doctors
        .filter((doctor) => !state.config.departmentName || doctor.deptName === state.config.departmentName)
        .sort((a, b) => (a.doctorName || "").localeCompare(b.doctorName || "", "zh-CN"));
      state.els.doctor.innerHTML = "";
      state.els.doctor.appendChild(new Option("请选择医生", "", !state.config.doctorKey, !state.config.doctorKey));
      let hasSelected = false;
      doctors.forEach((doctor) => {
        const key = doctorKeyOf(doctor);
        const label = doctor.doctorName + " | " + (doctor.levelName || "医生") + " | " + doctor.deptName;
        state.els.doctor.appendChild(new Option(label, key, state.config.doctorKey === key, state.config.doctorKey === key));
        if (state.config.doctorKey === key) {
          hasSelected = true;
        }
      });
      if (!hasSelected) {
        state.config.doctorKey = "";
        saveConfig();
      }
    }

    function getSelectedDoctor() {
      if (!state.config.doctorKey) {
        return null;
      }
      return state.doctors.find((doctor) => doctorKeyOf(doctor) === state.config.doctorKey) || null;
    }

    function applyDoctorContext(doctor) {
      if (!doctor) {
        return;
      }
      safeStorageSet("orgCode", doctor.hospRegionCode, { type: 1 });
      const hospitalData = safeStorageGet("HOSPITALDATA", { type: 1 });
      if (hospitalData && hospitalData.regionList) {
        const matched = hospitalData.regionList.find((item) => item.hospitalCode === doctor.hospRegionCode);
        if (matched) {
          safeStorageSet("SelectedCampus", matched, { type: 1 });
        }
      }
    }

    async function refreshPatients() {
      const doctor = getSelectedDoctor();
      if (doctor) {
        applyDoctorContext(doctor);
      }
      const campus = safeStorageGet("SelectedCampus", { type: 1 });
      if (!campus || !campus.orgId || !campus.regionId) {
        renderPatientOptions([]);
        refreshStatus();
        return;
      }
      const response = await api("bz/patient/queryPatientByUser", {
        orgId: campus.orgId,
        regionId: campus.regionId,
        isAll: 1,
      });
      if (response.code !== 0) {
        renderPatientOptions([]);
        throw new Error(response.message || "queryPatientByUser failed");
      }
      state.patients = response.data || [];
      renderPatientOptions(state.patients);
      log("就诊人数据已刷新: " + state.patients.length + " 条");
      refreshStatus();
    }

    function renderPatientOptions(patients) {
      state.els.patient.innerHTML = "";
      state.els.patient.appendChild(new Option("请选择就诊人", "", !state.config.patientId, !state.config.patientId));
      let hasSelected = false;
      patients.forEach((patient) => {
        const label = patient.name + " | " + (patient.certificateNoMasked || patient.certificateNo || "");
        state.els.patient.appendChild(new Option(label, String(patient.id), String(state.config.patientId) === String(patient.id), String(state.config.patientId) === String(patient.id)));
        if (String(state.config.patientId) === String(patient.id)) {
          hasSelected = true;
        }
      });
      if (!hasSelected) {
        state.config.patientId = patients[0] ? String(patients[0].id) : "";
        saveConfig();
      }
      state.els.patient.value = state.config.patientId;
      renderCardOptions();
    }

    function getSelectedPatient() {
      return state.patients.find((patient) => String(patient.id) === String(state.config.patientId)) || null;
    }

    function renderCardOptions() {
      const patient = getSelectedPatient();
      state.cards = patient && patient.wisdomPatientCardList ? patient.wisdomPatientCardList : [];
      state.els.card.innerHTML = "";
      state.els.card.appendChild(new Option("请选择就诊卡", "", !state.config.cardId, !state.config.cardId));
      let hasSelected = false;
      state.cards.forEach((card) => {
        const label = cardTypeLabel(card.cardType) + " | " + (card.cardNoMasked || card.cardNo || "");
        state.els.card.appendChild(new Option(label, String(card.id), String(state.config.cardId) === String(card.id), String(state.config.cardId) === String(card.id)));
        if (String(state.config.cardId) === String(card.id)) {
          hasSelected = true;
        }
      });
      if (!hasSelected) {
        state.config.cardId = state.cards[0] ? String(state.cards[0].id) : "";
        saveConfig();
      }
      state.els.card.value = state.config.cardId;
      refreshStatus();
    }

    function getSelectedCard() {
      return state.cards.find((card) => String(card.id) === String(state.config.cardId)) || null;
    }

    async function startWatching() {
      if (state.running) {
        return;
      }
      const doctor = getSelectedDoctor();
      if (!doctor) {
        log("请先选择医生");
        return;
      }
      const patient = getSelectedPatient();
      const card = getSelectedCard();
      if (!state.config.alertOnly && (!patient || !card)) {
        log("自动下单模式下，请先选择就诊人和就诊卡");
        return;
      }
      state.running = true;
      refreshStatus();
      log("开始监听");
      runLoop().catch((error) => {
        state.running = false;
        refreshStatus();
        log("监听中断: " + formatError(error));
      });
    }

    function stopWatching() {
      state.running = false;
      if (state.loopTimer) {
        window.clearTimeout(state.loopTimer);
        state.loopTimer = null;
      }
      refreshStatus();
      log("已停止监听");
    }

    async function runLoop() {
      while (state.running) {
        try {
          const doctor = getSelectedDoctor();
          if (!doctor) {
            throw new Error("未选择医生");
          }
          applyDoctorContext(doctor);
          const scheduleRows = await queryScheduleRows(doctor);
          const chosenRow = pickScheduleRow(scheduleRows);
          if (chosenRow) {
            log("命中排班: " + chosenRow.registerDate + " " + noonText(chosenRow.noon) + " 余" + chosenRow.remainCount);
            const slots = await queryScheduleTimes(doctor, chosenRow);
            const chosenSlot = pickTimeSlot(slots);
            if (chosenSlot) {
              log("命中时间槽: " + chosenSlot.startTime + "-" + chosenSlot.endTime + " 余" + chosenSlot.remainCount + "/" + chosenSlot.totalCount);
              notifyHit(doctor, chosenRow, chosenSlot);
              if (state.config.alertOnly) {
                log("当前为只提醒模式，已停止");
                state.running = false;
                refreshStatus();
                return;
              }
              const orderData = await createOrder(doctor, chosenRow, chosenSlot);
              log("下单成功，准备跳转支付");
              window.location.href = "../cashier/regPay.html?platformOrderNum=" + encodeURIComponent(orderData.platformOrderNum) + "&" + Math.random();
              return;
            }
            log("排班存在，但没有符合要求的时间槽");
          } else {
            log("当前未命中目标号源");
          }
        } catch (error) {
          log("轮询失败: " + formatError(error));
        }
        await waitSeconds(Math.max(1, Number(state.config.pollIntervalSeconds) || 3));
      }
    }

    function buildDateRange() {
      if (state.config.dateMode === "specific" && state.config.registerDate) {
        return {
          startDate: state.config.registerDate,
          endDate: state.config.registerDate,
        };
      }
      const today = new Date();
      const end = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);
      return {
        startDate: formatDate(today),
        endDate: formatDate(end),
      };
    }

    async function queryScheduleRows(doctor) {
      const range = buildDateRange();
      const response = await api("bz/appointment/schedule", {
        doctorCode: doctor.doctorCode,
        departmentId: doctor.deptId,
        departmentCode: doctor.deptCode,
        startDate: range.startDate,
        endDate: range.endDate,
        isUpdateRemainCount: 1,
      });
      if (response.code !== 0) {
        throw new Error(response.message || "schedule query failed");
      }
      return (response.data && response.data.rows) || [];
    }

    function pickScheduleRow(rows) {
      const filtered = rows
        .filter((row) => Number(row.remainCount) > 0)
        .filter((row) => String(row.noon) === String(state.config.noon))
        .sort((a, b) => {
          if (a.registerDate !== b.registerDate) {
            return a.registerDate.localeCompare(b.registerDate);
          }
          return String(a.startTime || "").localeCompare(String(b.startTime || ""));
        });
      return filtered[0] || null;
    }

    async function queryScheduleTimes(doctor, row) {
      const response = await api("bz/appointment/scheduleTime", {
        doctorCode: row.doctorId,
        departmentId: doctor.deptId,
        departmentCode: doctor.deptCode,
        registerDate: row.registerDate,
        scheduleId: row.id,
        noon: Number(row.noon) === 4 ? 0 : row.noon,
      });
      if (response.code !== 0) {
        throw new Error(response.message || "scheduleTime query failed");
      }
      return (response.data && response.data.rows) || [];
    }

    function pickTimeSlot(slots) {
      let filtered = slots.filter((slot) => Number(slot.remainCount) > 0);
      if (state.config.startTime) {
        filtered = filtered.filter((slot) => slot.startTime === state.config.startTime);
      }
      filtered.sort((a, b) => String(a.startTime || "").localeCompare(String(b.startTime || "")));
      return filtered[0] || null;
    }

    async function createOrder(doctor, row, slot) {
      const patient = getSelectedPatient();
      const card = getSelectedCard();
      if (!patient || !card) {
        throw new Error("自动下单需要就诊人和就诊卡");
      }
      const response = await api("bz/appointment/order", {
        payChannel: "1",
        scheduleId: slot.scheduleId,
        deptCode: doctor.deptCode,
        docCode: row.doctorId,
        registerDate: row.registerDate,
        noon: slot.noon,
        startTime: slot.startTime,
        endTime: slot.endTime,
        registerFee: row.registerFee,
        visitFlag: "0",
        timeId: slot.id,
        patId: patient.id,
        patCardId: card.id,
      });
      if (response.code !== 0) {
        throw new Error(response.message || "appointment order failed");
      }
      return response.data || {};
    }

    function notifyHit(doctor, row, slot) {
      const message = doctor.doctorName + " " + row.registerDate + " " + slot.startTime + "-" + slot.endTime + " 命中";
      if (window.Notification && window.Notification.permission === "granted") {
        new window.Notification("Trasen Assist", { body: message });
      }
      if (window.Notification && window.Notification.permission === "default") {
        window.Notification.requestPermission().catch(() => {});
      }
    }

    function waitSeconds(seconds) {
      return new Promise((resolve) => {
        state.loopTimer = window.setTimeout(resolve, seconds * 1000);
      });
    }

    function formatDate(date) {
      const pad = (value) => String(value).padStart(2, "0");
      return [date.getFullYear(), "-", pad(date.getMonth() + 1), "-", pad(date.getDate())].join("");
    }

    function noonText(value) {
      switch (String(value)) {
        case "1":
          return "上午";
        case "2":
          return "下午";
        case "4":
          return "全天";
        default:
          return "未知";
      }
    }

    function cardTypeLabel(value) {
      switch (Number(value)) {
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

    function maskCard(value) {
      return value ? String(value) : "";
    }

    function formatError(error) {
      if (!error) {
        return "未知错误";
      }
      return error.message || String(error);
    }
  }

  const script = document.createElement("script");
  script.textContent = "(" + pageMain.toString() + ")();";
  document.documentElement.appendChild(script);
  script.remove();
})();
