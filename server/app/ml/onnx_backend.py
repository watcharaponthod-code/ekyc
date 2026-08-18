"""ONNX implementation of `FaceBackend`.

Three models, all CPU, all loaded once at startup:

* ``det_10g.onnx``   — SCRFD-10GF detection + 5 landmarks
* ``w600k_r50.onnx`` — ArcFace R50, 512-d embedding
* ``minifasnet_v2.onnx`` — presentation-attack detection

Preprocessing constants are copied from the reference implementations
(``insightface/model_zoo/{scrfd,arcface_onnx}.py`` and the MiniFASNet model
card). They are not adjustable knobs — getting one wrong silently degrades
accuracy rather than raising, so they are documented at each use.
"""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort

from .align import ARCFACE_DST, ARCFACE_SIZE, norm_crop
from .backend import DetectedFace
from .geometry import minifasnet_crop, yaw_degrees

# --- SCRFD ------------------------------------------------------------------
_SCRFD_INPUT = 640
_SCRFD_STRIDES = (8, 16, 32)
_SCRFD_ANCHORS = 2
_SCRFD_MEAN = 127.5
_SCRFD_STD = 128.0
_NMS_IOU = 0.4

# --- ArcFace ----------------------------------------------------------------
_ARCFACE_MEAN = 127.5
_ARCFACE_STD = 127.5

# --- MiniFASNet -------------------------------------------------------------
# These four values were established by measurement, not by reading the model
# card — the card's stated preprocessing (`pixel/255`, live = class 0) makes the
# network emit a near-constant vector and produces AUC 0.68. See
# docs/pad-validation.md for the sweep.
_PAD_INPUT = 80
#: Matches the ``2.7_80x80`` weight filename. Must be applied with
#: `minifasnet_crop`, which clamps the scale to stay inside the image.
_PAD_CROP_SCALE = 2.7
#: Raw 0..255 float. Dividing by 255 saturates the network.
_PAD_INPUT_DIVISOR = 1.0
#: Softmax index for "real face", per minivision's own inference code.
_PAD_LIVE_CLASS = 1

# --- eye window -------------------------------------------------------------
#: Half-size of the measurement window around each canonical eye centre, in
#: pixels of the 112x112 aligned crop. Kept clear of the eyebrow (y~40) and the
#: nose bridge.
_EYE_HALF_W = 11
_EYE_HALF_H = 8


def _session(path: Path) -> ort.InferenceSession:
    options = ort.SessionOptions()
    options.log_severity_level = 3
    return ort.InferenceSession(str(path), options, providers=["CPUExecutionProvider"])


class OnnxFaceBackend:
    name = "onnx"
    #: Five points cannot measure mouth opening or smile.
    supports_expressions = False

    def __init__(self, models_dir: Path) -> None:
        self.models_dir = models_dir
        self._det = self._maybe_load("det_10g.onnx")
        self._rec = self._maybe_load("w600k_r50.onnx")
        self._pad = self._maybe_load("minifasnet_v2.onnx")

        if self._det is None or self._rec is None:
            missing = [n for n, s in (("det_10g.onnx", self._det), ("w600k_r50.onnx", self._rec)) if s is None]
            raise FileNotFoundError(
                f"missing required model(s) {missing} in {models_dir}; run scripts/fetch_models.py"
            )

    def _maybe_load(self, filename: str) -> ort.InferenceSession | None:
        path = self.models_dir / filename
        return _session(path) if path.is_file() else None

    def loaded_models(self) -> dict[str, bool]:
        return {
            "detector": self._det is not None,
            "embedder": self._rec is not None,
            "pad": self._pad is not None,
        }

    # -- detection ----------------------------------------------------------

    def detect(self, image_bgr: np.ndarray, threshold: float = 0.5) -> list[DetectedFace]:
        assert self._det is not None
        height, width = image_bgr.shape[:2]
        image_ratio = height / float(width)

        if image_ratio > 1.0:
            new_h, new_w = _SCRFD_INPUT, int(_SCRFD_INPUT / image_ratio)
        else:
            new_w, new_h = _SCRFD_INPUT, int(_SCRFD_INPUT * image_ratio)
        det_scale = new_h / float(height)

        resized = cv2.resize(image_bgr, (new_w, new_h))
        canvas = np.zeros((_SCRFD_INPUT, _SCRFD_INPUT, 3), dtype=np.uint8)
        canvas[:new_h, :new_w, :] = resized

        blob = cv2.dnn.blobFromImage(
            canvas, 1.0 / _SCRFD_STD, (_SCRFD_INPUT, _SCRFD_INPUT),
            (_SCRFD_MEAN, _SCRFD_MEAN, _SCRFD_MEAN), swapRB=True,
        )
        outputs = self._det.run(None, {self._det.get_inputs()[0].name: blob})

        scores_all: list[np.ndarray] = []
        boxes_all: list[np.ndarray] = []
        kps_all: list[np.ndarray] = []
        feature_count = len(_SCRFD_STRIDES)

        for index, stride in enumerate(_SCRFD_STRIDES):
            scores = outputs[index].reshape(-1)
            bbox_preds = outputs[index + feature_count].reshape(-1, 4) * stride
            kps_preds = outputs[index + feature_count * 2].reshape(-1, 10) * stride

            side = _SCRFD_INPUT // stride
            centers = np.stack(np.mgrid[:side, :side][::-1], axis=-1).astype(np.float32)
            centers = (centers * stride).reshape(-1, 2)
            centers = np.stack([centers] * _SCRFD_ANCHORS, axis=1).reshape(-1, 2)

            keep = np.where(scores >= threshold)[0]
            if keep.size == 0:
                continue
            scores_all.append(scores[keep])
            boxes_all.append(_distance2bbox(centers[keep], bbox_preds[keep]))
            kps_all.append(_distance2kps(centers[keep], kps_preds[keep]))

        if not scores_all:
            return []

        scores = np.concatenate(scores_all)
        boxes = np.concatenate(boxes_all) / det_scale
        kps = np.concatenate(kps_all) / det_scale

        keep = _nms(boxes, scores, _NMS_IOU)
        return [
            DetectedFace(bbox=boxes[i], kps=kps[i].reshape(5, 2), score=float(scores[i]))
            for i in keep
        ]

    # -- recognition --------------------------------------------------------

    def embed(self, image_bgr: np.ndarray, kps: np.ndarray) -> np.ndarray:
        assert self._rec is not None
        aligned = norm_crop(image_bgr, kps, ARCFACE_SIZE)
        blob = cv2.dnn.blobFromImage(
            aligned, 1.0 / _ARCFACE_STD, (ARCFACE_SIZE, ARCFACE_SIZE),
            (_ARCFACE_MEAN, _ARCFACE_MEAN, _ARCFACE_MEAN), swapRB=True,
        )
        vector = self._rec.run(None, {self._rec.get_inputs()[0].name: blob})[0][0]
        norm = float(np.linalg.norm(vector))
        return (vector / norm).astype(np.float32) if norm > 0 else vector.astype(np.float32)

    # -- presentation attack detection --------------------------------------

    def pad_score(self, image_bgr: np.ndarray, bbox: np.ndarray) -> float:
        """Probability the face is a live human rather than a print or a screen.

        Returns 1.0 when the model is absent so an unconfigured deployment fails
        *open* on this signal alone — the health endpoint reports the model as
        missing, and `EKYC_PAD_MIN` can be raised to force a hard dependency.
        """
        if self._pad is None:
            return 1.0
        patch = minifasnet_crop(image_bgr, bbox, _PAD_CROP_SCALE, _PAD_INPUT)
        if patch is None:
            return 0.0
        # BGR as-is, raw 0..255, NCHW. No mean subtraction, no channel swap.
        tensor = (patch.astype(np.float32) / _PAD_INPUT_DIVISOR).transpose(2, 0, 1)[None, ...]
        logits = self._pad.run(None, {self._pad.get_inputs()[0].name: tensor})[0][0]
        return float(_softmax(logits)[_PAD_LIVE_CLASS])

    # -- pose ---------------------------------------------------------------

    def pose(self, image_bgr: np.ndarray, kps: np.ndarray) -> tuple[float, float, float]:
        """Yaw in degrees from the five landmarks; pitch and roll are not
        estimated here, and no rule depends on them for this backend."""
        eyes = kps[:2]
        order = np.argsort(eyes[:, 0])
        axis = eyes[order[1]] - eyes[order[0]]
        roll = float(np.degrees(np.arctan2(float(axis[1]), float(axis[0]))))
        return yaw_degrees(kps), 0.0, roll

    # -- eyes ---------------------------------------------------------------

    def eye_openness(self, image_bgr: np.ndarray, bbox: np.ndarray, kps: np.ndarray) -> float:
        """How dark the eye windows are relative to the rest of the face.

        Measured on the ArcFace-aligned crop, where both eyes always land on the
        same pixels — so no landmark-index guessing is involved.

        An open eye shows pupil and iris, far darker than skin. A closed lid is
        skin. Normalising by the face's own median luma cancels lighting, skin
        tone and exposure, and the decision then compares the value against the
        *same person's* neutral frame rather than any absolute constant.

        Chosen over a contrast/variance measure because it separated better in
        testing; see docs/ml-validation.md. Note the honest caveat recorded
        there: the separation was measured on simulated lid occlusion, not on
        matched open/closed photographs of the same face, which is why the rule
        that consumes this is advisory by default.
        """
        aligned = norm_crop(image_bgr, kps, ARCFACE_SIZE)
        gray = cv2.cvtColor(aligned, cv2.COLOR_BGR2GRAY).astype(np.float32)

        face_median = float(np.median(gray))
        if face_median <= 1e-6:
            return 0.0

        values = []
        for cx, cy in ARCFACE_DST[:2]:
            x1 = max(0, int(round(cx - _EYE_HALF_W)))
            x2 = min(ARCFACE_SIZE, int(round(cx + _EYE_HALF_W)))
            y1 = max(0, int(round(cy - _EYE_HALF_H)))
            y2 = min(ARCFACE_SIZE, int(round(cy + _EYE_HALF_H)))
            window = gray[y1:y2, x1:x2]
            if window.size:
                darkest = float(np.percentile(window, 5))
                values.append(max(0.0, 1.0 - darkest / face_median))

        return float(np.mean(values)) if values else 0.0


# ---------------------------------------------------------------------------


def _distance2bbox(points: np.ndarray, distance: np.ndarray) -> np.ndarray:
    x1 = points[:, 0] - distance[:, 0]
    y1 = points[:, 1] - distance[:, 1]
    x2 = points[:, 0] + distance[:, 2]
    y2 = points[:, 1] + distance[:, 3]
    return np.stack([x1, y1, x2, y2], axis=-1)


def _distance2kps(points: np.ndarray, distance: np.ndarray) -> np.ndarray:
    coords = []
    for i in range(0, distance.shape[1], 2):
        coords.append(points[:, 0] + distance[:, i])
        coords.append(points[:, 1] + distance[:, i + 1])
    return np.stack(coords, axis=-1)


def _nms(boxes: np.ndarray, scores: np.ndarray, iou_threshold: float) -> list[int]:
    x1, y1, x2, y2 = boxes[:, 0], boxes[:, 1], boxes[:, 2], boxes[:, 3]
    areas = (x2 - x1 + 1) * (y2 - y1 + 1)
    order = scores.argsort()[::-1]

    keep: list[int] = []
    while order.size > 0:
        i = int(order[0])
        keep.append(i)
        xx1 = np.maximum(x1[i], x1[order[1:]])
        yy1 = np.maximum(y1[i], y1[order[1:]])
        xx2 = np.minimum(x2[i], x2[order[1:]])
        yy2 = np.minimum(y2[i], y2[order[1:]])
        inter = np.maximum(0.0, xx2 - xx1 + 1) * np.maximum(0.0, yy2 - yy1 + 1)
        iou = inter / (areas[i] + areas[order[1:]] - inter)
        order = order[np.where(iou <= iou_threshold)[0] + 1]
    return keep


def _softmax(values: np.ndarray) -> np.ndarray:
    shifted = values - values.max()
    exponentials = np.exp(shifted)
    return exponentials / exponentials.sum()
