const crypto = require("node:crypto");

function getConfig() {
  return {
    appId: process.env.TRASEN_APP_ID || "",
    appSecret: process.env.TRASEN_APP_SECRET || "",
    aesKey: process.env.TRASEN_AES_KEY || ""
  };
}

function zeroPad(buffer, blockSize = 16) {
  const remainder = buffer.length % blockSize;
  if (remainder === 0) {
    return buffer;
  }
  const padding = Buffer.alloc(blockSize - remainder, 0);
  return Buffer.concat([buffer, padding]);
}

function zeroUnpad(buffer) {
  let end = buffer.length;
  while (end > 0 && buffer[end - 1] === 0) {
    end -= 1;
  }
  return buffer.subarray(0, end);
}

function ensureCryptoConfigured() {
  const { appId, appSecret, aesKey } = getConfig();
  const missing = [];
  if (!appId) missing.push("TRASEN_APP_ID");
  if (!appSecret) missing.push("TRASEN_APP_SECRET");
  if (!aesKey) missing.push("TRASEN_AES_KEY");
  if (missing.length > 0) {
    throw new Error(
      "还没有完整捕获页面加密参数: " +
        missing.join(", ") +
        "。请先启动采集环境，然后在 PC 微信里重新进入或刷新挂号页面，让页面资源和接口请求都经过代理。"
    );
  }
}

function encryptPayload(rawText) {
  ensureCryptoConfigured();
  const { aesKey } = getConfig();
  const cipher = crypto.createCipheriv("aes-128-ecb", Buffer.from(aesKey, "utf8"), null);
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([
    cipher.update(zeroPad(Buffer.from(rawText, "utf8"))),
    cipher.final()
  ]);
  return encrypted.toString("base64");
}

function decryptPayload(rawText) {
  ensureCryptoConfigured();
  const { aesKey } = getConfig();
  const decipher = crypto.createDecipheriv("aes-128-ecb", Buffer.from(aesKey, "utf8"), null);
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(rawText, "base64")),
    decipher.final()
  ]);
  return zeroUnpad(decrypted).toString("utf8");
}

function requestSign(bodyText, orgCode) {
  ensureCryptoConfigured();
  const { appId, appSecret } = getConfig();
  return crypto
    .createHash("md5")
    .update(appId + bodyText + (orgCode || "") + appSecret, "utf8")
    .digest("hex")
    .toUpperCase();
}

module.exports = {
  getConfig,
  ensureCryptoConfigured,
  encryptPayload,
  decryptPayload,
  requestSign
};
