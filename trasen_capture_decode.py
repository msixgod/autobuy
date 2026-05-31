import argparse
import base64
import json
import os
from pathlib import Path
from typing import Any, Dict, List
from urllib.parse import urlparse

from Crypto.Cipher import AES


def get_aes_key(cli_value: str = "") -> str:
    value = cli_value or os.environ.get("TRASEN_AES_KEY", "")
    if not value:
        raise RuntimeError("Missing TRASEN_AES_KEY. Pass --aes-key or set the TRASEN_AES_KEY environment variable.")
    return value


def zero_unpad(data: bytes) -> bytes:
    return data.rstrip(b"\x00")


def decrypt_payload(raw_text: str, aes_key: str) -> str:
    cipher = AES.new(aes_key.encode("utf-8"), AES.MODE_ECB)
    encrypted_bytes = base64.b64decode(raw_text)
    decrypted = cipher.decrypt(encrypted_bytes)
    return zero_unpad(decrypted).decode("utf-8")


def maybe_json_load(raw_text: str) -> Any:
    try:
        return json.loads(raw_text)
    except Exception:
        return raw_text


def decode_entry(entry: Dict[str, Any], aes_key: str) -> Dict[str, Any]:
    decoded: Dict[str, Any] = dict(entry)

    request_body_raw = ""
    response_body_raw = ""

    try:
        request_body_raw = base64.b64decode(entry.get("request_text_b64", "")).decode("utf-8", errors="ignore")
    except Exception:
        request_body_raw = ""

    try:
        response_body_raw = base64.b64decode(entry.get("response_text_b64", "")).decode("utf-8", errors="ignore")
    except Exception:
        response_body_raw = ""

    decoded["request_body_encrypted"] = request_body_raw
    decoded["response_body_encrypted"] = response_body_raw

    if request_body_raw:
        try:
            decoded["request_body_decrypted"] = decrypt_payload(request_body_raw, aes_key)
            decoded["request_body_json"] = maybe_json_load(decoded["request_body_decrypted"])
        except Exception as exc:
            decoded["request_body_decrypt_error"] = str(exc)

    if response_body_raw:
        try:
            decoded["response_body_decrypted"] = decrypt_payload(response_body_raw, aes_key)
            decoded["response_body_json"] = maybe_json_load(decoded["response_body_decrypted"])
        except Exception as exc:
            decoded["response_body_decrypt_error"] = str(exc)

    return decoded


def get_header(headers: Dict[str, Any], name: str) -> Any:
    target = name.lower()
    for key, value in (headers or {}).items():
        if str(key).lower() == target:
            return value
    return None


def build_session_summary(entries: List[Dict[str, Any]]) -> Dict[str, Any]:
    summary: Dict[str, Any] = {
        "tokens_seen": [],
        "org_codes_seen": [],
        "patients": [],
        "cards": [],
        "selected_doctors": [],
        "schedule_rows": [],
        "schedule_times": [],
        "orders": [],
    }

    tokens = set()
    org_codes = set()
    patient_ids = set()
    card_ids = set()
    doctor_keys = set()

    for entry in entries:
        headers = entry.get("request_headers", {}) or {}
        token = get_header(headers, "token")
        org_code = get_header(headers, "orgCode")
        if token:
            tokens.add(token)
        if org_code:
            org_codes.add(str(org_code))

        path = entry.get("path", "")
        response_json = entry.get("response_body_json")
        request_json = entry.get("request_body_json")

        if path.startswith("/api/basic/doctor/queryKqyyDoctor"):
            for item in ((response_json or {}).get("data") or []):
                key = (
                    str(item.get("doctorId")),
                    str(item.get("doctorCode")),
                    str(item.get("deptId")),
                    str(item.get("deptCode")),
                    str(item.get("hospRegionCode")),
                )
                if key not in doctor_keys:
                    doctor_keys.add(key)
                    summary["selected_doctors"].append(
                        {
                            "doctorId": item.get("doctorId"),
                            "doctorCode": item.get("doctorCode"),
                            "doctorName": item.get("doctorName"),
                            "deptId": item.get("deptId"),
                            "deptCode": item.get("deptCode"),
                            "deptName": item.get("deptName"),
                            "hospRegionCode": item.get("hospRegionCode"),
                            "hospRegionName": item.get("hospRegionName"),
                            "scheduleDateList": item.get("scheduleDateList"),
                            "scheduleDates": item.get("scheduleDates"),
                        }
                    )

        elif path.startswith("/api/bz/patient/queryPatientByUser"):
            for patient in (response_json or {}).get("data") or []:
                if str(patient.get("id")) not in patient_ids:
                    patient_ids.add(str(patient.get("id")))
                    summary["patients"].append(
                        {
                            "id": patient.get("id"),
                            "name": patient.get("name"),
                            "certificateType": patient.get("certificateType"),
                            "certificateNoMasked": patient.get("certificateNoMasked"),
                            "birthday": patient.get("birthday"),
                            "regionId": patient.get("regionId"),
                        }
                    )
                for card in patient.get("wisdomPatientCardList") or []:
                    if str(card.get("id")) not in card_ids:
                        card_ids.add(str(card.get("id")))
                        summary["cards"].append(
                            {
                                "patientId": patient.get("id"),
                                "id": card.get("id"),
                                "cardType": card.get("cardType"),
                                "cardNoMasked": card.get("cardNoMasked"),
                                "cardNo": card.get("cardNo"),
                            }
                        )

        elif path.startswith("/api/bz/appointment/schedule"):
            summary["schedule_rows"].append(
                {
                    "request": request_json,
                    "response_rows": ((response_json or {}).get("data") or {}).get("rows") or [],
                }
            )

        elif path.startswith("/api/bz/appointment/scheduleTime"):
            summary["schedule_times"].append(
                {
                    "request": request_json,
                    "response_rows": ((response_json or {}).get("data") or {}).get("rows") or [],
                }
            )

        elif path.startswith("/api/bz/appointment/order") or path.startswith("/api/bz/register/order"):
            summary["orders"].append(
                {
                    "path": path,
                    "request": request_json,
                    "response": response_json,
                }
            )

    summary["tokens_seen"] = sorted(tokens)
    summary["org_codes_seen"] = sorted(org_codes)
    return summary


def load_entries(path: Path, aes_key: str) -> List[Dict[str, Any]]:
    entries: List[Dict[str, Any]] = []
    suffix = path.suffix.lower()
    if suffix == ".har":
        return load_har_entries(path, aes_key)

    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            raw_entry = json.loads(line)
            entries.append(decode_entry(raw_entry, aes_key))
    return entries


def load_har_entries(path: Path, aes_key: str) -> List[Dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    har_entries = ((payload or {}).get("log") or {}).get("entries") or []
    entries: List[Dict[str, Any]] = []

    for item in har_entries:
        request = item.get("request") or {}
        response = item.get("response") or {}
        url = request.get("url") or ""
        parsed = urlparse(url)

        request_headers = har_headers_to_dict(request.get("headers") or [])
        response_headers = har_headers_to_dict(response.get("headers") or [])

        request_body = extract_har_request_body(request)
        response_body = extract_har_response_body(response)

        raw_entry = {
            "captured_at": item.get("startedDateTime") or "",
            "method": request.get("method"),
            "scheme": parsed.scheme,
            "host": parsed.hostname or "",
            "port": parsed.port or (443 if parsed.scheme == "https" else 80),
            "path": parsed.path or "/",
            "url": url,
            "request_headers": request_headers,
            "request_text_b64": base64.b64encode(request_body.encode("utf-8")).decode("ascii"),
            "response_status_code": response.get("status"),
            "response_headers": response_headers,
            "response_text_b64": base64.b64encode(response_body.encode("utf-8")).decode("ascii"),
        }
        entries.append(decode_entry(raw_entry, aes_key))

    return entries


def har_headers_to_dict(items: List[Dict[str, Any]]) -> Dict[str, Any]:
    result: Dict[str, Any] = {}
    for item in items:
        name = item.get("name")
        if not name:
            continue
        result[name] = item.get("value")
    return result


def extract_har_request_body(request: Dict[str, Any]) -> str:
    post_data = request.get("postData") or {}
    text = post_data.get("text")
    if isinstance(text, str):
        return text
    return ""


def extract_har_response_body(response: Dict[str, Any]) -> str:
    content = response.get("content") or {}
    text = content.get("text")
    if not isinstance(text, str):
        return ""

    if content.get("encoding") == "base64":
        try:
            return base64.b64decode(text).decode("utf-8", errors="ignore")
        except Exception:
            return ""
    return text


def save_json(path: Path, payload: Any) -> None:
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Decode captured Trasen MITM traffic")
    parser.add_argument("--input", default="trasen_capture.jsonl", help="Path to capture JSONL")
    parser.add_argument("--decoded-output", default="trasen_capture_decoded.json", help="Decoded full output JSON")
    parser.add_argument("--summary-output", default="trasen_capture_summary.json", help="Summary output JSON")
    parser.add_argument("--aes-key", default="", help="Override AES key. Defaults to the TRASEN_AES_KEY environment variable.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    aes_key = get_aes_key(args.aes_key)
    input_path = Path(args.input)
    entries = load_entries(input_path, aes_key)
    summary = build_session_summary(entries)
    save_json(Path(args.decoded_output), entries)
    save_json(Path(args.summary_output), summary)
    print("Decoded {} flow(s)".format(len(entries)))
    print("Wrote {}".format(Path(args.decoded_output).resolve()))
    print("Wrote {}".format(Path(args.summary_output).resolve()))


if __name__ == "__main__":
    main()
