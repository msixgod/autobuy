const { decryptPayload } = require("./trasenCrypto");

function maybeJsonLoad(rawText) {
  try {
    return JSON.parse(rawText);
  } catch (_error) {
    return rawText;
  }
}

function decodeEntry(entry) {
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
    }
  }

  if (responseBodyRaw) {
    try {
      decoded.response_body_decrypted = decryptPayload(responseBodyRaw);
      decoded.response_body_json = maybeJsonLoad(decoded.response_body_decrypted);
    } catch (error) {
      decoded.response_body_decrypt_error = String(error.message || error);
    }
  }

  return decoded;
}

function buildSessionSummary(entries) {
  const summary = {
    tokensSeen: [],
    orgCodesSeen: [],
    patients: [],
    cards: [],
    doctors: [],
    scheduleRows: [],
    scheduleTimes: [],
    orders: []
  };

  const tokenSet = new Set();
  const orgCodeSet = new Set();
  const patientSet = new Set();
  const cardSet = new Set();
  const doctorSet = new Set();

  for (const rawEntry of entries) {
    const entry = rawEntry.request_body_json ? rawEntry : decodeEntry(rawEntry);
    const headers = entry.requestHeaders || {};
    const token = getHeader(headers, "token");
    const orgCode = getHeader(headers, "orgCode");
    if (token) tokenSet.add(token);
    if (orgCode) orgCodeSet.add(String(orgCode));

    const path = entry.path || "";
    const responseJson = entry.response_body_json;
    const requestJson = entry.request_body_json;

    if (path.startsWith("/api/basic/doctor/queryKqyyDoctor")) {
      for (const item of (responseJson?.data || [])) {
        const key = [
          item.doctorId,
          item.doctorCode,
          item.deptId,
          item.deptCode,
          item.hospRegionCode
        ].join("|");
        if (doctorSet.has(key)) continue;
        doctorSet.add(key);
        summary.doctors.push({
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
  summary.orgCodesSeen = Array.from(orgCodeSet);
  return summary;
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
