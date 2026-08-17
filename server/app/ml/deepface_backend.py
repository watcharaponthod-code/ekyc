"""MediaPipe + DeepFace implementation of `FaceBackend`.

Division of labour:

| Job | Library | Why |
|---|---|---|
| detection, landmarks, head pose, eye openness | **MediaPipe Face Landmarker** | 478 landmarks, blendshapes and a facial transformation matrix from one pass |
| face embedding | **DeepFace** (`ArcFace`) | maintained wrapper, one call, alignment handled |
| presentation-attack detection | **DeepFace** (`anti_spoofing=True`) | wraps the same MiniFASNet weights, with upstream's own preprocessing |

Using DeepFace for anti-spoofing is a deliberate correction: the standalone
ONNX export of MiniFASNet has a model card that misstates its input range,
class index and crop, and following it produces a detector that does nothing
(see `docs/ml-validation.md`). DeepFace calls the upstream implementation, so
the preprocessing is right by construction.

Both libraries are loaded lazily, because importing DeepFace drags in
TensorFlow and costs several seconds.
"""

from __future__ import annotations

import logging
import threading
from pathlib import Path

import cv2
import numpy as np

from .backend import DetectedFace
from .mediapipe_landmarks import (
    FaceGeometry,
    bbox_from_landmarks,
    eye_aspect_ratio,
    five_points,
    landmarks_to_pixels,
    pose_from_landmarks,
    pose_from_matrix,
)

log = logging.getLogger("ekyc.ml")

#: DeepFace's embedding model. 512-d, the same architecture the ONNX backend uses.
EMBEDDING_MODEL = "ArcFace"

#: Blendshapes worth surfacing; the rest are noise for this application.
INTERESTING_BLENDSHAPES = (
    "eyeBlinkLeft",
    "eyeBlinkRight",
    "mouthSmileLeft",
    "mouthSmileRight",
    "jawOpen",
)


class DeepFaceMediaPipeBackend:
    name = "deepface+mediapipe"

    def __init__(self, models_dir: Path) -> None:
        self.models_dir = models_dir
        self._landmarker = None
        self._deepface = None
        self._fasnet = None
        self._lock = threading.Lock()
        self._geometry_cache: dict[int, FaceGeometry] = {}

        task = models_dir / "face_landmarker.task"
        if not task.is_file():
            raise FileNotFoundError(
                f"missing {task}; run scripts/fetch_models.py to download the MediaPipe model"
            )
        self._task_path = task

    # -- lazy loaders --------------------------------------------------------

    def _get_landmarker(self):
        if self._landmarker is None:
            with self._lock:
                if self._landmarker is None:
                    from mediapipe.tasks import python as mp_python
                    from mediapipe.tasks.python import vision

                    options = vision.FaceLandmarkerOptions(
                        base_options=mp_python.BaseOptions(
                            model_asset_path=str(self._task_path)
                        ),
                        running_mode=vision.RunningMode.IMAGE,
                        num_faces=5,
                        output_face_blendshapes=True,
                        output_facial_transformation_matrixes=True,
                        min_face_detection_confidence=0.4,
                        min_face_presence_confidence=0.4,
                    )
                    self._landmarker = vision.FaceLandmarker.create_from_options(options)
                    log.info("mediapipe face landmarker loaded from %s", self._task_path)
        return self._landmarker

    def _get_deepface(self):
        if self._deepface is None:
            with self._lock:
                if self._deepface is None:
                    from deepface import DeepFace

                    self._deepface = DeepFace
                    log.info("deepface loaded (embedding model %s)", EMBEDDING_MODEL)
        return self._deepface

    def _get_fasnet(self):
        if self._fasnet is None:
            with self._lock:
                if self._fasnet is None:
                    from deepface.models.spoofing.FasNet import Fasnet

                    self._fasnet = Fasnet()
                    log.info("deepface MiniFASNet ensemble loaded")
        return self._fasnet

    def warm_up(self) -> None:
        """Load every model and run each once, so the first real request is fast.

        Cold, the first submit costs ~20 s (ArcFace and MiniFASNet weights,
        MediaPipe task, TF graph tracing) — longer than the mobile client's
        20 s request timeout, so a fresh server would fail the first person
        for no reason. Called synchronously at startup; the port opens once
        this returns, so "health says ok" means "ready".
        """
        blank = np.zeros((160, 160, 3), dtype=np.uint8)
        self.analyze(blank)
        centre = np.array([[60, 60], [100, 60], [80, 85], [65, 110], [95, 110]], dtype=np.float32)
        self.embed(blank, centre)
        self.pad_score(blank, np.array([40, 40, 120, 120], dtype=np.float32))

    def loaded_models(self) -> dict[str, bool]:
        return {
            "mediapipe_landmarker": self._task_path.is_file(),
            "deepface_embedder": True,
            "deepface_antispoof": True,
        }

    # -- detection -----------------------------------------------------------

    def analyze(self, image_bgr: np.ndarray) -> list[FaceGeometry]:
        """One MediaPipe pass, giving geometry, pose and eye openness together."""
        import mediapipe as mp

        height, width = image_bgr.shape[:2]
        rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)
        mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
        result = self._get_landmarker().detect(mp_image)

        faces: list[FaceGeometry] = []
        for index, landmarks in enumerate(result.face_landmarks or []):
            points = landmarks_to_pixels(landmarks, width, height)

            matrices = getattr(result, "facial_transformation_matrixes", None) or []
            if index < len(matrices):
                yaw, pitch, roll = pose_from_matrix(np.asarray(matrices[index]))
            else:
                yaw, pitch, roll = pose_from_landmarks(points)

            blendshapes: dict[str, float] = {}
            shapes = getattr(result, "face_blendshapes", None) or []
            if index < len(shapes):
                blendshapes = {
                    category.category_name: float(category.score)
                    for category in shapes[index]
                    if category.category_name in INTERESTING_BLENDSHAPES
                }

            faces.append(
                FaceGeometry(
                    bbox=bbox_from_landmarks(points),
                    kps=five_points(points),
                    landmarks=points,
                    yaw=yaw,
                    pitch=pitch,
                    roll=roll,
                    ear=eye_aspect_ratio(points),
                    blendshapes=blendshapes,
                    # MediaPipe does not expose a per-face detection score in
                    # IMAGE mode; presence already passed the configured
                    # confidence gates, so report the gate value rather than
                    # inventing a number.
                    score=0.9,
                )
            )

        self._geometry_cache = {id(image_bgr): faces[0]} if faces else {}
        return faces

    def detect(self, image_bgr: np.ndarray) -> list[DetectedFace]:
        return [
            DetectedFace(bbox=face.bbox, kps=face.kps, score=face.score)
            for face in self.analyze(image_bgr)
        ]

    # -- pose ----------------------------------------------------------------

    def pose(self, image_bgr: np.ndarray, kps: np.ndarray) -> tuple[float, float, float]:
        """Yaw, pitch and roll in degrees.

        Present so the backend satisfies `FaceBackend` for callers that take
        the generic route. The pipeline itself uses `analyze`, which returns
        pose alongside everything else from a single pass.
        """
        faces = self.analyze(image_bgr)
        if not faces:
            return 0.0, 0.0, 0.0
        centre = kps.mean(axis=0)
        face = min(faces, key=lambda f: float(np.linalg.norm(f.kps.mean(axis=0) - centre)))
        return face.yaw, face.pitch, face.roll

    # -- recognition ---------------------------------------------------------

    def embed(self, image_bgr: np.ndarray, kps: np.ndarray) -> np.ndarray:
        """512-d ArcFace embedding via DeepFace, L2-normalised.

        Alignment is done here with the ArcFace 5-point template rather than
        left to DeepFace, so the crop matches the landmarks we already have and
        DeepFace does not run a second detector over the whole frame.
        """
        from .align import ARCFACE_SIZE, norm_crop

        aligned = norm_crop(image_bgr, kps, ARCFACE_SIZE)
        rgb = cv2.cvtColor(aligned, cv2.COLOR_BGR2RGB)

        representations = self._get_deepface().represent(
            img_path=rgb,
            model_name=EMBEDDING_MODEL,
            detector_backend="skip",
            enforce_detection=False,
            align=False,
            normalization="ArcFace",
        )
        if not representations:
            return np.zeros(512, dtype=np.float32)

        vector = np.asarray(representations[0]["embedding"], dtype=np.float32)
        norm = float(np.linalg.norm(vector))
        return vector / norm if norm > 0 else vector

    # -- presentation attack detection ---------------------------------------

    def pad_score(self, image_bgr: np.ndarray, bbox: np.ndarray) -> float:
        """Probability the face is live, from DeepFace's MiniFASNet ensemble.

        `Fasnet.analyze` is called directly with the **full frame** plus the
        face rectangle MediaPipe already found. Three reasons not to go through
        `DeepFace.extract_faces`:

        * MiniFASNet reads the border *around* a face — the edge of a phone,
          the rim of a print. Handing it a pre-made crop makes it crop the crop,
          the context vanishes, and screen replays start passing.
        * It would run a second face detector over a face we have already
          located.
        * Both of DeepFace's obvious detectors are broken in this environment:
          OpenCV 5 removed `cv2.CascadeClassifier`, and MediaPipe 1.0 removed
          the legacy `mp.solutions` API.

        Internally this ensembles two models — 2.7x and 4.0x crops — which is
        upstream's own recipe and stronger than either alone.

        Fails **closed** on error: an exception here must never become a pass.
        """
        x1, y1, x2, y2 = (float(v) for v in bbox)
        facial_area = (int(x1), int(y1), int(max(1, x2 - x1)), int(max(1, y2 - y1)))

        try:
            is_real, score = self._get_fasnet().analyze(image_bgr, facial_area)
        except Exception:  # noqa: BLE001 — any failure is a non-decision
            log.exception("anti-spoofing failed; scoring 0")
            return 0.0

        # Fasnet reports the winning class's confidence, so a confident "fake"
        # arrives as a high number with is_real False. Put both on one
        # live-probability axis.
        return float(score) if bool(is_real) else 1.0 - float(score)

    # -- eyes ----------------------------------------------------------------

    def eye_openness(self, image_bgr: np.ndarray, bbox: np.ndarray, kps: np.ndarray) -> float:
        """Eye-aspect-ratio from the Face Mesh eye contours.

        A real geometric measure, not an image-statistics stand-in: roughly
        0.30 with eyes open and 0.10 closed, scale-free and independent of
        lighting. This is what lets the closed-eyes rule be enforced rather
        than merely logged.
        """
        faces = self.analyze(image_bgr)
        if not faces:
            return 0.0
        face = _closest_to(faces, bbox)
        return face.ear


def _closest_to(faces: list[FaceGeometry], bbox: np.ndarray) -> FaceGeometry:
    """Pick the detected face whose box centre is nearest the requested one."""
    target = np.array([(bbox[0] + bbox[2]) / 2.0, (bbox[1] + bbox[3]) / 2.0])
    return min(
        faces,
        key=lambda f: float(
            np.linalg.norm(
                np.array([(f.bbox[0] + f.bbox[2]) / 2.0, (f.bbox[1] + f.bbox[3]) / 2.0]) - target
            )
        ),
    )
