import argparse
import shutil
import subprocess
import sys
from pathlib import Path


WORKDIR = Path(__file__).resolve().parent
DEFAULT_CAPTURE_FILE = WORKDIR / "trasen_capture.jsonl"
DEFAULT_DECODED_FILE = WORKDIR / "trasen_capture_decoded.json"
DEFAULT_SUMMARY_FILE = WORKDIR / "trasen_capture_summary.json"
DEFAULT_ADDON_FILE = WORKDIR / "trasen_mitm_addon.py"


def find_mitmdump(explicit_path: str = "") -> Path:
    candidates = []
    if explicit_path:
        candidates.append(Path(explicit_path))

    path_hit = shutil.which("mitmdump")
    if path_hit:
        candidates.append(Path(path_hit))

    local_candidates = [
        WORKDIR / "mitmdump.exe",
        WORKDIR / "tools" / "mitmdump.exe",
        WORKDIR / "mitmproxy" / "mitmdump.exe",
    ]
    candidates.extend(local_candidates)

    for candidate in candidates:
        if candidate.exists():
            return candidate.resolve()

    raise FileNotFoundError(
        "mitmdump executable not found. Put mitmdump.exe in the project folder, "
        "or pass --mitmdump PATH."
    )


def run_decode(python_executable: str, capture_file: Path, decoded_file: Path, summary_file: Path) -> int:
    command = [
        python_executable,
        str(WORKDIR / "trasen_capture_decode.py"),
        "--input",
        str(capture_file),
        "--decoded-output",
        str(decoded_file),
        "--summary-output",
        str(summary_file),
    ]
    return subprocess.call(command, cwd=str(WORKDIR))


def run_capture(
    mitmdump_path: Path,
    capture_file: Path,
    listen_host: str,
    listen_port: int,
) -> int:
    command = [
        str(mitmdump_path),
        "-s",
        str(DEFAULT_ADDON_FILE),
        "--set",
        "save_stream_file={}".format(capture_file),
        "--listen-host",
        listen_host,
        "--listen-port",
        str(listen_port),
    ]

    print("Starting capture proxy")
    print("Proxy address: {}:{}".format(listen_host, listen_port))
    print("Capture file: {}".format(capture_file))
    print("")
    print("Next steps:")
    print("1. Make the target device or PC use this machine as HTTP/HTTPS proxy")
    print("2. Open http://mitm.it on that client and install the proxy certificate")
    print("3. Open the target registration page in WeChat and perform the needed actions")
    print("4. Press Ctrl+C here when enough traffic has been captured")
    print("")

    process = subprocess.Popen(command, cwd=str(WORKDIR))
    try:
        return process.wait()
    except KeyboardInterrupt:
        print("")
        print("Stopping capture...")
        process.terminate()
        try:
            return process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            return process.wait()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="All-in-one launcher for Trasen capture and decode")
    parser.add_argument(
        "--mode",
        choices=["capture", "decode", "all"],
        default="all",
        help="capture only, decode only, or capture then decode",
    )
    parser.add_argument("--mitmdump", default="", help="Path to mitmdump executable")
    parser.add_argument("--listen-host", default="0.0.0.0", help="Proxy listen host")
    parser.add_argument("--listen-port", type=int, default=8080, help="Proxy listen port")
    parser.add_argument("--capture-file", default=str(DEFAULT_CAPTURE_FILE), help="Raw capture JSONL path")
    parser.add_argument("--decoded-file", default=str(DEFAULT_DECODED_FILE), help="Decoded JSON output path")
    parser.add_argument("--summary-file", default=str(DEFAULT_SUMMARY_FILE), help="Summary JSON output path")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    capture_file = Path(args.capture_file).resolve()
    decoded_file = Path(args.decoded_file).resolve()
    summary_file = Path(args.summary_file).resolve()

    if args.mode in {"capture", "all"}:
        mitmdump_path = find_mitmdump(args.mitmdump)
        exit_code = run_capture(mitmdump_path, capture_file, args.listen_host, args.listen_port)
        if exit_code not in {0, -15}:
            print("Capture process exited with code {}".format(exit_code))

    if args.mode in {"decode", "all"}:
        if not capture_file.exists():
            raise FileNotFoundError("Capture file not found: {}".format(capture_file))
        decode_code = run_decode(sys.executable, capture_file, decoded_file, summary_file)
        if decode_code != 0:
            raise SystemExit(decode_code)


if __name__ == "__main__":
    main()
