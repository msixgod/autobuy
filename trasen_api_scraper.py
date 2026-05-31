import argparse
import base64
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

import requests
from Crypto.Cipher import AES


def load_config(path: Path) -> Dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def zero_pad(data: bytes, block_size: int = 16) -> bytes:
    remainder = len(data) % block_size
    if remainder == 0:
        return data
    return data + (b"\x00" * (block_size - remainder))


def zero_unpad(data: bytes) -> bytes:
    return data.rstrip(b"\x00")


def encrypt_payload(raw_text: str, aes_key: str) -> str:
    cipher = AES.new(aes_key.encode("utf-8"), AES.MODE_ECB)
    encrypted = cipher.encrypt(zero_pad(raw_text.encode("utf-8")))
    return base64.b64encode(encrypted).decode("utf-8")


def decrypt_payload(raw_text: str, aes_key: str) -> str:
    cipher = AES.new(aes_key.encode("utf-8"), AES.MODE_ECB)
    encrypted_bytes = base64.b64decode(raw_text)
    decrypted = cipher.decrypt(encrypted_bytes)
    return zero_unpad(decrypted).decode("utf-8")


def request_sign(appid: str, body_text: str, org_code: str, app_secret: str) -> str:
    raw = "{}{}{}{}".format(appid, body_text, org_code, app_secret)
    return hashlib.md5(raw.encode("utf-8")).hexdigest().upper()


class TrasenClient:
    def __init__(self, config: Dict[str, Any]) -> None:
        self.base_url = config["base_url"].rstrip("/") + "/"
        self.appid = config["appid"]
        self.app_secret = config["app_secret"]
        self.aes_key = config["aes_key"]
        self.test_uid = config.get("test_uid", "250915")
        self.org_code = config.get("org_code", "")
        self.token = config.get("token", "")
        self.session = requests.Session()
        # This target is often blocked by broken system proxy settings.
        # Ignore environment proxy variables unless the script is changed explicitly.
        self.session.trust_env = False

    def set_org_code(self, org_code: str) -> None:
        self.org_code = org_code

    def post(self, api_path: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        body_text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        encrypted_body = encrypt_payload(body_text, self.aes_key)
        sign = request_sign(self.appid, body_text, self.org_code, self.app_secret)

        headers = {
            "Content-Type": "application/json;charset=UTF-8",
            "TEST-UID": self.test_uid,
            "appid": self.appid,
            "appSecret": self.app_secret,
            "orgCode": self.org_code,
            "sign": sign,
        }
        if self.token:
            headers["token"] = self.token

        response = self.session.post(
            self.base_url + api_path,
            data=encrypted_body,
            headers=headers,
            timeout=30,
        )
        response.raise_for_status()

        decrypted = decrypt_payload(response.text.strip(), self.aes_key)
        return json.loads(decrypted)

    def query_register_departments(self, region_id: str) -> Dict[str, Any]:
        return self.post(
            "basic/department/queryRegisterDepartments/{}".format(region_id),
            {},
        )

    def query_doctors(self) -> Dict[str, Any]:
        return self.post("basic/doctor/queryKqyyDoctor", {})


def normalize_departments(region_id: str, records: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []
    for item in records:
        items.append(
            {
                "region_id": region_id,
                "dept_code": item.get("deptCode"),
                "dept_name": item.get("deptName"),
                "has_child": item.get("hasChild"),
                "description": item.get("deptDescription"),
                "tel": item.get("tel"),
                "location": item.get("deptLocation"),
                "prompt": item.get("prompt"),
            }
        )
    return items


def normalize_doctors(records: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []
    for item in records:
        schedule_dates = item.get("scheduleDateList") or []
        fz_schedule_dates = item.get("fzScheduleDateList") or []
        items.append(
            {
                "doctor_name": item.get("doctorName"),
                "doctor_code": item.get("doctorCode"),
                "level_name": item.get("levelName"),
                "dept_code": item.get("deptCode"),
                "dept_name": item.get("deptName"),
                "hosp_region_code": item.get("hospRegionCode"),
                "hosp_region_name": item.get("hospRegionName"),
                "doctor_skill": item.get("doctorSkill"),
                "appoint_count": item.get("appointCount"),
                "is_full": item.get("isFull"),
                "doctor_picture": item.get("doctorPicture"),
                "extra_param": item.get("extraParam"),
                "schedule_date_list": schedule_dates,
                "fz_schedule_date_list": fz_schedule_dates,
            }
        )
    return items


def run(config: Dict[str, Any]) -> Dict[str, Any]:
    client = TrasenClient(config)
    departments: List[Dict[str, Any]] = []

    for region_id in config["department_region_ids"]:
        response = client.query_register_departments(region_id)
        if response.get("code") != 0:
            raise RuntimeError("Department API failed for {}: {}".format(region_id, response))
        departments.extend(normalize_departments(region_id, response.get("data") or []))

    doctors_response = client.query_doctors()
    if doctors_response.get("code") != 0:
        raise RuntimeError("Doctor API failed: {}".format(doctors_response))

    doctors = normalize_doctors(doctors_response.get("data") or [])
    return {
        "fetched_at_utc": datetime.now(timezone.utc).isoformat(),
        "departments": departments,
        "doctors": doctors,
    }


def save_output(data: Dict[str, Any], output_cfg: Dict[str, Any]) -> Path:
    output_path = Path(output_cfg.get("path", "trasen_output.json"))
    indent = int(output_cfg.get("indent", 2))
    ensure_ascii = bool(output_cfg.get("ensure_ascii", False))

    with output_path.open("w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=indent, ensure_ascii=ensure_ascii)

    return output_path.resolve()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Trasen hospital API scraper")
    parser.add_argument(
        "--config",
        default="trasen_config.json",
        help="Path to a JSON config file",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    config_path = Path(args.config)

    if not config_path.exists():
        raise FileNotFoundError(
            "Config file not found: {}. Copy trasen_config.example.json to trasen_config.json and edit it.".format(
                config_path
            )
        )

    config = load_config(config_path)
    output_data = run(config)
    output_path = save_output(output_data, config.get("output", {}))
    print(
        "Saved {} departments and {} doctors to {}".format(
            len(output_data["departments"]),
            len(output_data["doctors"]),
            output_path,
        )
    )


if __name__ == "__main__":
    main()
