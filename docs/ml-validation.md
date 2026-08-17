# ML validation record

What was measured, on what data, and which published claims turned out to be wrong.
Reproduce with `pytest server/tests -m models` from `server/`.

Date: 2026-08-17 · mediapipe 1.0.1 · deepface 0.0.100 · onnxruntime 1.26.0 · opencv 5.0.0 · CPU only

---

## 0. Two backends, and why the default changed

`EKYC_BACKEND` selects the vision stack.

| | `deepface` (default) | `onnx` |
|---|---|---|
| detection, landmarks, pose, eye openness | MediaPipe Face Landmarker | SCRFD five points |
| embedding | DeepFace (ArcFace) | ArcFace ONNX |
| anti-spoofing | DeepFace MiniFASNet **ensemble** (2.7x + 4.0x crops, two models) | MiniFASNet ONNX, single model |
| head pose | **degrees, from the facial transformation matrix** | degrees, inferred from five points (+/-13 deg per-person bias) |
| eye openness | **eye-aspect-ratio from the eye contours** | image-statistics proxy |
| runtime cost | TensorFlow + PyTorch | onnxruntime only |

The default is `deepface` because it measures better on every axis that was tested:

| measurement | `onnx` | `deepface` |
|---|---|---|
| PAD, live vs screen replay | AUC 0.996 | **AUC 1.0000** |
| identity, LFW | AUC — (small sample) | **AUC 0.9938** over 1710 impostor pairs |
| frontal faces clearing the 25 deg neutral gate | 72 % | **> 90 %** |
| closed-eyes rule | advisory only — metric never calibrated | **enforced** — real EAR |

`onnx` remains for deployments that cannot carry TensorFlow and PyTorch. It needs
`EKYC_NEUTRAL_YAW_MAX_DEG` raised to about 45 (see §4).

---

## 1. Datasets used

| Set | What | n | Why |
|---|---|---|---|
| **LFW** (`sklearn.datasets.fetch_lfw_people`, 250x250 colour) | frontal press photos, many per person | 20 people x 3 | detection, pose, eye openness, embedding separation |
| **Axon Labs selfies** (Kaggle `axondata/anti-spoofing-live-dataset`) | genuine phone selfies | 25 | PAD live class |
| **Axon Labs replay** (Kaggle `axondata/liveness-detection-real-and-display-attacks-5k`) | 5 real photos + 5 screen-replay videos | 5 + 40 frames | PAD spoof class |

None are committed. LFW is cached by scikit-learn; the Kaggle sets were used
interactively for calibration only.

---

## 2. Anti-spoofing

### 2a. The default backend: DeepFace's MiniFASNet ensemble

```
live  n=30   median 1.000   p10 0.986   min 0.501
spoof n=40   median 0.054   p90 0.254   max 0.393
AUC = 1.0000
```

| threshold | live rejected | spoof accepted |
|---|---|---|
| 0.30 | 0 % | 7.5 % |
| **0.45** | **0 %** | **0 %** |
| 0.70 | 3.3 % | 0 % |

`PAD_MIN = 0.45` sits in the empty band between live min 0.501 and spoof max 0.393.

**The frame matters more than the model.** Passing DeepFace a pre-made face crop
scores AUC 0.976 and lets 47 % of screen replays through at any usable
threshold. MiniFASNet reads the border *around* a face — the edge of a phone,
the rim of a print — so cropping first destroys the very signal it looks for.
Handing it the full frame plus the face rectangle gives AUC 1.000. That is why
`pad_score` calls `Fasnet.analyze(full_frame, facial_area)` directly rather than
going through `DeepFace.extract_faces`, and why a test pins it.

Two of DeepFace's own detectors are unusable in this environment, which is a
second reason to bypass that path: OpenCV 5 removed `cv2.CascadeClassifier`, and
MediaPipe 1.0 removed the legacy `mp.solutions` API.

### 2b. The `onnx` backend: the model card is wrong in three ways

The card for `garciafido/minifasnet-v2-anti-spoofing-onnx` states: input
`pixel/255`, BGR, 2.7x **square** crop, `liveScore = p[0]`. Following it produces
a **detector that does nothing**:

```
live selfies   mean softmax = [0.000 0.006 0.994]   argmax = class 2 for 25/25
real photos    mean softmax = [0.000 0.006 0.994]   argmax = class 2 for  5/5
screen replays mean softmax = [0.000 0.006 0.994]   argmax = class 2 for 30/30
```

Identical to three decimals across live and spoof, and across crop scales. Constant,
noise and mid-grey tensors in `[0,1]` also return a near-constant vector — the
network is saturated, not classifying.

| | Card says | Measured truth |
|---|---|---|
| Input range | `pixel / 255` | **raw 0…255 float** |
| Live class | index 0 | **index 1** |
| Crop | square, 2.7x | **`CropImage.crop`**: scale clamped to fit the image, aspect preserved, window shifted at edges |
| Channels | BGR, no swap | BGR, no swap (the one thing it got right) |

With those corrections: AUC 0.996, live p10 0.944 against spoof p90 0.393.

**Limits of both results:** 70 samples, one vendor, **screen replay only**. No
printed-photo, cut-out or 3-D-mask attacks were tested. Do not read AUC 1.000 as
a general PAD claim.

---

## 3. Face recognition

DeepFace ArcFace over 20 LFW subjects — 60 genuine and 1710 impostor pairs:

```
genuine   median 0.594   p5 0.359   min 0.155
impostor  median 0.065   p95 0.251  max 0.469
AUC = 0.9938
```

| threshold | FRR | FAR |
|---|---|---|
| 0.35 | 5.0 % | 0.58 % |
| **0.42** | **13.3 %** | **0.06 %** |
| 0.50 | 23.3 % | 0.00 % |

`MATCH_MIN = 0.42`. In identity verification a false accept is a breach and a
false reject is a retry, so the operating point leans towards FAR. The 13 % FRR
is inflated by LFW's cross-year, cross-pose pairs; two controlled selfies score
far higher. Raise to 0.50 for FAR 0 % if the retry cost is acceptable.

**Not validated for the target population.** ArcFace is trained largely on
Western-weighted data and LFW is Western press photography. The Thai operating
point must be measured before production.

### Identity consistency (the swap detector)

`consistency_min` catches passing liveness as one person and submitting
another's photo. Worst within-person pair on LFW: **0.155**, p5 **0.217**;
impostor median **0.065**. Those genuine pairs are years apart at extreme angles,
far harsher than two frames seconds apart, so **0.25** is conservative by
construction.

---

## 4. Head pose

The default backend decomposes MediaPipe's 4x4 facial transformation matrix, so
pose is in real degrees. On nominally frontal LFW photographs it reads a median
of **7.7 deg**, p90 **19.1**, max **43.1** — real variation in the photographs,
not measurement error.

The `onnx` backend infers yaw from five points instead
(`proxy ~= 0.635 * tan(theta)`). It carries a large per-person bias from facial
asymmetry, measured over 20 subjects:

```
|yaw| median 15.9 deg   p75 26.8   p90 38.6   p95 47.0   max 67.1
<= 25 deg : 71.7 %      <= 45 deg : 93.3 %
```

So the shared 25 deg neutral gate — sized for MediaPipe — rejects nearly a third
of frontal faces under the `onnx` backend. **Raise `EKYC_NEUTRAL_YAW_MAX_DEG` to
about 45 when running it.** A test pins this rather than leaving it as folklore.

**Turns are always measured as a change from the subject's own neutral frame,**
under both backends. Nobody holds their head at exactly zero, and with the
five-point fallback the resting offset is larger than the turn threshold itself.
The two turn deltas must also have **opposite signs**, which proves the head
rotated both ways without ever naming a direction — so camera mirroring and EXIF
rotation cannot affect the verdict.

`TURN_YAW_MIN_DEG = 22`.

---

## 5. Eye openness — now enforced

The default backend computes a textbook eye-aspect-ratio from MediaPipe's eye
contours (indices 33/160/158/133/153/144 and 362/385/387/263/373/380):

```
EAR = (|p2-p6| + |p3-p5|) / (2 * |p1-p4|)
```

Scale-free by construction, so no normalisation by face size, camera distance or
lighting is needed. Measured on open eyes across 20 subjects:

```
median 0.265   p10 0.131
```

The rule needs **both** a drop relative to the subject's own neutral frame
(`ratio <= 0.65`) **and** an absolute floor (`EAR <= 0.12`). The floor guards the
case where the neutral frame was itself captured mid-blink, which would make any
ratio look fine. It sits under the measured p10 because eye shape varies a lot
between people — at the earlier value of 0.18, narrow-eyed users would have
cleared it with their eyes open.

`EKYC_EYE_RULE` now defaults to **`enforce`**. Under the previous ONNX-only
pipeline the metric was an uncalibrated image statistic and the rule had to stay
advisory; a real EAR is what changed that.

MediaPipe's `eyeBlinkLeft/Right` blendshapes are recorded alongside as an
independent second opinion, and a test asserts they correlate negatively with
EAR — but they are not part of the decision.

---

## 6. Capture quality — calibrated on real phone selfies

Measured on 25 genuine phone selfies plus 5 real photographs, which is the
distribution the app will actually see:

| metric | min | p5 | median | max | threshold | margin |
|---|---|---|---|---|---|---|
| sharpness (Laplacian variance, 160x160 face crop) | 97.9 | 119.3 | 270.6 | 429.9 | `>= 60` | 1.6x below the worst real selfie |
| brightness (mean face luma) | 0.319 | 0.437 | 0.518 | 0.606 | `0.25 – 0.85` | comfortable both ends |
| face ratio (box width / frame width) | 0.252 | 0.302 | 0.350 | 0.438 | `>= 0.22` | just below the worst real selfie |

LFW's archival crops score a sharpness median of 54 and are rejected by that
gate. That is the gate working — a rescanned 250x250 press photo is not a phone
selfie — but it means LFW cannot exercise the quality stage.

---

## 7. Multiple faces — significance, not count

Counting every detection rejects a valid selfie because a stranger walks past
thirty metres behind you. In the LFW sample, bystanders were detected at 68 and
83 px beside subjects of 99 and 102 px. A second face now only counts when it is
**at least 50 % of the subject's width** (`COMPANION_WIDTH_RATIO`). NMS was
verified clean while investigating this — the extra detections were real people,
not duplicates.

---

## 8. End to end, real models, real faces

`tests/test_e2e_models.py` drives the real HTTP API with evidence built from
real photographs — a frontal shot plus two shots posed in opposite directions,
per subject — against whichever backend `EKYC_BACKEND` selects:

- enrol, then verify with a **different set of photographs of the same person** → pass
- verify a **different person** against that record → `NO_MATCH`, with a lower score
- identify 1:N across two enrolled people → returns the right one
- delete a person → they disappear; a later verify returns `PERSON_NOT_FOUND`

These tests relax `PAD_MIN`, `SHARPNESS_MIN` and the closed-eyes rule on purpose:
all three are calibrated for phone selfies, and LFW subjects have their eyes open
in every frame. Pose, identity, session and audit rules stay fully strict — those
are what the test exists to prove.

**Suite: 90 passed, 0 failed** (52 without models, 23 MediaPipe + DeepFace, 15
ONNX, 4 end-to-end).

---

## 9. Open items before production

1. Match threshold on the target population — the single highest-value calibration.
2. Real print, cut-out and mask attacks. Only screen replay has been measured.
3. Frame-to-frame yaw noise within one session, to tighten `TURN_YAW_MIN_DEG`.
4. `EKYC_BACKEND=onnx` only: InsightFace `buffalo_l` is research-licensed.
   Resolve it or drop that backend. The default stack does not have this problem
   — MediaPipe is Apache-2.0 and DeepFace is MIT.
