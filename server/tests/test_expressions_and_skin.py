"""Pure helpers behind the mask defences: blendshape → expression numbers, and
the skin-patch colour sampler that feeds rPPG. No models needed."""

from __future__ import annotations

import numpy as np

from app.ml.deepface_backend import expressions_from_blendshapes
from app.ml.geometry import SKIN_PATCHES, skin_patch_colors


class TestExpressionsFromBlendshapes:
    def test_reads_jaw_open_and_the_mean_smile(self):
        mouth, smile = expressions_from_blendshapes(
            {"jawOpen": 0.62, "mouthSmileLeft": 0.4, "mouthSmileRight": 0.6}
        )
        assert mouth == 0.62
        assert smile == 0.5

    def test_missing_blendshapes_are_unmeasured_not_zero(self):
        assert expressions_from_blendshapes({}) == (-1.0, -1.0)
        mouth, smile = expressions_from_blendshapes({"eyeBlinkLeft": 0.9})
        assert mouth == -1.0 and smile == -1.0

    def test_one_sided_smile_still_counts(self):
        _, smile = expressions_from_blendshapes({"jawOpen": 0.0, "mouthSmileLeft": 0.8})
        assert smile == 0.8


def _face_image(color_bgr, size=400):
    image = np.zeros((size, size, 3), dtype=np.uint8)
    image[:] = (30, 30, 30)
    image[100:300, 100:300] = color_bgr
    return image


class TestSkinPatchColors:
    def test_without_landmarks_it_reads_the_face_box_centre_as_one_patch(self):
        image = _face_image((60, 120, 200))  # BGR → skin-ish RGB (200,120,60)
        bbox = np.array([100, 100, 300, 300], dtype=np.float32)
        patches = skin_patch_colors(image, None, bbox)
        assert len(patches) == 1
        r, g, b = patches[0]
        assert abs(r - 200 / 255) < 0.01 and abs(g - 120 / 255) < 0.01 and abs(b - 60 / 255) < 0.01

    def test_with_landmarks_it_returns_one_colour_per_patch(self):
        image = _face_image((60, 120, 200))
        # 478 landmarks all inside the face square, spread so each polygon has area
        rng = np.random.default_rng(0)
        landmarks = rng.uniform(110, 290, size=(478, 2)).astype(np.float32)
        bbox = np.array([100, 100, 300, 300], dtype=np.float32)
        patches = skin_patch_colors(image, landmarks, bbox)
        assert len(patches) == len(SKIN_PATCHES) == 3
        for r, g, b in patches:
            assert abs(r - 200 / 255) < 0.02

    def test_patch_indices_are_valid_face_mesh_indices(self):
        for patch in SKIN_PATCHES:
            assert len(patch) >= 3
            assert all(0 <= i < 468 for i in patch)
