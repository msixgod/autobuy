const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { shell } = require("electron");
const { Proxy } = require("http-mitm-proxy");

const TARGET_HOST = "wis2.trasen.womei.org";

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
    this.entries = [];
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
    this.proxy = new Proxy();

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

      if (target.host === TARGET_HOST) {
        ctx.use(Proxy.gunzip);
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
      return callback(null, chunk);
    });

    this.proxy.onResponseEnd((ctx, callback) => {
      try {
        const capture = ctx.__capture;
        if (!capture) {
          return callback();
        }
        if (capture.host !== TARGET_HOST) {
          return callback();
        }
        if (!String(capture.path || "").startsWith("/api/")) {
          return callback();
        }

        if (capture.method === "OPTIONS") {
          return callback();
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
          responseBody: Buffer.concat(capture.responseChunks || []).toString("utf8")
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

    try {
      await this.disableSystemProxy();
    } catch (error) {
      this.emit("log", "Automatic system proxy disable failed: " + (error.message || error));
    }

    await this.refreshSystemProxyStatus();
    this.emit("log", "Proxy stopped.");
    return this.getStatus();
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
