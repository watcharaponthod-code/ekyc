"""MediaPipe Face Landmarker: geometry, pose and eye openness.

Face Mesh gives 478 landmarks plus blendshapes plus a 4x4 facial transformation
matrix. Three things follow that the previous 5-point pipeline could not do:

* **Real head pose in degrees**, decomposed from the transformation matrix,
  instead of a nose-position proxy that carried a per-person bias.
* **A textbook eye-aspect-ratio** from documented eye-contour indices, instead
  of an image-statistics stand-in that could only ever be advisory.
* **Blendshapes** — `eyeBlinkLeft/Right`, `mouthSmile*` — as a second,
  independent read on the same events.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

# --- canonical Face Mesh indices -------------------------------------------
# Stable across MediaPipe releases and documented in the Face Mesh topology.

#: Eye-aspect-ratio points, in the order (outer, upper1, upper2, inner, lower2, lower1).
RIGHT_EYE_EAR = (33, 160, 158, 133, 153, 144)
LEFT_EYE_EAR = (362, 385, 387, 263, 373, 380)

#: Five points matching the ArcFace template order.
RIGHT_EYE_OUTER, RIGHT_EYE_INNER = 33, 133
LEFT_EYE_OUTER, LEFT_EYE_INNER = 263, 362
NOSE_TIP = 1
MOUTH_RIGHT, MOUTH_LEFT = 61, 291


@dataclass(slots=True)
class FaceGeometry:
    """Everything the pipeline reads off one detected face."""

    #: x1, y1, x2, y2 in pixels, from the landmark hull.
    bbox: np.ndarray
    #: 5 points in ArcFace order, in pixels.
    kps: np.ndarray
    #: All 478 landmarks in pixels.
    landmarks: np.ndarray
    #: Degrees. Positive/negative direction is not asserted anywhere downstream.
    yaw: float
    pitch: float
    roll: float
    #: Mean eye-aspect-ratio. ~0.3 open, ~0.1 closed.
    ear: float
    #: Blendshape reads, 0..1, empty when blendshapes are disabled.
    blendshapes: dict[str, float]
    score: float

    @property
    def width(self) -> float:
        return float(self.bbox[2] - self.bbox[0])


def landmarks_to_pixels(landmarks, width: int, height: int) -> np.ndarray:
    """Normalised Face Mesh landmarks -> pixel coordinates."""
    return np.array([[lm.x * width, lm.y * height] for lm in landmarks], dtype=np.float32)


def bbox_from_landmarks(points: np.ndarray) -> np.ndarray:
    return np.array(
        [points[:, 0].min(), points[:, 1].min(), points[:, 0].max(), points[:, 1].max()],
        dtype=np.float32,
    )


def five_points(points: np.ndarray) -> np.ndarray:
    """The ArcFace 5-point template, derived from the mesh.

    Eye centres are the midpoint of the eye's inner and outer corners, which is
    steadier than any single landmark.
    """
    right_eye = (points[RIGHT_EYE_OUTER] + points[RIGHT_EYE_INNER]) / 2.0
    left_eye = (points[LEFT_EYE_OUTER] + points[LEFT_EYE_INNER]) / 2.0
    return np.array(
        [right_eye, left_eye, points[NOSE_TIP], points[MOUTH_RIGHT], points[MOUTH_LEFT]],
        dtype=np.float32,
    )


def eye_aspect_ratio(points: np.ndarray) -> float:
    """Mean EAR over both eyes.

    EAR = (|p2-p6| + |p3-p5|) / (2 * |p1-p4|) — vertical opening over eye width.
    Scale-free by construction, so it needs no normalisation by face size or
    camera distance.
    """
    values = []
    for indices in (RIGHT_EYE_EAR, LEFT_EYE_EAR):
        p1, p2, p3, p4, p5, p6 = (points[i] for i in indices)
        horizontal = float(np.linalg.norm(p1 - p4))
        if horizontal <= 1e-6:
            continue
        vertical = float(np.linalg.norm(p2 - p6)) + float(np.linalg.norm(p3 - p5))
        values.append(vertical / (2.0 * horizontal))
    return float(np.mean(values)) if values else 0.0


def pose_from_matrix(matrix: np.ndarray) -> tuple[float, float, float]:
    """Yaw, pitch and roll in degrees from a 4x4 facial transformation matrix.

    Standard ZYX decomposition of the rotation block, with the gimbal-lock case
    handled rather than left to produce NaNs.
    """
    rotation = np.asarray(matrix, dtype=np.float64)[:3, :3]
    sy = math.hypot(rotation[0, 0], rotation[1, 0])
    if sy > 1e-6:
        pitch = math.atan2(rotation[2, 1], rotation[2, 2])
        yaw = math.atan2(-rotation[2, 0], sy)
        roll = math.atan2(rotation[1, 0], rotation[0, 0])
    else:
        pitch = math.atan2(-rotation[1, 2], rotation[1, 1])
        yaw = math.atan2(-rotation[2, 0], sy)
        roll = 0.0
    return math.degrees(yaw), math.degrees(pitch), math.degrees(roll)


def pose_from_landmarks(points: np.ndarray) -> tuple[float, float, float]:
    """Fallback pose when no transformation matrix is available.

    Same nose-projection idea as the ONNX pipeline, converted to degrees so the
    two backends report in the same units. Less accurate than the matrix — it
    carries a per-person bias — which is why the decision layer measures turns
    as a change from the subject's own neutral frame either way.
    """
    right_eye = (points[RIGHT_EYE_OUTER] + points[RIGHT_EYE_INNER]) / 2.0
    left_eye = (points[LEFT_EYE_OUTER] + points[LEFT_EYE_INNER]) / 2.0
    nose = points[NOSE_TIP]

    axis = left_eye - right_eye
    denominator = float(axis @ axis)
    if denominator <= 1e-6:
        return 0.0, 0.0, 0.0
    t = float((nose - right_eye) @ axis) / denominator
    yaw = math.degrees(math.atan((2.0 * t - 1.0) / 0.635))

    eye_mid = (right_eye + left_eye) / 2.0
    mouth_mid = (points[MOUTH_RIGHT] + points[MOUTH_LEFT]) / 2.0
    span = float(np.linalg.norm(mouth_mid - eye_mid))
    pitch = 0.0
    if span > 1e-6:
        pitch = math.degrees(math.atan((nose[1] - eye_mid[1]) / span - 0.5))

    roll = math.degrees(math.atan2(float(axis[1]), float(axis[0])))
    return yaw, pitch, roll
