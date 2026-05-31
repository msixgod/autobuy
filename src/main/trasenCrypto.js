const crypto = require("node:crypto");

const APP_ID = process.env.TRASEN_APP_ID || "";
const APP_SECRET = process.env.TRASEN_APP_SECRET || "";
const AES_KEY = process.env.TRASEN_AES_KEY || "";

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
  const missing = [];
  if (!APP_ID) missing.push("TRASEN_APP_ID");
  if (!APP_SECRET) missing.push("TRASEN_APP_SECRET");
  if (!AES_KEY) missing.push("TRASEN_AES_KEY");
  if (missing.length > 0) {
    throw new Error("Missing Trasen secrets: " + missing.join(", "));
  }
}

function encryptPayload(rawText) {
  ensureCryptoConfigured();
  const cipher = crypto.createCipheriv("aes-128-ecb", Buffer.from(AES_KEY, "utf8"), null);
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([
    cipher.update(zeroPad(Buffer.from(rawText, "utf8"))),
    cipher.final()
  ]);
  return encrypted.toString("base64");
}

function decryptPayload(rawText) {
  ensureCryptoConfigured();
  const decipher = crypto.createDecipheriv("aes-128-ecb", Buffer.from(AES_KEY, "utf8"), null);
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(rawText, "base64")),
    decipher.final()
  ]);
  return zeroUnpad(decrypted).toString("utf8");
}

function requestSign(bodyText, orgCode) {
  ensureCryptoConfigured();
  return crypto
    .createHash("md5")
    .update(APP_ID + bodyText + (orgCode || "") + APP_SECRET, "utf8")
    .digest("hex")
    .toUpperCase();
}

module.exports = {
  APP_ID,
  APP_SECRET,
  AES_KEY,
  ensureCryptoConfigured,
  encryptPayload,
  decryptPayload,
  requestSign
};
