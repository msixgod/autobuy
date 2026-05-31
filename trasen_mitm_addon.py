"""
Mitmproxy addon for capturing Trasen API traffic without page OCR.

Usage example:
    mitmdump -s trasen_mitm_addon.py --set save_stream_file=trasen_capture.jsonl

This addon only records raw request/response data.
Decryption and semantic extraction are handled offline by
`trasen_capture_decode.py`, which avoids extra Python package
requirements inside mitmproxy itself.
"""

import base64
import json
import time
from pathlib import Path
from typing import Any, Dict

from mitmproxy import ctx
from mitmproxy import http


class TrasenCaptureAddon:
    def __init__(self) -> None:
        self.output_path = Path("trasen_capture.jsonl")

    def load(self, loader) -> None:
        loader.add_option(
            name="save_stream_file",
            typespec=str,
            default="trasen_capture.jsonl",
            help="Path to the JSONL capture output file",
        )

    def configure(self, updates) -> None:
        self.output_path = Path(ctx.options.save_stream_file)
        self.output_path.parent.mkdir(parents=True, exist_ok=True)

    def response(self, flow: http.HTTPFlow) -> None:
        request = flow.request
        if request.host != "wis2.trasen.womei.org":
            return
        if not request.path.startswith("/api/"):
            return

        entry = {
            "captured_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "method": request.method,
            "scheme": request.scheme,
            "host": request.host,
            "port": request.port,
            "path": request.path,
            "url": request.pretty_url,
            "request_headers": dict(request.headers),
            "request_text_b64": base64.b64encode(request.raw_content or b"").decode("ascii"),
            "response_status_code": flow.response.status_code if flow.response else None,
            "response_headers": dict(flow.response.headers) if flow.response else {},
            "response_text_b64": base64.b64encode(flow.response.raw_content or b"").decode("ascii")
            if flow.response
            else "",
        }
        self._append(entry)

    def _append(self, payload: Dict[str, Any]) -> None:
        with self.output_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(payload, ensure_ascii=True) + "\n")


addons = [TrasenCaptureAddon()]
