"""Geometry and image-quality measures.

These are deliberately convention-free: nothing here asserts which way is
"left". Front cameras mirror, EXIF rotates, and detectors disagree on sign, so
the pipeline proves that the head turned *both ways* instead of naming a
direction.
"""

from __future__ import annotations

import math

import cv2
import numpy as np

#: Face crops are normalised to this before measuring sharpness, so the
#: threshold does not move when the camera resolution does.
_QUALITY_CROP = 160


def yaw_proxy(kps: np.ndarray) -> float:
    """Where the nose sits along the eye-to-eye axis, remapped to -1..1.

    0 means the nose is exactly between the eyes (frontal). Turning the head
    slides the projected nose toward one eye. Robust, cheap, and needs no 3-D
    model or camera intrinsics.
    """
    eyes = kps[:2]
    order = np.argsort(eyes[:, 0])
    eye_a = eyes[order[0]].astype(np.float64)
    eye_b = eyes[order[1]].astype(np.float64)
    nose = kps[2].astype(np.float64)

    axis = eye_b - eye_a
    denom = float(axis @ axis)
    if denom <= 1e-6:
        return 0.0
    t = float((nose - eye_a) @ axis) / denom
    return float(np.clip(2.0 * t - 1.0, -1.5, 1.5))


def yaw_degrees(kps: np.ndarray) -> float:
    """`yaw_proxy` converted to degrees.

    Under a simple head model — a ~20 mm nose projection over a ~63 mm
    interocular distance — the proxy relates to the rotation angle by
    `proxy ~= 0.635 * tan(theta)`. Reporting degrees lets both backends share
    one set of thresholds, even though MediaPipe measures pose properly from a
    transformation matrix and this one infers it from five points.
    """
    return math.degrees(math.atan(yaw_proxy(kps) / 0.635))


def crop_bbox(image: np.ndarray, bbox: np.ndarray, margin: float = 0.0) -> np.ndarray:
    """Crop with an optional relative margin, clamped to the image."""
    h, w = image.shape[:2]
    x1, y1, x2, y2 = (float(v) for v in bbox)
    bw, bh = x2 - x1, y2 - y1
    x1 -= bw * margin
    x2 += bw * margin
    y1 -= bh * margin
    y2 += bh * margin
    xi1 = max(0, int(round(x1)))
    yi1 = max(0, int(round(y1)))
    xi2 = min(w, int(round(x2)))
    yi2 = min(h, int(round(y2)))
    if xi2 <= xi1 or yi2 <= yi1:
        return image
    return image[yi1:yi2, xi1:xi2]


def minifasnet_crop(image_bgr: np.ndarray, bbox: np.ndarray, scale: float, out: int) -> np.ndarray | None:
    """Crop the way the MiniFASNet weights were trained.

    Faithful port of ``CropImage.crop`` from minivision-ai/Silent-Face-Anti-Spoofing.
    Three details matter and all three were wrong in a naive implementation,
    which is how a broken detector can look like a working one:

    * the requested scale is **clamped** so the crop never leaves the image —
      padding a replicated border makes every face look like a screen edge;
    * the crop keeps the bbox aspect ratio rather than being squared off;
    * when clamped at an edge the window is *shifted* back inside, not cut.

    Returns ``None`` when the box is degenerate.
    """
    src_h, src_w = image_bgr.shape[:2]
    x1, y1, x2, y2 = (float(v) for v in bbox)
    box_w, box_h = x2 - x1, y2 - y1
    if box_w <= 1 or box_h <= 1:
        return None

    scale = min((src_h - 1) / box_h, (src_w - 1) / box_w, scale)
    new_w, new_h = box_w * scale, box_h * scale
    cx, cy = x1 + box_w / 2, y1 + box_h / 2

    left = cx - new_w / 2
    top = cy - new_h / 2
    right = cx + new_w / 2 - 1
    bottom = cy + new_h / 2 - 1

    if left < 0:
        right -= left
        left = 0
    if top < 0:
        bottom -= top
        top = 0
    if right > src_w - 1:
        left -= right - src_w + 1
        right = src_w - 1
    if bottom > src_h - 1:
        top -= bottom - src_h + 1
        bottom = src_h - 1

    patch = image_bgr[int(top) : int(bottom) + 1, int(left) : int(right) + 1]
    if patch.size == 0:
        return None
    return cv2.resize(patch, (out, out))


def sharpness(image_bgr: np.ndarray, bbox: np.ndarray) -> float:
    """Variance of the Laplacian over the face, at a fixed crop size.

    Measured on the face rather than the frame: a crisp background behind a
    motion-blurred face must not pass.
    """
    face = crop_bbox(image_bgr, bbox)
    if face.size == 0:
        return 0.0
    resized = cv2.resize(face, (_QUALITY_CROP, _QUALITY_CROP), interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(resized, cv2.COLOR_BGR2GRAY)
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def brightness(image_bgr: np.ndarray, bbox: np.ndarray) -> float:
    """Mean luma over the face, 0..1."""
    face = crop_bbox(image_bgr, bbox)
    if face.size == 0:
        return 0.0
    gray = cv2.cvtColor(face, cv2.COLOR_BGR2GRAY)
    return float(gray.mean()) / 255.0


def face_ratio(image_bgr: np.ndarray, bbox: np.ndarray) -> float:
    width = image_bgr.shape[1]
    if width == 0:
        return 0.0
    return float(bbox[2] - bbox[0]) / float(width)


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    """Cosine similarity. Inputs are expected L2-normalised; we normalise anyway."""
    na = float(np.linalg.norm(a))
    nb = float(np.linalg.norm(b))
    if na <= 1e-9 or nb <= 1e-9:
        return 0.0
    return float(np.dot(a, b) / (na * nb))
