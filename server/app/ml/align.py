"""ArcFace face alignment.

The five detected landmarks are mapped onto a fixed canonical template with a
similarity transform (Umeyama). Two consequences matter downstream:

1. The embedder sees faces in the pose distribution it was trained on.
2. Anatomy lands at *fixed pixel coordinates* in every aligned crop — which is
   what lets the eye-openness measure use a hard-coded window instead of
   guessing landmark indices.
"""

from __future__ import annotations

import cv2
import numpy as np

#: Canonical 5-point template for a 112x112 ArcFace crop.
ARCFACE_DST = np.array(
    [
        [38.2946, 51.6963],  # eye
        [73.5318, 51.5014],  # eye
        [56.0252, 71.7366],  # nose
        [41.5493, 92.3655],  # mouth corner
        [70.7299, 92.2041],  # mouth corner
    ],
    dtype=np.float32,
)

ARCFACE_SIZE = 112


def umeyama(src: np.ndarray, dst: np.ndarray) -> np.ndarray:
    """Least-squares similarity transform between two point sets.

    Same algorithm scikit-image uses (Umeyama 1991), reimplemented here so the
    server does not need scikit-image for fifteen lines of linear algebra.
    """
    src = np.asarray(src, dtype=np.float64)
    dst = np.asarray(dst, dtype=np.float64)
    num, dim = src.shape

    src_mean = src.mean(axis=0)
    dst_mean = dst.mean(axis=0)
    src_demean = src - src_mean
    dst_demean = dst - dst_mean

    covariance = dst_demean.T @ src_demean / num
    d = np.ones((dim,), dtype=np.float64)
    if np.linalg.det(covariance) < 0:
        d[dim - 1] = -1

    transform = np.eye(dim + 1, dtype=np.float64)
    u, s, vt = np.linalg.svd(covariance)
    rank = np.linalg.matrix_rank(covariance)

    if rank == 0:
        return np.full((dim + 1, dim + 1), np.nan)
    if rank == dim - 1:
        if np.linalg.det(u) * np.linalg.det(vt) > 0:
            transform[:dim, :dim] = u @ vt
        else:
            saved = d[dim - 1]
            d[dim - 1] = -1
            transform[:dim, :dim] = u @ np.diag(d) @ vt
            d[dim - 1] = saved
    else:
        transform[:dim, :dim] = u @ np.diag(d) @ vt

    variance = src_demean.var(axis=0).sum()
    scale = 1.0 if variance <= 1e-12 else float(s @ d) / variance
    transform[:dim, dim] = dst_mean - scale * (transform[:dim, :dim] @ src_mean.T)
    transform[:dim, :dim] *= scale
    return transform


def estimate_norm(kps: np.ndarray, image_size: int = ARCFACE_SIZE) -> np.ndarray:
    """2x3 affine matrix mapping the detected landmarks onto the template."""
    if kps.shape != (5, 2):
        raise ValueError(f"expected 5 landmarks, got {kps.shape}")
    ratio = image_size / float(ARCFACE_SIZE)
    dst = ARCFACE_DST * ratio
    return umeyama(kps.astype(np.float32), dst)[0:2, :].astype(np.float32)


def norm_crop(image_bgr: np.ndarray, kps: np.ndarray, image_size: int = ARCFACE_SIZE) -> np.ndarray:
    """Aligned square face crop."""
    matrix = estimate_norm(kps, image_size)
    return cv2.warpAffine(image_bgr, matrix, (image_size, image_size), borderValue=0.0)
