const { EventEmitter } = require("node:events");
const {
  APP_ID,
  APP_SECRET,
  ensureCryptoConfigured,
  encryptPayload,
  decryptPayload,
  requestSign
} = require("./trasenCrypto");

class BookingService extends EventEmitter {
  constructor() {
    super();
    this.running = false;
    this.abort = false;
  }

  getStatus() {
    return {
      running: this.running
    };
  }

  emitStatus() {
    this.emit("status", this.getStatus());
  }

  stop() {
    this.abort = true;
    this.running = false;
    this.emitStatus();
    this.emit("log", "Auto-booking stopped.");
    return this.getStatus();
  }

  async start(task) {
    if (this.running) {
      throw new Error("Auto-booking is already running.");
    }

    this.running = true;
    this.abort = false;
    this.emitStatus();
    this.emit("log", "Auto-booking started.");

    try {
      const result = await this.runLoop(task);
      this.running = false;
      this.emitStatus();
      return result;
    } catch (error) {
      this.running = false;
      this.emitStatus();
      throw error;
    }
  }

  async runLoop(task) {
    while (!this.abort) {
      const scheduleRows = await this.querySchedule(task);
      const row = this.pickScheduleRow(scheduleRows, task);

      if (row) {
        this.emit(
          "log",
          "Matched schedule row: " +
            row.registerDate +
            " " +
            noonText(row.noon) +
            " remain=" +
            row.remainCount
        );

        const slots = await this.queryScheduleTime(task, row);
        const slot = this.pickTimeSlot(slots, task);

        if (slot) {
          this.emit(
            "log",
            "Matched time slot: " +
              slot.startTime +
              "-" +
              slot.endTime +
              " remain=" +
              slot.remainCount +
              "/" +
              slot.totalCount
          );

          if (task.alertOnly) {
            this.emit("hit", { row, slot, task, alertOnly: true });
            this.emit("log", "Alert-only mode matched. No order was created.");
            return { row, slot, alertOnly: true };
          }

          const order = await this.createOrder(task, row, slot);
          const paymentUrl =
            "http://cskq.trasen.womei.org/v2/weChat/html/cashier/regPay.html?platformOrderNum=" +
            encodeURIComponent(order.platformOrderNum || "");
          this.emit("hit", { row, slot, order, paymentUrl, alertOnly: false });
          this.emit("log", "Order created successfully: " + paymentUrl);
          return { row, slot, order, paymentUrl, alertOnly: false };
        }
      } else {
        this.emit("log", "No matching schedule yet.");
      }

      await waitMs(Math.max(1, Number(task.pollIntervalSeconds) || 3) * 1000);
    }

    throw new Error("Auto-booking was stopped.");
  }

  buildDateRange(task) {
    if (task.dateMode === "specific" && task.registerDate) {
      return {
        startDate: task.registerDate,
        endDate: task.registerDate
      };
    }

    const today = new Date();
    const end = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);
    return {
      startDate: formatDate(today),
      endDate: task.endDate || formatDate(end)
    };
  }

  async apiCall(task, apiPath, payload) {
    ensureCryptoConfigured();
    const bodyText = JSON.stringify(payload);
    const encryptedBody = encryptPayload(bodyText);
    const sign = requestSign(bodyText, task.orgCode);

    const response = await fetch("https://wis2.trasen.womei.org/api/" + apiPath, {
      method: "POST",
      headers: {
        "Content-Type": "application/json;charset=UTF-8",
        "TEST-UID": task.testUid || "250915",
        appid: APP_ID,
        appSecret: APP_SECRET,
        orgCode: task.orgCode || "",
        sign,
        token: task.token || ""
      },
      body: encryptedBody
    });

    const rawText = await response.text();
    const decrypted = decryptPayload(rawText.trim());
    const data = JSON.parse(decrypted);

    if (data.code !== 0) {
      throw new Error(data.message || apiPath + " failed");
    }

    return data;
  }

  async querySchedule(task) {
    const range = this.buildDateRange(task);
    const payload = {
      doctorCode: task.doctorCode,
      departmentId: task.deptId,
      departmentCode: task.deptCode,
      startDate: range.startDate,
      endDate: range.endDate,
      isUpdateRemainCount: 1
    };
    return (await this.apiCall(task, "bz/appointment/schedule", payload)).data?.rows || [];
  }

  pickScheduleRow(rows, task) {
    const noon = String(task.noon || "1");
    const filtered = rows
      .filter((row) => Number(row.remainCount) > 0)
      .filter((row) => String(row.noon) === noon)
      .sort((a, b) => {
        if (a.registerDate !== b.registerDate) {
          return String(a.registerDate).localeCompare(String(b.registerDate));
        }
        return String(a.startTime || "").localeCompare(String(b.startTime || ""));
      });
    return filtered[0] || null;
  }

  async queryScheduleTime(task, row) {
    const payload = {
      doctorCode: row.doctorId,
      departmentId: task.deptId,
      departmentCode: task.deptCode,
      registerDate: row.registerDate,
      scheduleId: row.id,
      noon: Number(row.noon) === 4 ? 0 : row.noon
    };
    return (await this.apiCall(task, "bz/appointment/scheduleTime", payload)).data?.rows || [];
  }

  pickTimeSlot(slots, task) {
    let filtered = slots.filter((slot) => Number(slot.remainCount) > 0);
    if (task.startTime) {
      filtered = filtered.filter((slot) => slot.startTime === task.startTime);
    }
    filtered.sort((a, b) => String(a.startTime || "").localeCompare(String(b.startTime || "")));
    return filtered[0] || null;
  }

  async createOrder(task, row, slot) {
    const payload = {
      payChannel: "1",
      scheduleId: slot.scheduleId,
      deptCode: task.deptCode,
      docCode: row.doctorId,
      registerDate: row.registerDate,
      noon: slot.noon,
      startTime: slot.startTime,
      endTime: slot.endTime,
      registerFee: row.registerFee,
      visitFlag: "0",
      timeId: slot.id,
      patId: task.patientId,
      patCardId: task.cardId
    };
    return (await this.apiCall(task, "bz/appointment/order", payload)).data || {};
  }
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDate(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return [date.getFullYear(), "-", pad(date.getMonth() + 1), "-", pad(date.getDate())].join("");
}

function noonText(value) {
  switch (String(value)) {
    case "1":
      return "morning";
    case "2":
      return "afternoon";
    case "4":
      return "all-day";
    default:
      return "unknown";
  }
}

module.exports = { BookingService };
