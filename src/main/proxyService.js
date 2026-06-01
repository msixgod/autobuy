const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { shell } = require("electron");
const { Proxy } = require("http-mitm-proxy");

const TARGET_HOST = "wis2.trasen.womei.org";
const RESOURCE_HOSTS = new Set([
  "cskq.trasen.womei.org",
  "file-oss.womei.org",
  "wis2.trasen.womei.org"
]);

class ProxyService extends EventEmitter {
  constructor(baseDir) {
    super();
    this.baseDir = baseDir;
    this.captureFile = path.join(baseDir, "captures", "trasen-capture.jsonl");
    this.sslCaDir = path.join(baseDir, "proxy-ca");
    this.proxy = null;
    this.running = false;
    this.host = "127.0.0.1";
    this.port = 8080;
    this.plainPort = 8081;
    this.entries = [];
    this.plainServer = null;
    this.pageCommands = [];
    this.pageCommandWaiters = new Map();
    this.totalRequests = 0;
    this.totalTunnels = 0;
    this.recentHosts = [];
    this.systemProxy = {
      supported: process.platform === "win32" || process.platform === "darwin",
      enabled: false,
      server: "",
      source: "unknown"
    };

    fs.mkdirSync(path.dirname(this.captureFile), { recursive: true });
    fs.mkdirSync(this.sslCaDir, { recursive: true });
    this.entries = this.loadExistingEntries();
  }

  loadExistingEntries() {
    if (!fs.existsSync(this.captureFile)) {
      return [];
    }
    try {
      const raw = fs.readFileSync(this.captureFile, "utf8");
      return raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch (error) {
      this.emit("log", "Failed to load existing captures: " + (error.message || error));
      return [];
    }
  }

  getStatus() {
    return {
      running: this.running,
      host: this.host,
      port: this.port,
      captureFile: this.captureFile,
      certPath: this.getCertPath(),
      plainCaptureUrl: "http://127.0.0.1:" + this.plainPort + "/__autobuy_plain",
      entriesCount: this.entries.length,
      totalRequests: this.totalRequests,
      totalTunnels: this.totalTunnels,
      recentHosts: this.recentHosts.slice(),
      systemProxy: { ...this.systemProxy }
    };
  }

  getEntries() {
    return this.entries.slice();
  }

  clearEntries() {
    this.entries = [];
    this.totalRequests = 0;
    this.totalTunnels = 0;
    this.recentHosts = [];
    try {
      fs.rmSync(this.captureFile, { force: true });
    } catch (_error) {
      // ignore
    }
    this.emit("log", "Capture history cleared.");
  }

  getCertPath() {
    return path.join(this.sslCaDir, "certs", "ca.pem");
  }

  async revealCertificate() {
    return shell.showItemInFolder(this.getCertPath());
  }

  async openProxySettings() {
    const platform = process.platform;
    if (platform === "win32") {
      await shell.openExternal("ms-settings:network-proxy");
      return true;
    }
    if (platform === "darwin") {
      await shell.openExternal("x-apple.systempreferences:com.apple.NetworkSettings");
      return true;
    }
    return false;
  }

  async trustCertificate() {
    const certPath = this.getCertPath();
    if (!fs.existsSync(certPath)) {
      throw new Error("Certificate file does not exist yet. Start the proxy once first.");
    }

    if (process.platform === "win32") {
      await runCommand("certutil", ["-user", "-addstore", "Root", certPath]);
      this.emit("log", "Windows certificate trust command completed.");
      return true;
    }

    if (process.platform === "darwin") {
      const keychain = path.join(os.homedir(), "Library/Keychains/login.keychain-db");
      await runCommand("security", ["add-trusted-cert", "-d", "-r", "trustRoot", "-k", keychain, certPath]);
      this.emit("log", "macOS certificate trust command completed.");
      return true;
    }

    throw new Error("Automatic certificate trust is only implemented for Windows and macOS.");
  }

  async refreshSystemProxyStatus() {
    try {
      if (process.platform === "win32") {
        const stdout = await runPowerShell(
          [
            "$regPath = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'",
            "$value = Get-ItemProperty -Path $regPath",
            "[PSCustomObject]@{enabled=[bool]$value.ProxyEnable; server=[string]$value.ProxyServer} | ConvertTo-Json -Compress"
          ].join("; ")
        );
        const parsed = JSON.parse(stdout || "{}");
        this.systemProxy = {
          supported: true,
          enabled: !!parsed.enabled,
          server: String(parsed.server || ""),
          source: "wininet"
        };
        return this.systemProxy;
      }

      if (process.platform === "darwin") {
        this.systemProxy = {
          supported: true,
          enabled: this.systemProxy.enabled,
          server: this.systemProxy.server,
          source: "networksetup"
        };
        return this.systemProxy;
      }
    } catch (error) {
      this.emit("log", "Failed to read system proxy status: " + (error.message || error));
    }
    return this.systemProxy;
  }

  async enableSystemProxy() {
    const server = this.host + ":" + this.port;

    if (process.platform === "win32") {
      await runPowerShell(buildWindowsProxyScript(true, server));
      this.systemProxy = {
        supported: true,
        enabled: true,
        server,
        source: "wininet"
      };
      this.emit("log", "System proxy enabled automatically: " + server);
      return this.systemProxy;
    }

    if (process.platform === "darwin") {
      const services = await listMacNetworkServices();
      for (const service of services) {
        await runCommand("networksetup", ["-setwebproxy", service, this.host, String(this.port)]);
        await runCommand("networksetup", ["-setsecurewebproxy", service, this.host, String(this.port)]);
        await runCommand("networksetup", ["-setwebproxystate", service, "on"]);
        await runCommand("networksetup", ["-setsecurewebproxystate", service, "on"]);
      }
      this.systemProxy = {
        supported: true,
        enabled: true,
        server,
        source: "networksetup"
      };
      this.emit("log", "System proxy enabled automatically: " + server);
      return this.systemProxy;
    }

    throw new Error("Automatic system proxy setup is only implemented for Windows and macOS.");
  }

  async disableSystemProxy() {
    if (process.platform === "win32") {
      await runPowerShell(buildWindowsProxyScript(false, ""));
      this.systemProxy = {
        supported: true,
        enabled: false,
        server: "",
        source: "wininet"
      };
      this.emit("log", "System proxy disabled.");
      return this.systemProxy;
    }

    if (process.platform === "darwin") {
      const services = await listMacNetworkServices();
      for (const service of services) {
        await runCommand("networksetup", ["-setwebproxystate", service, "off"]);
        await runCommand("networksetup", ["-setsecurewebproxystate", service, "off"]);
      }
      this.systemProxy = {
        supported: true,
        enabled: false,
        server: "",
        source: "networksetup"
      };
      this.emit("log", "System proxy disabled.");
      return this.systemProxy;
    }

    throw new Error("Automatic system proxy setup is only implemented for Windows and macOS.");
  }

  async start({ host = "127.0.0.1", port = 8080 } = {}) {
    if (this.running) {
      return this.getStatus();
    }

    this.host = host;
    this.port = Number(port);
    this.plainPort = this.port + 1;
    this.proxy = new Proxy();
    await this.startPlainCaptureServer();

    this.proxy.onError((ctx, error, kind) => {
      if (kind === "HTTPS_CLIENT_ERROR" && String(error?.message || error).includes("Invalid method encountered")) {
        return;
      }
      const url = ctx?.clientToProxyRequest?.url || "";
      this.emit("log", "Proxy error [" + kind + "] " + url + " " + (error?.message || error));
    });

    this.proxy.onConnect((req, _socket, _head, callback) => {
      this.totalTunnels += 1;
      this.rememberHost((req?.url || "").split(":")[0]);
      if (this.totalTunnels <= 5 || String(req?.url || "").includes(TARGET_HOST)) {
        this.emit("log", "Proxy tunnel observed: " + (req?.url || ""));
      }
      callback();
    });

    this.proxy.onRequest((ctx, callback) => {
      const headers = { ...(ctx.clientToProxyRequest.headers || {}) };
      const target = normalizeRequestTarget(ctx.clientToProxyRequest.url || "", headers.host || "");
      this.totalRequests += 1;
      this.rememberHost(target.host);

      ctx.__capture = {
        startedAt: new Date().toISOString(),
        method: ctx.clientToProxyRequest.method,
        host: target.host,
        url: target.url,
        path: target.path,
        requestHeaders: headers,
        requestChunks: [],
        responseHeaders: {},
        responseChunks: []
      };

      if (target.host === TARGET_HOST || RESOURCE_HOSTS.has(target.host)) {
        ctx.use(Proxy.gunzip);
      }
      ctx.__autobuyInject = shouldInjectHook(target);
      if (target.host === TARGET_HOST) {
        this.emit("log", "Target request observed: " + target.path);
      }
      return callback();
    });

    this.proxy.onRequestData((ctx, chunk, callback) => {
      ctx.__capture?.requestChunks?.push(Buffer.from(chunk));
      return callback(null, chunk);
    });

    this.proxy.onResponse((ctx, callback) => {
      if (ctx.__capture) {
        ctx.__capture.responseHeaders = {
          ...(ctx.serverToProxyResponse?.headers || {})
        };
        ctx.__capture.statusCode = ctx.serverToProxyResponse?.statusCode || 0;
      }
      return callback();
    });

    this.proxy.onResponseData((ctx, chunk, callback) => {
      ctx.__capture?.responseChunks?.push(Buffer.from(chunk));
      if (ctx.__autobuyInject) {
        return callback(null, undefined);
      }
      return callback(null, chunk);
    });

    this.proxy.onResponseEnd((ctx, callback) => {
      try {
        const capture = ctx.__capture;
        if (!capture) {
          return callback();
        }
        if (!shouldPersistCapture(capture)) {
          return callback();
        }

        let responseBody = Buffer.concat(capture.responseChunks || []);
        if (ctx.__autobuyInject) {
          responseBody = injectPlainCaptureHook(responseBody, capture, this.plainPort);
          ctx.proxyToClientResponse.write(responseBody);
        }

        const entry = {
          capturedAt: capture.startedAt,
          method: capture.method,
          host: capture.host,
          path: capture.path,
          url: capture.url,
          requestHeaders: capture.requestHeaders,
          requestBody: Buffer.concat(capture.requestChunks || []).toString("utf8"),
          responseStatusCode: capture.statusCode,
          responseHeaders: capture.responseHeaders,
          responseBody: responseBody.toString("utf8")
        };
        this.entries.push(entry);
        fs.appendFileSync(this.captureFile, JSON.stringify(entry) + "\n", "utf8");
        this.emit("entry", entry);
        this.emit("log", "Captured Trasen API response: " + entry.path);
      } catch (error) {
        this.emit("log", "Failed to save capture entry: " + (error.message || error));
      }
      return callback();
    });

    await new Promise((resolve, reject) => {
      this.proxy.listen(
        {
          host: this.host,
          port: this.port,
          sslCaDir: this.sslCaDir,
          forceSNI: true
        },
        (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        }
      );
    });

    this.running = true;
    this.emit("log", "Proxy started on " + this.host + ":" + this.port);

    try {
      await this.enableSystemProxy();
    } catch (error) {
      this.emit("log", "Automatic system proxy setup failed: " + (error.message || error));
    }

    await this.refreshSystemProxyStatus();
    return this.getStatus();
  }

  async stop() {
    if (!this.running && !this.proxy) {
      await this.refreshSystemProxyStatus();
      return this.getStatus();
    }

    if (this.proxy) {
      try {
        if (this.proxy.httpServer && typeof this.proxy.close === "function") {
          this.proxy.close();
        }
      } catch (error) {
        this.emit("log", "Proxy close warning: " + (error.message || error));
      }
    }

    this.proxy = null;
    this.running = false;
    await this.stopPlainCaptureServer();

    try {
      await this.disableSystemProxy();
    } catch (error) {
      this.emit("log", "Automatic system proxy disable failed: " + (error.message || error));
    }

    await this.refreshSystemProxyStatus();
    this.emit("log", "Proxy stopped.");
    return this.getStatus();
  }

  async startPlainCaptureServer() {
    if (this.plainServer) {
      return;
    }

    this.plainServer = http.createServer((req, res) => {
      if (req.method === "OPTIONS") {
        writePlainCaptureResponse(res);
        return;
      }
      if (req.method === "GET" && req.url === "/__autobuy_command") {
        writeJsonResponse(res, this.pageCommands.shift() || { type: "idle" });
        return;
      }
      if (req.method === "POST" && req.url === "/__autobuy_result") {
        this.readJsonRequest(req, (payload) => {
          this.savePageCommandResult(payload);
          writePlainCaptureResponse(res);
        });
        return;
      }
      if (req.method !== "POST" || req.url !== "/__autobuy_plain") {
        res.writeHead(404);
        res.end();
        return;
      }

      this.readJsonRequest(req, (payload) => {
        try {
          this.savePlainCapture(payload);
        } catch (error) {
          this.emit("log", "Plain capture parse failed: " + (error.message || error));
        }
        writePlainCaptureResponse(res);
      });
    });

    for (let offset = 1; offset <= 10; offset += 1) {
      this.plainPort = this.port + offset;
      try {
        await listenHttpServer(this.plainServer, this.plainPort);
        this.emit("log", "Plain page capture listening on 127.0.0.1:" + this.plainPort);
        return;
      } catch (error) {
        if (offset === 10) {
          this.plainServer = null;
          throw error;
        }
      }
    }
  }

  readJsonRequest(req, callback) {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      callback(raw ? JSON.parse(raw) : {});
    });
  }

  async stopPlainCaptureServer() {
    if (!this.plainServer) {
      return;
    }
    const server = this.plainServer;
    this.plainServer = null;
    await new Promise((resolve) => server.close(() => resolve()));
  }

  savePlainCapture(payload) {
    const entry = plainPayloadToEntry(payload);
    if (!entry) {
      return;
    }
    this.entries.push(entry);
    fs.appendFileSync(this.captureFile, JSON.stringify(entry) + "\n", "utf8");
    this.emit("entry", entry);
    this.emit("log", "Captured decoded page API data: " + entry.path);
  }

  executeInPage(apiPath, payload, timeoutMs = 10000) {
    if (!this.plainServer) {
      return Promise.reject(new Error("页面执行桥未启动，请先启动采集环境。"));
    }

    const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
    this.pageCommands.push({
      type: "apiCall",
      id,
      apiPath,
      payload
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pageCommandWaiters.delete(id);
        reject(new Error("微信页面没有响应执行命令，请保持挂号页面打开并已经过采集环境。"));
      }, timeoutMs);
      this.pageCommandWaiters.set(id, { resolve, reject, timer });
    });
  }

  savePageCommandResult(payload) {
    const waiter = this.pageCommandWaiters.get(payload?.id);
    if (!waiter) {
      return;
    }
    clearTimeout(waiter.timer);
    this.pageCommandWaiters.delete(payload.id);
    if (payload.error) {
      waiter.reject(new Error(payload.error));
      return;
    }
    waiter.resolve(payload.responseJson);
  }

  rememberHost(host) {
    const normalized = String(host || "").trim();
    if (!normalized) {
      return;
    }
    const next = [normalized].concat(this.recentHosts.filter((item) => item !== normalized));
    this.recentHosts = next.slice(0, 8);
  }
}

function normalizeRequestTarget(rawUrl, hostHeader) {
  const fallbackHost = String(hostHeader || "").replace(/:\d+$/, "");

  if (/^https?:\/\//i.test(rawUrl)) {
    try {
      const parsed = new URL(rawUrl);
      return {
        host: parsed.hostname,
        path: parsed.pathname,
        url: rawUrl
      };
    } catch (_error) {
      // fall through
    }
  }

  const pathOnly = rawUrl.startsWith("/") ? rawUrl : "/" + rawUrl;
  return {
    host: fallbackHost,
    path: pathOnly,
    url: "https://" + fallbackHost + pathOnly
  };
}

function shouldPersistCapture(capture) {
  if (capture.method === "OPTIONS") {
    return false;
  }
  const pathName = String(capture.path || "");
  if (capture.host === TARGET_HOST && pathName.startsWith("/api/")) {
    return true;
  }

  return RESOURCE_HOSTS.has(capture.host);
}

function shouldInjectHook(target) {
  if (!RESOURCE_HOSTS.has(target.host)) {
    return false;
  }
  const pathName = String(target.path || "").toLowerCase();
  return pathName.endsWith(".html") || pathName.includes(".html?") || pathName.endsWith(".js") || pathName.includes(".js?");
}

function injectPlainCaptureHook(bodyBuffer, capture, plainPort) {
  const contentType = String(capture.responseHeaders?.["content-type"] || "").toLowerCase();
  const pathName = String(capture.path || "").toLowerCase();
  const hook = buildPlainCaptureHook(plainPort);
  const body = bodyBuffer.toString("utf8");

  if (contentType.includes("html") || pathName.endsWith(".html") || pathName.includes(".html?")) {
    if (body.includes("__AUTOBUY_PAGE_CAPTURE__")) {
      return Buffer.from(body, "utf8");
    }
    if (body.includes("</body>")) {
      return Buffer.from(body.replace("</body>", "<script>" + hook + "</script></body>"), "utf8");
    }
    return Buffer.from(body + "<script>" + hook + "</script>", "utf8");
  }

  if (contentType.includes("javascript") || pathName.endsWith(".js") || pathName.includes(".js?")) {
    if (body.includes("__AUTOBUY_PAGE_CAPTURE__")) {
      return Buffer.from(body, "utf8");
    }
    return Buffer.from(body + "\n;" + hook + "\n", "utf8");
  }

  return bodyBuffer;
}

function buildPlainCaptureHook(plainPort) {
  return `
(function(){
  if (window.__AUTOBUY_PAGE_CAPTURE__) return;
  window.__AUTOBUY_PAGE_CAPTURE__ = true;
  var endpoint = "http://127.0.0.1:${Number(plainPort)}/__autobuy_plain";
  function parseMaybeJson(value) {
    if (value == null) return value;
    if (typeof value === "object") return value;
    try { return JSON.parse(value); } catch (_) { return value; }
  }
  function send(payload) {
    try {
      payload.pageUrl = location.href;
      var body = JSON.stringify(payload);
      if (navigator.sendBeacon) {
        var blob = new Blob([body], { type: "text/plain" });
        if (navigator.sendBeacon(endpoint, blob)) return;
      }
      fetch(endpoint, { method: "POST", mode: "no-cors", body: body, keepalive: true }).catch(function(){});
    } catch (_) {}
  }
  function absoluteUrl(url) {
    try { return new URL(url, location.href).href; } catch (_) { return String(url || ""); }
  }
  function wrapJquery() {
    try {
      var jq = window.jQuery || window.$;
      if (!jq || !jq.ajax || jq.ajax.__autobuyWrapped) return;
      var originalAjax = jq.ajax;
      jq.ajax = function(options) {
        if (typeof options === "string") options = { url: options };
        options = options || {};
        var url = absoluteUrl(options.url || "");
        var method = options.type || options.method || "GET";
        var requestBody = options.data;
        var userSuccess = options.success;
        options.success = function(data, textStatus, xhr) {
          send({
            kind: "jquery-success",
            url: url,
            method: method,
            requestJson: parseMaybeJson(requestBody),
            requestText: typeof requestBody === "string" ? requestBody : "",
            responseJson: parseMaybeJson(data),
            status: xhr && xhr.status
          });
          if (userSuccess) return userSuccess.apply(this, arguments);
        };
        return originalAjax.apply(this, arguments);
      };
      jq.ajax.__autobuyWrapped = true;
    } catch (_) {}
  }
  function wrapFetch() {
    try {
      if (!window.fetch || window.fetch.__autobuyWrapped) return;
      var originalFetch = window.fetch;
      window.fetch = function(input, init) {
        var url = absoluteUrl(typeof input === "string" ? input : input && input.url);
        var method = (init && init.method) || "GET";
        var requestBody = init && init.body;
        return originalFetch.apply(this, arguments).then(function(response) {
          try {
            var clone = response.clone();
            clone.text().then(function(text) {
              send({
                kind: "fetch-response",
                url: url,
                method: method,
                requestJson: parseMaybeJson(requestBody),
                requestText: typeof requestBody === "string" ? requestBody : "",
                responseJson: parseMaybeJson(text),
                responseText: text,
                status: response.status
              });
            }).catch(function(){});
          } catch (_) {}
          return response;
        });
      };
      window.fetch.__autobuyWrapped = true;
    } catch (_) {}
  }
  function wrapXhr() {
    try {
      if (!window.XMLHttpRequest || window.XMLHttpRequest.__autobuyWrapped) return;
      var originalOpen = XMLHttpRequest.prototype.open;
      var originalSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function(method, url) {
        this.__autobuyMethod = method || "GET";
        this.__autobuyUrl = absoluteUrl(url || "");
        return originalOpen.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function(body) {
        var xhr = this;
        xhr.__autobuyRequestBody = body;
        xhr.addEventListener("load", function() {
          send({
            kind: "xhr-load",
            url: xhr.__autobuyUrl,
            method: xhr.__autobuyMethod,
            requestJson: parseMaybeJson(xhr.__autobuyRequestBody),
            requestText: typeof xhr.__autobuyRequestBody === "string" ? xhr.__autobuyRequestBody : "",
            responseJson: parseMaybeJson(xhr.responseText),
            responseText: xhr.responseText,
            status: xhr.status
          });
        });
        return originalSend.apply(this, arguments);
      };
      window.XMLHttpRequest.__autobuyWrapped = true;
    } catch (_) {}
  }
  function executeCommand(command) {
    if (!command || command.type !== "apiCall" || !command.id) return;
    try {
      var jq = window.jQuery || window.$;
      if (!jq || !jq.ajax) throw new Error("页面 AJAX 尚未就绪");
      var baseUrl = window.basisUrl || "https://wis2.trasen.womei.org/api/";
      var url = command.apiPath.indexOf("http") === 0 ? command.apiPath : baseUrl.replace(/\\/$/, "") + "/" + command.apiPath.replace(/^\\//, "");
      jq.ajax({
        url: url,
        type: "POST",
        data: JSON.stringify(command.payload || {}),
        success: function(data) {
          postResult({ id: command.id, responseJson: parseMaybeJson(data) });
        },
        error: function(xhr, textStatus, errorThrown) {
          postResult({ id: command.id, error: errorThrown || textStatus || "页面接口调用失败" });
        }
      });
    } catch (error) {
      postResult({ id: command.id, error: error && error.message ? error.message : String(error) });
    }
  }
  function postResult(payload) {
    try {
      fetch("http://127.0.0.1:${Number(plainPort)}/__autobuy_result", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify(payload),
        keepalive: true
      }).catch(function(){});
    } catch (_) {}
  }
  function pollCommand() {
    try {
      fetch("http://127.0.0.1:${Number(plainPort)}/__autobuy_command", { cache: "no-store" })
        .then(function(response) { return response.json(); })
        .then(function(command) { executeCommand(command); })
        .catch(function(){});
    } catch (_) {}
  }
  wrapFetch();
  wrapXhr();
  wrapJquery();
  var tries = 0;
  var timer = setInterval(function(){
    wrapJquery();
    tries += 1;
    if (tries > 80) clearInterval(timer);
  }, 250);
  setInterval(pollCommand, 500);
})();`;
}

function plainPayloadToEntry(payload) {
  const url = String(payload?.url || "");
  if (!url.includes("/api/")) {
    return null;
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch (_error) {
    return null;
  }
  if (parsed.hostname !== TARGET_HOST) {
    return null;
  }

  return {
    capturedAt: new Date().toISOString(),
    method: payload.method || "POST",
    host: parsed.hostname,
    path: parsed.pathname,
    url,
    requestHeaders: {
      source: "page-hook",
      pageUrl: payload.pageUrl || ""
    },
    requestBody: payload.requestText || "",
    responseStatusCode: payload.status || 0,
    responseHeaders: {
      source: "page-hook"
    },
    responseBody: payload.responseText || "",
    request_body_json: payload.requestJson,
    response_body_json: payload.responseJson
  };
}

function writePlainCaptureResponse(res) {
  res.writeHead(204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end();
}

function writeJsonResponse(res, payload) {
  res.writeHead(200, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json;charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function listenHttpServer(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

function buildWindowsProxyScript(enable, server) {
  const lines = [
    "$regPath = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'",
    "New-Item -Path $regPath -Force | Out-Null"
  ];

  if (enable) {
    lines.push(`New-ItemProperty -Path $regPath -Name ProxyEnable -Value 1 -PropertyType DWord -Force | Out-Null`);
    lines.push(
      `New-ItemProperty -Path $regPath -Name ProxyServer -Value '${escapePowerShell(server)}' -PropertyType String -Force | Out-Null`
    );
    lines.push(`New-ItemProperty -Path $regPath -Name ProxyOverride -Value '<local>' -PropertyType String -Force | Out-Null`);
  } else {
    lines.push(`New-ItemProperty -Path $regPath -Name ProxyEnable -Value 0 -PropertyType DWord -Force | Out-Null`);
  }

  lines.push(
    [
      "Add-Type @'",
      "using System;",
      "using System.Runtime.InteropServices;",
      "public class WinInetProxyRefresh {",
      '  [DllImport("wininet.dll", SetLastError=true)]',
      "  public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);",
      "}",
      "'@",
      "[WinInetProxyRefresh]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null",
      "[WinInetProxyRefresh]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) | Out-Null"
    ].join("\n")
  );

  return lines.join(";\n");
}

function escapePowerShell(value) {
  return String(value || "").replaceAll("'", "''");
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      reject(new Error(stderr || command + " failed with exit code " + code));
    });
  });
}

function runPowerShell(script) {
  return runCommand("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script]);
}

async function listMacNetworkServices() {
  const stdout = await runCommand("networksetup", ["-listallnetworkservices"]);
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("An asterisk"))
    .map((line) => line.replace(/^\*\s*/, ""));
}

module.exports = { ProxyService };
