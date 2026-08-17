"""Structured logging.

Two audiences, one stream:

* **Operators** need to see, per submission, which stage rejected it and how
  long each model took. That is why every decision emits one line carrying the
  whole picture rather than a scatter of prints.
* **Auditors** need the decision itself, which is already a database row
  (`audit_events`). Logs complement it and must not become a second, weaker
  copy of it — so **no image data and no embeddings are ever logged**, only
  scores, reason codes and identifiers.

Set `EKYC_LOG_FORMAT=json` for machine-readable output, or leave it as `text`
for a readable console during development.
"""

from __future__ import annotations

import json
import logging
import os
import sys
import time
from contextlib import contextmanager
from typing import Any, Iterator

LOGGER = "ekyc"

#: Anything matching these key fragments is never written to a log line.
_FORBIDDEN = ("embedding", "image", "frame_bytes", "pixels", "nonce", "token")


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        extra = getattr(record, "context", None)
        if isinstance(extra, dict):
            payload.update(redact(extra))
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False, default=str)


class TextFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        base = f"{self.formatTime(record, '%H:%M:%S')} {record.levelname:<7} {record.name:<12} {record.getMessage()}"
        extra = getattr(record, "context", None)
        if isinstance(extra, dict) and extra:
            pairs = " ".join(f"{k}={v}" for k, v in redact(extra).items())
            base = f"{base}  {pairs}"
        if record.exc_info:
            base = f"{base}\n{self.formatException(record.exc_info)}"
        return base


def redact(context: dict[str, Any]) -> dict[str, Any]:
    """Drop anything that could carry biometric or replayable material."""
    return {
        key: value
        for key, value in context.items()
        if not any(bad in key.lower() for bad in _FORBIDDEN)
    }


def configure(level: str | None = None, fmt: str | None = None) -> logging.Logger:
    level = (level or os.getenv("EKYC_LOG_LEVEL", "INFO")).upper()
    fmt = (fmt or os.getenv("EKYC_LOG_FORMAT", "text")).lower()

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter() if fmt == "json" else TextFormatter())

    logger = logging.getLogger(LOGGER)
    logger.setLevel(level)
    logger.handlers.clear()
    logger.addHandler(handler)
    logger.propagate = False

    # TensorFlow and MediaPipe are extremely chatty on import; keep the stream
    # readable without suppressing anything of ours.
    for noisy in ("tensorflow", "absl", "mediapipe", "h5py"):
        logging.getLogger(noisy).setLevel(logging.ERROR)

    return logger


def log_event(name: str, level: int = logging.INFO, **context: Any) -> None:
    logging.getLogger(LOGGER).log(level, name, extra={"context": context})


@contextmanager
def timed(name: str, **context: Any) -> Iterator[dict[str, Any]]:
    """Time a stage and log it, whether it succeeds or throws.

    The yielded dict is writable, so a caller can attach results that are only
    known once the work is done.
    """
    started = time.perf_counter()
    payload: dict[str, Any] = dict(context)
    try:
        yield payload
    except Exception:
        payload["ms"] = round((time.perf_counter() - started) * 1000, 1)
        payload["outcome"] = "error"
        logging.getLogger(LOGGER).exception(name, extra={"context": payload})
        raise
    else:
        payload["ms"] = round((time.perf_counter() - started) * 1000, 1)
        logging.getLogger(LOGGER).info(name, extra={"context": payload})
