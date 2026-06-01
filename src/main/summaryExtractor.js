const crypto = require("node:crypto");
const { getConfig, decryptPayload } = require("./trasenCrypto");

function maybeJsonLoad(rawText) {
  try {
    return JSON.parse(rawText);
  } catch (_error) {
    return rawText;
  }
}

function decodeEntry(entry, aesKey = "") {
  const decoded = { ...entry };
  const requestBodyRaw = entry.requestBody || "";
  const responseBodyRaw = entry.responseBody || "";

  decoded.request_body_encrypted = requestBodyRaw;
  decoded.response_body_encrypted = responseBodyRaw;

  if (requestBodyRaw) {
    try {
      decoded.request_body_decrypted = decryptPayload(requestBodyRaw);
      decoded.request_body_json = maybeJsonLoad(decoded.request_body_decrypted);
    } catch (error) {
      decoded.request_body_decrypt_error = String(error.message || error);
      if (aesKey) {
        try {
          decoded.request_body_decrypted = decryptPayloadWithKey(requestBodyRaw, aesKey);
          decoded.request_body_json = maybeJsonLoad(decoded.request_body_decrypted);
          delete decoded.request_body_decrypt_error;
        } catch (_fallbackError) {
          // keep original error
        }
      }
    }
  }

  if (responseBodyRaw) {
    try {
      decoded.response_body_decrypted = decryptPayload(responseBodyRaw);
      decoded.response_body_json = maybeJsonLoad(decoded.response_body_decrypted);
    } catch (error) {
      decoded.response_body_decrypt_error = String(error.message || error);
      if (aesKey) {
        try {
          decoded.response_body_decrypted = decryptPayloadWithKey(responseBodyRaw, aesKey);
          decoded.response_body_json = maybeJsonLoad(decoded.response_body_decrypted);
          delete decoded.response_body_decrypt_error;
        } catch (_fallbackError) {
          // keep original error
        }
      }
    }
  }

  return decoded;
}

function buildSessionSummary(entries) {
  const capturedConfig = extractCapturedConfig(entries);
  const aesKey = getConfig().aesKey || capturedConfig.aesKeysSeen[0] || "";
  const departmentsByKey = collectDepartments(entries, aesKey);
  const summary = {
    tokensSeen: [],
    tokenDetails: [],
    orgCodesSeen: [],
    appIdsSeen: capturedConfig.appIdsSeen,
    appSecretsSeen: capturedConfig.appSecretsSeen,
    aesKeysSeen: capturedConfig.aesKeysSeen,
    patients: [],
    cards: [],
    doctors: [],
    scheduleRows: [],
    scheduleTimes: [],
    orders: []
  };

  const tokenSet = new Set();
  const tokenDetails = new Map();
  const orgCodeSet = new Set();
  const patientSet = new Set();
  const cardSet = new Set();
  const doctorSet = new Set();

  for (const rawEntry of entries) {
    const entry = rawEntry.request_body_json ? rawEntry : decodeEntry(rawEntry, aesKey);
    const headers = entry.requestHeaders || {};
    const token = getHeader(headers, "token");
    const orgCode = getHeader(headers, "orgCode");
    const appId = getHeader(headers, "appid");
    const appSecret = getHeader(headers, "appSecret");
    if (appId && !summary.appIdsSeen.includes(String(appId))) summary.appIdsSeen.push(String(appId));
    if (appSecret && !summary.appSecretsSeen.includes(String(appSecret))) summary.appSecretsSeen.push(String(appSecret));
    if (token) {
      tokenSet.add(token);
      const key = String(token);
      const existing = tokenDetails.get(key) || {
        token: key,
        firstSeenAt: rawEntry.capturedAt || "",
        lastSeenAt: rawEntry.capturedAt || "",
        count: 0,
        jwt: decodeJwtMetadata(key)
      };
      existing.count += 1;
      existing.lastSeenAt = rawEntry.capturedAt || existing.lastSeenAt;
      tokenDetails.set(key, existing);
    }
    if (orgCode) orgCodeSet.add(String(orgCode));

    const path = entry.path || "";
    const responseJson = entry.response_body_json;
    const requestJson = entry.request_body_json;
    const refererDoctor = doctorFromReferer(headers, orgCode);
    if (refererDoctor) {
      addDoctor(summary, doctorSet, refererDoctor);
    }

    if (path.startsWith("/api/basic/doctor/queryKqyyDoctor")) {
      for (const item of (responseJson?.data || [])) {
        addDoctor(summary, doctorSet, {
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
        });
      }
    } else if (path.startsWith("/api/bz/patient/queryPatientByUser")) {
      for (const patient of responseJson?.data || []) {
        const patientId = String(patient.id);
        if (!patientSet.has(patientId)) {
          patientSet.add(patientId);
          summary.patients.push({
            id: patient.id,
            name: patient.name,
            certificateType: patient.certificateType,
            certificateNoMasked: patient.certificateNoMasked,
            birthday: patient.birthday,
            regionId: patient.regionId
          });
        }
        for (const card of patient.wisdomPatientCardList || []) {
          const cardId = String(card.id);
          if (cardSet.has(cardId)) continue;
          cardSet.add(cardId);
          summary.cards.push({
            patientId: patient.id,
            id: card.id,
            cardType: card.cardType,
            cardNoMasked: card.cardNoMasked,
            cardNo: card.cardNo
          });
        }
      }
    } else if (path.startsWith("/api/bz/appointment/schedule")) {
      summary.scheduleRows.push({
        request: requestJson,
        responseRows: responseJson?.data?.rows || []
      });
      for (const row of responseJson?.data?.rows || []) {
        const deptId = requestJson?.departmentId || row.departmentId || "";
        const deptCode = requestJson?.departmentCode || row.departmentCode || "";
        const department = departmentsByKey.get(String(deptId)) || departmentsByKey.get(String(deptCode)) || {};
        addDoctor(summary, doctorSet, {
          doctorId: row.docId || row.doctorId || "",
          doctorCode: requestJson?.doctorCode || row.doctorId || "",
          doctorName: row.doctorName || "",
          deptId,
          deptCode,
          deptName: row.departmentName || department.deptName || "",
          hospRegionCode: orgCode || "",
          hospRegionName: department.parentDeptName || department.hospRegionName || "",
          levelName: row.levelName || "",
          scheduleDateList: [],
          scheduleDates: []
        });
      }
    } else if (path.startsWith("/api/bz/appointment/scheduleTime")) {
      summary.scheduleTimes.push({
        request: requestJson,
        responseRows: responseJson?.data?.rows || []
      });
    } else if (path.startsWith("/api/bz/appointment/order") || path.startsWith("/api/bz/register/order")) {
      summary.orders.push({
        path,
        request: requestJson,
        response: responseJson
      });
    }
  }

  summary.tokensSeen = Array.from(tokenSet);
  summary.tokenDetails = Array.from(tokenDetails.values());
  summary.orgCodesSeen = Array.from(orgCodeSet);
  return summary;
}

function addDoctor(summary, doctorSet, item) {
  const key = [
    item.doctorId,
    item.doctorCode,
    item.deptId,
    item.deptCode,
    item.hospRegionCode
  ].join("|");
  if (doctorSet.has(key)) {
    const existing = summary.doctors.find(
      (doctor) =>
        String(doctor.doctorId || "") === String(item.doctorId || "") &&
        String(doctor.doctorCode || "") === String(item.doctorCode || "") &&
        String(doctor.deptId || "") === String(item.deptId || "") &&
        String(doctor.deptCode || "") === String(item.deptCode || "") &&
        String(doctor.hospRegionCode || "") === String(item.hospRegionCode || "")
    );
    if (existing) {
      mergeDoctor(existing, item);
    }
    return;
  }
  doctorSet.add(key);
  summary.doctors.push(item);
}

function mergeDoctor(target, source) {
  for (const [key, value] of Object.entries(source || {})) {
    if ((target[key] === undefined || target[key] === null || target[key] === "") && value) {
      target[key] = value;
    }
  }
}

function doctorFromReferer(headers, orgCode) {
  const referer = getHeader(headers, "referer");
  if (!referer || !referer.includes("selectDoctor.html")) {
    return null;
  }

  try {
    const parsed = new URL(referer);
    const params = parsed.searchParams;
    const doctorCode = params.get("doctorCode") || "";
    const doctorId = params.get("doctorsId") || params.get("doctorId") || "";
    const deptId = params.get("departmentId") || "";
    const deptCode = params.get("departmentCode") || "";
    if (!doctorCode || !deptId || !deptCode) {
      return null;
    }

    return {
      doctorId,
      doctorCode,
      doctorName: params.get("doctorName") || "",
      deptId,
      deptCode,
      deptName: params.get("departmentName") || "",
      hospRegionCode: orgCode || "",
      hospRegionName: "",
      levelName: "",
      scheduleDateList: [],
      scheduleDates: []
    };
  } catch (_error) {
    return null;
  }
}

function extractCapturedConfig(entries) {
  const appIds = new Set();
  const appSecrets = new Set();
  const candidates = new Set();

  for (const entry of entries || []) {
    const headers = entry.requestHeaders || {};
    const appId = getHeader(headers, "appid");
    const appSecret = getHeader(headers, "appSecret");
    if (appId) appIds.add(String(appId));
    if (appSecret) appSecrets.add(String(appSecret));

    const text = [entry.requestBody, entry.responseBody].filter(Boolean).join("\n");
    for (const candidate of findAesKeyCandidates(text)) {
      candidates.add(candidate);
    }
  }

  const validAesKeys = Array.from(candidates).filter((candidate) => validatesAnyApiPayload(candidate, entries));
  return {
    appIdsSeen: Array.from(appIds),
    appSecretsSeen: Array.from(appSecrets),
    aesKeysSeen: validAesKeys
  };
}

function collectDepartments(entries, aesKey) {
  const byKey = new Map();
  for (const rawEntry of entries || []) {
    const entry = rawEntry.request_body_json ? rawEntry : decodeEntry(rawEntry, aesKey);
    if (!String(entry.path || "").startsWith("/api/basic/department/queryRegisterDepartments")) {
      continue;
    }
    const rows = entry.response_body_json?.data || [];
    const byId = new Map(rows.map((item) => [String(item.id || ""), item]));
    const byCode = new Map(rows.map((item) => [String(item.deptCode || ""), item]));
    for (const item of rows) {
      const parent =
        byId.get(String(item.parentId || "")) ||
        byCode.get(String(item.parentDeptCode || "")) ||
        null;
      const normalized = {
        id: item.id,
        deptCode: item.deptCode,
        deptName: item.deptName,
        parentDeptCode: item.parentDeptCode,
        parentId: item.parentId,
        parentDeptName: parent?.deptName || ""
      };
      if (item.id) byKey.set(String(item.id), normalized);
      if (item.deptCode) byKey.set(String(item.deptCode), normalized);
    }
  }
  return byKey;
}

function findAesKeyCandidates(text) {
  const candidates = new Set();
  const source = String(text || "");
  if (!source) {
    return [];
  }

  const envPatterns = [
    /TRASEN_AES_KEY\s*[:=]\s*["']([^"']{16})["']/g,
    /aes[_-]?key\s*[:=]\s*["']([^"']{16})["']/gi,
    /AES[_-]?KEY\s*[:=]\s*["']([^"']{16})["']/g
  ];
  for (const pattern of envPatterns) {
    for (const match of source.matchAll(pattern)) {
      candidates.add(match[1]);
    }
  }

  const keywordPattern = /(AES|CryptoJS|encrypt|decrypt|ECB|ZeroPadding|appSecret|appid|secret|key)/i;
  const stringPattern = /["']([A-Za-z0-9+/=_\-]{16})["']/g;
  for (const match of source.matchAll(stringPattern)) {
    const index = match.index || 0;
    const windowText = source.slice(Math.max(0, index - 160), Math.min(source.length, index + 180));
    if (keywordPattern.test(windowText)) {
      candidates.add(match[1]);
    }
  }

  return Array.from(candidates);
}

function validatesAnyApiPayload(aesKey, entries) {
  if (!aesKey || String(aesKey).length !== 16) {
    return false;
  }
  for (const entry of entries || []) {
    if (!String(entry.path || "").startsWith("/api/")) {
      continue;
    }
    for (const body of [entry.responseBody, entry.requestBody]) {
      if (!body) {
        continue;
      }
      try {
        const parsed = JSON.parse(decryptPayloadWithKey(body, aesKey));
        if (parsed && typeof parsed === "object" && Object.prototype.hasOwnProperty.call(parsed, "code")) {
          return true;
        }
      } catch (_error) {
        // try next payload
      }
    }
  }
  return false;
}

function decryptPayloadWithKey(rawText, aesKey) {
  const decipher = crypto.createDecipheriv("aes-128-ecb", Buffer.from(aesKey, "utf8"), null);
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(String(rawText || "").trim(), "base64")),
    decipher.final()
  ]);
  return zeroUnpad(decrypted).toString("utf8");
}

function zeroUnpad(buffer) {
  let end = buffer.length;
  while (end > 0 && buffer[end - 1] === 0) {
    end -= 1;
  }
  return buffer.subarray(0, end);
}

function decodeJwtMetadata(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(base64UrlToBase64(parts[1]), "base64").toString("utf8"));
    return {
      exp: payload.exp || null,
      expIso: payload.exp ? new Date(Number(payload.exp) * 1000).toISOString() : "",
      keys: Object.keys(payload).sort()
    };
  } catch (_error) {
    return null;
  }
}

function base64UrlToBase64(value) {
  let next = String(value || "").replaceAll("-", "+").replaceAll("_", "/");
  while (next.length % 4) {
    next += "=";
  }
  return next;
}

function getHeader(headers, name) {
  if (!headers) {
    return "";
  }
  const target = String(name || "").toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === target) {
      return value;
    }
  }
  return "";
}

module.exports = {
  decodeEntry,
  buildSessionSummary
};
