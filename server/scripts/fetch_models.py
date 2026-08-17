"""Download the ONNX models. Not committed — ~198 MB.

    py -3.12 server/scripts/fetch_models.py

Verifies SHA-256 where the upstream publishes one, and is idempotent.
"""

from __future__ import annotations

import hashlib
import io
import sys
import urllib.request
import zipfile
from pathlib import Path

MODELS_DIR = Path(__file__).resolve().parent.parent / "models"

BUFFALO_URL = "https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip"
#: Only these two of the five files in the bundle are used.
BUFFALO_WANTED = {"det_10g.onnx", "w600k_r50.onnx"}

MINIFASNET_URL = (
    "https://huggingface.co/garciafido/minifasnet-v2-anti-spoofing-onnx/resolve/main/minifasnet_v2.onnx"
)
MINIFASNET_SHA256 = "d7b3cd9ba8a7ceb13baa8c4720902e27ca3112eff52f926c08804af6b6eecc7b"


def download(url: str) -> bytes:
    print(f"  fetching {url}")
    request = urllib.request.Request(url, headers={"User-Agent": "ekyc-fetch-models/1.0"})
    with urllib.request.urlopen(request) as response:  # noqa: S310 — fixed, audited URLs
        return response.read()


def fetch_buffalo() -> None:
    missing = [name for name in BUFFALO_WANTED if not (MODELS_DIR / name).is_file()]
    if not missing:
        print("buffalo_l: already present")
        return
    print(f"buffalo_l: need {missing}")
    payload = download(BUFFALO_URL)
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        for member in archive.namelist():
            name = Path(member).name
            if name in BUFFALO_WANTED:
                (MODELS_DIR / name).write_bytes(archive.read(member))
                print(f"  wrote {name}")


def fetch_minifasnet() -> None:
    target = MODELS_DIR / "minifasnet_v2.onnx"
    if target.is_file() and sha256(target) == MINIFASNET_SHA256:
        print("minifasnet_v2: already present and verified")
        return
    payload = download(MINIFASNET_URL)
    digest = hashlib.sha256(payload).hexdigest()
    if digest != MINIFASNET_SHA256:
        raise SystemExit(f"minifasnet_v2 checksum mismatch: expected {MINIFASNET_SHA256}, got {digest}")
    target.write_bytes(payload)
    print("  wrote minifasnet_v2.onnx (sha256 verified)")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    fetch_buffalo()
    fetch_minifasnet()

    print("\nmodels in", MODELS_DIR)
    for path in sorted(MODELS_DIR.glob("*.onnx")):
        print(f"  {path.name:24s} {path.stat().st_size / 1e6:8.1f} MB")

    print(
        "\nLicence note: the buffalo_l weights (det_10g, w600k_r50) are published by\n"
        "InsightFace for research use. Resolve licensing before commercial deployment.\n"
        "minifasnet_v2 is Apache-2.0."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
