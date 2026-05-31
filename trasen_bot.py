import argparse
import json
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional

from trasen_api_scraper import TrasenClient, load_config


def now_text() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def append_log(path: Optional[Path], message: str) -> None:
    line = "[{}] {}".format(now_text(), message)
    print(line)
    if path:
        with path.open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")


def normalize_noon(value: Any) -> Optional[int]:
    if value in (None, "", 0, "0"):
        return None
    return int(value)


def load_all_doctors(client: TrasenClient) -> List[Dict[str, Any]]:
    response = client.query_doctors()
    if response.get("code") != 0:
        raise RuntimeError("queryKqyyDoctor failed: {}".format(response))
    return response.get("data") or []


def doctor_matches(doctor: Dict[str, Any], target: Dict[str, Any]) -> bool:
    checks = [
        ("hosp_region_name", "hospRegionName"),
        ("hosp_region_code", "hospRegionCode"),
        ("department_name", "deptName"),
        ("department_code", "deptCode"),
        ("doctor_name", "doctorName"),
        ("doctor_code", "doctorCode"),
    ]
    for config_key, field_key in checks:
        expected = target.get(config_key)
        if expected in (None, ""):
            continue
        actual = doctor.get(field_key)
        if str(actual) != str(expected):
            return False
    return True


def find_target_doctor(client: TrasenClient, target: Dict[str, Any]) -> Dict[str, Any]:
    doctors = load_all_doctors(client)
    matches = [doctor for doctor in doctors if doctor_matches(doctor, target)]
    if not matches:
        raise RuntimeError("No doctor matched target filters: {}".format(target))
    if len(matches) > 1:
        summary = [
            {
                "doctorName": item.get("doctorName"),
                "doctorCode": item.get("doctorCode"),
                "doctorId": item.get("doctorId"),
                "deptName": item.get("deptName"),
                "deptCode": item.get("deptCode"),
                "hospRegionName": item.get("hospRegionName"),
                "hospRegionCode": item.get("hospRegionCode"),
            }
            for item in matches[:10]
        ]
        raise RuntimeError("Target matched multiple doctors; narrow config: {}".format(summary))
    return matches[0]


def query_schedule(client: TrasenClient, doctor: Dict[str, Any], target: Dict[str, Any]) -> List[Dict[str, Any]]:
    register_date = target.get("register_date") or ""
    today = datetime.now().date()
    fallback_end_date = (today + timedelta(days=7)).strftime("%Y-%m-%d")
    payload: Dict[str, Any] = {
        "doctorCode": doctor["doctorCode"],
        "departmentId": doctor["deptId"],
        "departmentCode": doctor["deptCode"],
        "startDate": register_date or today.strftime("%Y-%m-%d"),
        "endDate": register_date or target.get("end_date") or fallback_end_date,
        "isUpdateRemainCount": 1,
    }
    isfz = int(target.get("isfz", 0))
    if isfz:
        payload["isfz"] = isfz

    response = client.post("bz/appointment/schedule", payload)
    if response.get("code") != 0:
        raise RuntimeError("appointment schedule failed: {}".format(response))
    return (response.get("data") or {}).get("rows") or []


def pick_schedule_row(rows: List[Dict[str, Any]], target: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    register_date = target.get("register_date") or ""
    noon = normalize_noon(target.get("noon"))
    filtered = rows[:]
    if register_date:
        filtered = [row for row in filtered if row.get("registerDate") == register_date]
    if noon is not None:
        filtered = [row for row in filtered if int(row.get("noon", 0)) == noon]
    filtered = [row for row in filtered if int(row.get("remainCount", 0)) > 0]
    if not filtered:
        return None
    filtered.sort(key=lambda item: (item.get("registerDate", ""), item.get("noon", 0), item.get("startTime", "")))
    return filtered[0]


def query_time_slots(client: TrasenClient, doctor: Dict[str, Any], schedule_row: Dict[str, Any]) -> List[Dict[str, Any]]:
    payload = {
        "doctorCode": schedule_row["doctorId"],
        "departmentId": doctor["deptId"],
        "departmentCode": doctor["deptCode"],
        "registerDate": schedule_row["registerDate"],
        "scheduleId": schedule_row["id"],
        "noon": 0 if int(schedule_row.get("noon", 0)) == 4 else schedule_row["noon"],
    }
    response = client.post("bz/appointment/scheduleTime", payload)
    if response.get("code") != 0:
        raise RuntimeError("scheduleTime failed: {}".format(response))
    return (response.get("data") or {}).get("rows") or []


def pick_time_slot(slots: List[Dict[str, Any]], target: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    start_time = target.get("start_time") or ""
    end_time = target.get("end_time") or ""
    available = [slot for slot in slots if int(slot.get("remainCount", 0)) > 0]
    if start_time:
        exact = [slot for slot in available if slot.get("startTime") == start_time]
        if end_time:
            exact = [slot for slot in exact if slot.get("endTime") == end_time]
        if exact:
            return exact[0]
        return None
    available.sort(key=lambda item: item.get("startTime", ""))
    return available[0] if available else None


def query_patients(client: TrasenClient, patient_cfg: Dict[str, Any]) -> List[Dict[str, Any]]:
    payload = {
        "orgId": patient_cfg["campus_org_id"],
        "regionId": patient_cfg["campus_region_id"],
        "isAll": 1,
    }
    response = client.post("bz/patient/queryPatientByUser", payload)
    if response.get("code") != 0:
        raise RuntimeError("queryPatientByUser failed: {}".format(response))
    return response.get("data") or []


def select_patient_from_list(patients: List[Dict[str, Any]], patient_cfg: Dict[str, Any]) -> Dict[str, Any]:
    if patient_cfg.get("pat_id"):
        for patient in patients:
            if str(patient.get("id")) == str(patient_cfg["pat_id"]):
                return patient
        raise RuntimeError("Configured pat_id was not found")

    matches = []
    for patient in patients:
        if patient_cfg.get("name") and patient.get("name") != patient_cfg["name"]:
            continue
        if patient_cfg.get("certificate_no") and patient.get("certificateNo") != patient_cfg["certificate_no"]:
            continue
        matches.append(patient)

    if not matches:
        raise RuntimeError("No patient matched config")
    if len(matches) > 1:
        summary = [{"id": item.get("id"), "name": item.get("name"), "certificateNoMasked": item.get("certificateNoMasked")} for item in matches]
        raise RuntimeError("Multiple patients matched config: {}".format(summary))
    return matches[0]


def bind_patient_if_needed(client: TrasenClient, patient: Dict[str, Any], patient_cfg: Dict[str, Any]) -> Dict[str, Any]:
    current_region_id = str(patient.get("regionId", ""))
    target_region_id = str(patient_cfg.get("campus_region_id", ""))
    cards = patient.get("wisdomPatientCardList") or []
    if cards and current_region_id == target_region_id:
        return patient
    if not patient_cfg.get("bind_if_needed", True):
        return patient

    bind_payload = dict(patient)
    bind_payload["profession"] = bind_payload.get("profession") or "17"
    bind_payload["orgId"] = patient_cfg["campus_org_id"]
    bind_payload["regionId"] = patient_cfg["campus_region_id"]
    bind_payload["patientType"] = 0

    response = client.post("bz/patient/savePatientAndBind", bind_payload)
    if response.get("code") != 0:
        raise RuntimeError("savePatientAndBind failed: {}".format(response))
    return response.get("data") or patient


def select_card(patient: Dict[str, Any], patient_cfg: Dict[str, Any]) -> Dict[str, Any]:
    cards = patient.get("wisdomPatientCardList") or []
    if not cards:
        raise RuntimeError("Selected patient has no cards bound")

    if patient_cfg.get("pat_card_id"):
        for card in cards:
            if str(card.get("id")) == str(patient_cfg["pat_card_id"]):
                return card
        raise RuntimeError("Configured pat_card_id was not found")

    if patient_cfg.get("card_id"):
        for card in cards:
            if str(card.get("id")) == str(patient_cfg["card_id"]):
                return card
        raise RuntimeError("Configured card_id was not found")

    filtered = cards
    if patient_cfg.get("card_no"):
        filtered = [card for card in filtered if str(card.get("cardNo")) == str(patient_cfg["card_no"])]
    if patient_cfg.get("card_type"):
        filtered = [card for card in filtered if int(card.get("cardType", 0)) == int(patient_cfg["card_type"])]

    if not filtered:
        raise RuntimeError("No card matched patient config")
    return filtered[0]


def create_order(
    client: TrasenClient,
    doctor: Dict[str, Any],
    schedule_row: Dict[str, Any],
    slot: Dict[str, Any],
    config: Dict[str, Any],
) -> Dict[str, Any]:
    patient_cfg = config["patient"]
    patients = query_patients(client, patient_cfg)
    patient = select_patient_from_list(patients, patient_cfg)
    patient = bind_patient_if_needed(client, patient, patient_cfg)
    card = select_card(patient, patient_cfg)

    payload: Dict[str, Any] = {
        "payChannel": "1",
        "scheduleId": slot["scheduleId"],
        "deptCode": doctor["deptCode"],
        "docCode": schedule_row["doctorId"],
        "registerDate": schedule_row["registerDate"],
        "noon": slot["noon"],
        "startTime": slot["startTime"],
        "endTime": slot["endTime"],
        "registerFee": schedule_row["registerFee"],
        "visitFlag": "0",
        "timeId": slot["id"],
        "patId": patient["id"],
        "patCardId": card["id"],
    }
    if int(config["target"].get("isfz", 0)):
        payload["isfz"] = int(config["target"]["isfz"])

    response = client.post("bz/appointment/order", payload)
    if response.get("code") != 0:
        raise RuntimeError("appointment order failed: {}".format(response))
    data = response.get("data") or {}
    platform_order_num = data.get("platformOrderNum")
    if platform_order_num:
        data["payment_url"] = (
            "http://cskq.trasen.womei.org/v2/weChat/html/cashier/regPay.html?platformOrderNum={}".format(
                platform_order_num
            )
        )
    return data


def run_bot(config: Dict[str, Any], log_path: Optional[Path]) -> int:
    client = TrasenClient(config)
    target = config["target"]
    watch_cfg = config["watch"]
    poll_interval = max(1, int(watch_cfg.get("poll_interval_seconds", 3)))
    max_attempts = int(watch_cfg.get("max_attempts", 0))
    alert_only = bool(watch_cfg.get("alert_only", True))

    doctor = find_target_doctor(client, target)
    client.set_org_code(doctor["hospRegionCode"])
    append_log(
        log_path,
        "Matched doctor: {} / {} / {} / region {}".format(
            doctor["doctorName"],
            doctor["deptName"],
            doctor["doctorCode"],
            doctor["hospRegionCode"],
        ),
    )

    attempt = 0
    while True:
        attempt += 1
        rows = query_schedule(client, doctor, target)
        schedule_row = pick_schedule_row(rows, target)
        if schedule_row:
            append_log(
                log_path,
                "Found schedule row: date={} noon={} remain={} fee={}".format(
                    schedule_row.get("registerDate"),
                    schedule_row.get("noon"),
                    schedule_row.get("remainCount"),
                    schedule_row.get("registerFee"),
                ),
            )
            slots = query_time_slots(client, doctor, schedule_row)
            slot = pick_time_slot(slots, target)
            if slot:
                append_log(
                    log_path,
                    "Matched time slot: {}-{} remain={}/{}".format(
                        slot.get("startTime"),
                        slot.get("endTime"),
                        slot.get("remainCount"),
                        slot.get("totalCount"),
                    ),
                )
                if alert_only:
                    append_log(log_path, "Alert-only mode hit target slot; exiting without ordering.")
                    return 0

                if not config.get("token"):
                    raise RuntimeError("token is required for auto-order mode")

                order_data = create_order(client, doctor, schedule_row, slot, config)
                append_log(log_path, "Order created successfully: {}".format(json.dumps(order_data, ensure_ascii=False)))
                return 0

            append_log(log_path, "Schedule exists but no matching time slot yet.")
        else:
            append_log(log_path, "Attempt {}: target schedule not available yet.".format(attempt))

        if max_attempts > 0 and attempt >= max_attempts:
            append_log(log_path, "Reached max_attempts without a match.")
            return 1
        time.sleep(poll_interval)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Trasen appointment watch-and-order bot")
    parser.add_argument("--config", default="trasen_bot_config.json", help="Path to bot config JSON")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    config_path = Path(args.config)
    if not config_path.exists():
        raise FileNotFoundError(
            "Config file not found: {}. Copy trasen_bot_config.example.json to trasen_bot_config.json and edit it.".format(
                config_path
            )
        )
    config = load_config(config_path)
    output_cfg = config.get("output", {})
    log_path = Path(output_cfg["log_path"]) if output_cfg.get("log_path") else None
    code = run_bot(config, log_path)
    sys.exit(code)


if __name__ == "__main__":
    main()
