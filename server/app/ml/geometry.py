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


def mean_face_color(image_bgr: np.ndarray, bbox: np.ndarray) -> tuple[float, float, float]:
    """Mean colour of the face region as linear-ish RGB, 0..1.

    Used by active-flash liveness: under a coloured screen flash a real face's
    mean colour shifts toward the flash, a flat photo's does not. RGB order
    (the pipeline is BGR internally) so it lines up with the commanded flash
    colours in `flash.py`.
    """
    face = crop_bbox(image_bgr, bbox)
    if face.size == 0:
        return (0.0, 0.0, 0.0)
    b, g, r = (float(face[:, :, c].mean()) / 255.0 for c in range(3))
    return (r, g, b)


#: Face Mesh indices outlining three skin patches that carry the strongest
#: pulse signal and the least motion: forehead, left cheek, right cheek.
#: (Eyes, brows, lips and nostrils are excluded on purpose — they move,
#: blink and are not uniformly perfused.)
SKIN_PATCHES: tuple[tuple[int, ...], ...] = (
    # forehead: brow line up to the hairline
    (10, 109, 67, 103, 54, 21, 71, 63, 105, 66, 107, 9, 336, 296, 334, 293, 301, 251, 284, 332, 297, 338),
    # right cheek (image left in an unmirrored frame)
    (117, 118, 101, 36, 206, 216, 212, 214, 192, 213, 147, 123),
    # left cheek
    (346, 347, 330, 266, 426, 436, 432, 434, 416, 433, 376, 352),
)



def skin_patch_colors(
    image_bgr: np.ndarray, landmarks: np.ndarray | None, bbox: np.ndarray
) -> list[tuple[float, float, float]]:
    """Mean RGB (0..1) of each skin patch — the rPPG signal for one frame.

    With landmarks, the forehead and both cheeks are rasterised as polygons and
    each averaged separately, so the pulse detector can demand that the same
    beat shows in all of them. Without landmarks a single patch — the central
    50 % of the face box (mostly nose and cheeks) — is returned; it still
    carries the pulse, just with more noise and no cross-patch check.
    """
    h, w = image_bgr.shape[:2]
    if landmarks is not None and len(landmarks) >= 468:
        colors: list[tuple[float, float, float]] = []
        for patch in SKIN_PATCHES:
            mask = np.zeros((h, w), dtype=np.uint8)
            poly = np.round(landmarks[list(patch)][:, :2]).astype(np.int32)
            cv2.fillPoly(mask, [poly], 255)
            pixels = image_bgr[mask > 0]
            if pixels.shape[0] < 50:
                continue
            b, g, r = (float(pixels[:, c].mean()) / 255.0 for c in range(3))
            colors.append((r, g, b))
        if colors:
            return colors
    x1, y1, x2, y2 = (float(v) for v in bbox)
    bw, bh = x2 - x1, y2 - y1
    inner = np.array([x1 + bw * 0.25, y1 + bh * 0.25, x2 - bw * 0.25, y2 - bh * 0.25])
    return [mean_face_color(image_bgr, inner)]


def face_ratio(image_bgr: np.ndarray, bbox: np.ndarray) -> float:
    width = image_bgr.shape[1]
    if width == 0:
        return 0.0
    return float(bbox[2] - bbox[0]) / float(width)


def planarity_score(points: np.ndarray) -> float:
    """How non-planar a 3-D point set is: 0 = perfectly flat, larger = more depth.

    PCA on the centred points; returns the fraction of variance along the
    least-significant axis (the best-fit plane's normal),
    lambda_min / (lambda1+lambda2+lambda3). Rotation-invariant, so a tilted
    plane still scores ~0. A photo held to the camera is nearly coplanar; a real
    face's nose and brow give it a small but non-zero fraction.

    Honest caveat: MediaPipe *infers* the z coordinate from a single RGB image
    against a 3-D face prior, so a photo of a face still gets face-shaped z. This
    is a weak flat-input cue, not a mask detector — hence advisory by default.
    Returns -1.0 for a degenerate input (used as a "not measured" sentinel).
    """
    pts = np.asarray(points, dtype=np.float64)
    if pts.ndim != 2 or pts.shape[1] != 3 or pts.shape[0] < 4:
        return -1.0
    centred = pts - pts.mean(axis=0)
    eigvals = np.linalg.eigvalsh(centred.T @ centred)  # ascending, non-negative
    total = float(eigvals.sum())
    if total <= 1e-12:
        return 0.0
    return float(eigvals[0] / total)


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    """Cosine similarity. Inputs are expected L2-normalised; we normalise anyway."""
    na = float(np.linalg.norm(a))
    nb = float(np.linalg.norm(b))
    if na <= 1e-9 or nb <= 1e-9:
        return 0.0
    return float(np.dot(a, b) / (na * nb))
