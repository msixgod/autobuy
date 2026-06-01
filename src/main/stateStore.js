const fs = require("node:fs");
const path = require("node:path");

class StateStore {
  constructor(baseDir) {
    this.baseDir = baseDir;
    this.filePath = path.join(baseDir, "app-state.json");
    this.state = this.load();
  }

  load() {
    try {
      if (!fs.existsSync(this.filePath)) {
        return this.defaultState();
      }
      const raw = fs.readFileSync(this.filePath, "utf8");
      return {
        ...this.defaultState(),
        ...JSON.parse(raw)
      };
    } catch (_error) {
      return this.defaultState();
    }
  }

  defaultState() {
    return {
      proxy: {
        host: "127.0.0.1",
        port: 8080
      },
      sessionData: null,
      booking: {
        departmentName: "",
        doctorKey: "",
        patientId: "",
        cardId: "",
        dateMode: "earliest",
        registerDate: "",
        endDate: "",
        noon: "1",
        startTime: "",
        startAt: "",
        pollIntervalSeconds: 3,
        alertOnly: true
      }
    };
  }

  get() {
    return this.state;
  }

  set(nextState) {
    this.state = {
      ...this.state,
      ...nextState
    };
    this.persist();
    return this.state;
  }

  updateSection(section, payload) {
    this.state = {
      ...this.state,
      [section]: {
        ...(this.state[section] || {}),
        ...payload
      }
    };
    this.persist();
    return this.state[section];
  }

  persist() {
    fs.mkdirSync(this.baseDir, { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), "utf8");
  }
}

module.exports = { StateStore };
