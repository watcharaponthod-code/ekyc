from __future__ import annotations

import io
import sys
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


@pytest.fixture
def jpeg_bytes():
    """A decodable JPEG large enough to pass the frame size check."""

    def _make(width: int = 640, height: int = 640, seed: int = 0) -> bytes:
        rng = np.random.default_rng(seed)
        array = rng.integers(0, 255, (height, width, 3), dtype=np.uint8)
        buffer = io.BytesIO()
        Image.fromarray(array).save(buffer, format="JPEG", quality=90)
        return buffer.getvalue()

    return _make
