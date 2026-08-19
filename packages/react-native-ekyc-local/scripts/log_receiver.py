"""Receive session logs from the phone over Wi-Fi and summarise them live.

    python packages/react-native-ekyc-local/scripts/log_receiver.py [--port 8765] [--out received/ekyc-local-sessions.jsonl]

Prints the LAN addresses to type into the app ("ที่อยู่คอม" on the home
screen, e.g. `http://192.168.1.20:8765`). Every POST /ingest appends the
sessions it does not already have (deduplicated on `at`) and re-runs the
calibration summary, so the terminal shows the tuning picture update after
each scan. GET / answers with a count, which the app uses to test the link.

Only numbers ever travel: no images, no embeddings. Plain HTTP on the LAN is
fine for that; do not expose the port beyond the local network. Windows may
ask once to allow Python through the firewall — allow it on private networks.
"""

from __future__ import annotations

import argparse
import io
import json
import socket
import sys
from contextlib import redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import local_calibrate  # noqa: E402


def lan_addresses() -> list[str]:
    seen: list[str] = []
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith("127.") and ip not in seen:
                seen.append(ip)
    except socket.gaierror:
        pass
    # the address the default route uses, which is usually the Wi-Fi one
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        if ip not in seen:
            seen.insert(0, ip)
    except OSError:
        pass
    return seen


class Store:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.keys: set[str] = set()
        if self.path.exists():
            for line in self.path.read_text(encoding="utf-8").splitlines():
                try:
                    self.keys.add(json.loads(line).get("at", line))
                except json.JSONDecodeError:
                    continue

    def ingest(self, body: str) -> tuple[int, int]:
        added = 0
        total = 0
        with self.path.open("a", encoding="utf-8") as f:
            for line in body.splitlines():
                line = line.strip()
                if not line:
                    continue
                total += 1
                try:
                    key = json.loads(line).get("at", line)
                except json.JSONDecodeError:
                    continue
                if key in self.keys:
                    continue
                self.keys.add(key)
                f.write(line + "\n")
                added += 1
        return added, total

    def summary(self) -> str:
        buf = io.StringIO()
        with redirect_stdout(buf):
            try:
                local_calibrate.main([str(self.path)])
            except SystemExit:
                pass
        return buf.getvalue()


def make_handler(store: Store):
    class Handler(BaseHTTPRequestHandler):
        def _send(self, code: int, payload: dict) -> None:
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self) -> None:  # noqa: N802
            self._send(200, {"ok": True, "sessions": len(store.keys), "file": str(store.path)})

        def do_POST(self) -> None:  # noqa: N802
            if self.path.rstrip("/") not in ("/ingest", ""):
                self._send(404, {"ok": False, "error": "use POST /ingest"})
                return
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length).decode("utf-8", errors="replace")
            added, total = store.ingest(body)
            self._send(200, {"ok": True, "received": total, "added": added, "sessions": len(store.keys)})
            print(f"\n=== received {total} lines from {self.client_address[0]}, {added} new, {len(store.keys)} total ===")
            print(store.summary())

        def log_message(self, fmt: str, *args) -> None:  # quiet the default access log
            return

    return Handler


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--out", default=str(HERE.parent.parent.parent / "received" / "ekyc-local-sessions.jsonl"))
    args = parser.parse_args(argv)
    try:
        sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        pass
    store = Store(Path(args.out))
    server = ThreadingHTTPServer(("0.0.0.0", args.port), make_handler(store))
    print(f"eKYC Local log receiver — writing to {store.path} ({len(store.keys)} sessions so far)")
    print("Type one of these into the app's 'ที่อยู่คอม (LAN)' field:")
    for ip in lan_addresses():
        print(f"  http://{ip}:{args.port}")
    print("Waiting for POST /ingest … (Ctrl+C to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
