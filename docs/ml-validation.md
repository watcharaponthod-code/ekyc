# ML validation record

What was measured, on what data, and which published claims turned out to be wrong.
Everything here is reproducible with `pytest server/tests/test_ml_integration.py -m models`.

Date: 2026-08-17 · onnxruntime 1.26.0 · opencv 4.10.0 · CPU only

---

## 1. Datasets used

| Set | What | n | Why |
|---|---|---|---|
| **LFW** (`sklearn.datasets.fetch_lfw_people`, 250×250 colour) | frontal press photos, many per person | 30 people × 6 | detection, embedding separation, pose-proxy statistics |
| **Axon Labs selfies** (Kaggle `axondata/anti-spoofing-live-dataset`) | genuine phone selfies | 25 | PAD live class |
| **Axon Labs replay** (Kaggle `axondata/liveness-detection-real-and-display-attacks-5k`) | 5 real photos + 5 screen-replay videos | 5 + 30 frames | PAD spoof class |

None of these are committed. LFW is cached by scikit-learn; the Kaggle sets were used interactively for calibration only.

---

## 2. The MiniFASNet model card is wrong in three ways

The published card for `garciafido/minifasnet-v2-anti-spoofing-onnx` states: input `pixel/255`, BGR, 2.7× **square** crop, and `liveScore = p[0]`. Following it produces a **detector that does nothing**:

```
live selfies   mean softmax = [0.000 0.006 0.994]   argmax = class 2 for 25/25
real photos    mean softmax = [0.000 0.006 0.994]   argmax = class 2 for  5/5
screen replays mean softmax = [0.000 0.006 0.994]   argmax = class 2 for 30/30
```

Identical to three decimals across live and spoof, and across crop scales 1.5 / 2.7 / 4.0. Feeding the network constant, noise and mid-grey tensors in `[0,1]` also returns a near-constant vector — it is saturated, not classifying.

### What is actually correct

| | Card says | Measured truth |
|---|---|---|
| Input range | `pixel / 255` | **raw 0…255 float** |
| Live class | index 0 | **index 1** (matches minivision's own `if label == 1: real`) |
| Crop | square, 2.7× | **`CropImage.crop` semantics**: scale *clamped* to fit the image, aspect preserved, window shifted (not cut) at edges |
| Channels | BGR, no swap | BGR, no swap ✔ (the one thing the card got right) |

The crop was the decisive fix. Padding a square crop with a replicated border makes **every** face look like it has a screen edge around it, which is precisely the artefact the network was trained to flag.

### Separation after the fix (30 live vs 30 screen-replay)

| crop scale | input ÷ | swapRB | class | AUC | live p10 | spoof p90 |
|---|---|---|---|---|---|---|
| 1.5 | 1.0 | no | 1 | **0.999** | 0.982 | 0.393 |
| **2.7** | **1.0** | **no** | **1** | **0.996** | **0.944** | **0.393** |
| 2.0 | 1.0 | no | 1 | 0.996 | 0.963 | 0.393 |
| 4.0 | 1.0 | no | 1 | 0.992 | 0.943 | 0.393 |
| 2.7 | 255.0 | yes | 1 | 0.658 | 0.005 | 0.006 |

**Shipped:** scale 2.7 (matches the `2.7_80x80` weight name), divisor 1.0, no swap, class 1.
`PAD_MIN = 0.70` sits in the empty band between live p10 = 0.944 and spoof p90 = 0.393.

1.5 scores marginally higher but tuning a crop constant on 60 samples is overfitting; the documented scale wins.

**Limits of this result:** 60 samples, one vendor, **screen replay only**. No printed-photo, cut-out-mask or 3-D-mask attacks were tested. Do not read AUC 0.996 as a general PAD claim.

---

## 3. Face recognition (ArcFace R50 `w600k_r50`)

12 people × 3 LFW images, 36 genuine pairs, 594 impostor pairs:

```
same-person   median 0.702   p5   0.023
diff-person   median 0.007   max  0.262

thr    FRR      FAR
0.30   0.111    0.000
0.42   0.111    0.000     <- shipped MATCH_MIN
0.60   0.222    0.000
```

The impostor ceiling (0.262) and the genuine median (0.702) leave a wide empty band; **0.42 sits in the middle of it**. FRR of 11% is dominated by a couple of LFW pairs whose similarity is near zero — extreme pose or a different face selected in a multi-person photo — and is not representative of a controlled capture.

**Not validated for the target population.** ArcFace R50 is trained on WebFace600K; LFW is predominantly Western press photography. The Thai-face operating point must be measured before production (Phase 6).

---

## 4. Head pose — why the rule is relative

The yaw proxy (nose position along the eye-to-eye axis) was expected to sit near 0 for a frontal face. On 180 frontal LFW frames it does not:

```
|yaw_proxy| across everyone   median 0.184   p90 0.559   max 1.500
per-person MEAN bias          std    0.151   range [-0.343, +0.270]
```

A per-person offset of ±0.15 comes from facial asymmetry and landmark placement, and carries no pose information. An **absolute** threshold would therefore reject many people's frontal faces and accept others' as turns. The original `NEUTRAL_YAW_MAX = 0.12` would have rejected the majority of genuine frontal captures — caught by `test_frontal_faces_clear_the_neutral_gate`.

**Rule as shipped:**
- `neutral`: `|yawProxy| ≤ 0.45` — a loose sanity bound that rejects a profile shot; the client already gates `|yaw| < 12°` before capture.
- each turn: `|yawProxy(turn) − yawProxy(neutral)| ≥ 0.30`, cancelling the bias exactly.
- both turns present: the two deltas must have **opposite signs**.

`0.30` corresponds to about **25°** under a simple head model (`Δ ≈ 0.635·tan θ`, from a 20 mm nose projection over a 63 mm interocular distance):

| Δ | 0.20 | 0.25 | 0.30 | 0.35 | 0.40 |
|---|---|---|---|---|---|
| θ | 17.5° | 21.5° | 25.3° | 28.9° | 32.2° |

The opposite-sign rule is the load-bearing part and needs no calibration. The magnitude does — LFW's within-person spread (median std 0.268) conflates real pose variation between press photos with measurement noise, so it cannot bound the frame-to-frame noise of one controlled session. Phase 6 measures that directly.

---

## 5. Eye openness — measured, but advisory

Metric: darkness of the eye windows relative to the face's own median luma, on the ArcFace-aligned 112×112 crop where the eyes always land on the same pixels.

Candidates compared on 40 LFW faces, real eyes vs eyes replaced by blurred cheek skin (a stand-in for an eyelid):

| metric | open (median) | closed (median) | ratio median | ratio p90 | separation |
|---|---|---|---|---|---|
| **darkness** | 0.602 | 0.266 | **0.447** | 0.809 | **0.99** |
| std ratio | 0.633 | 0.326 | 0.567 | 0.854 | 0.83 |
| dark fraction | 0.215 | 0.000 | 0.000 | 0.385 | 0.80 |
| range | 0.374 | 0.213 | 0.563 | 0.870 | 0.74 |

`darkness` wins and is shipped. **But the closed-eye class here is simulated.** An attempt to validate on real matched pairs failed: CEW and the MRL-derived Kaggle drowsiness sets are *eye-region crops*, not full faces, so the detect→align pipeline cannot run on them (1 of 220 images aligned).

**Consequence:** `EKYC_EYE_RULE` defaults to `advisory` — the ratio is measured, scored and logged, but does not fail a session on its own. `EKYC_EYE_RULE=enforce` turns it into a hard rule once Phase 6 has real matched captures. Shipping an uncalibrated rule that rejects genuine users would trade a security gain we cannot demonstrate for a usability loss we can.

With the eye rule advisory, the print-attack defence rests on PAD (§2) and the two opposite turns.

What *is* verified on real faces: the canonical eye windows land on actual eyes — median local contrast inside them is >1.3× the cheek's across all LFW test faces (`test_the_eye_windows_land_on_actual_eyes`). If alignment or the window constants drift, that test fails.

---

## 5b. Capture quality — calibrated on real phone selfies

Measured on 25 genuine phone selfies plus 5 real photographs (the same Axon sets used for PAD), which is the distribution the app will actually see:

| metric | min | p5 | median | max | shipped threshold | margin |
|---|---|---|---|---|---|---|
| sharpness (Laplacian var, 160×160 face crop) | 97.9 | 119.3 | 270.6 | 429.9 | `≥ 60` | 1.6× below the worst real selfie |
| brightness (mean face luma) | 0.319 | 0.437 | 0.518 | 0.606 | `0.25 – 0.85` | comfortable both ends |
| face ratio (box width / frame width) | 0.252 | 0.302 | 0.350 | 0.438 | `≥ 0.22` | just below the worst real selfie |

All three thresholds sit outside the real-selfie distribution, so none of them should reject a genuine capture.

Worth knowing: LFW's archival crops score `sharpness` median 54 and are rejected by that same gate. That is the gate working — a 250×250 rescanned press photo is not a phone selfie — but it means LFW cannot be used to exercise the quality stage.

---

## 5c. Identity consistency — the swap detector

`consistency_min` guards against passing liveness as one person and submitting another's photo. It has to survive a genuine head turn, so it was measured under conditions **harsher than any real session**: for 14 LFW subjects, a frontal shot plus the two most extreme profiles available (|yawProxy| up to 1.0, roughly 58°), photographed years apart.

```
within-person  min pairwise cosine   min 0.455   p5 0.505   p10 0.537   median 0.620
across-person  frontal pairs         max 0.145   p95 0.078  median 0.000
```

The original default of **0.45 sat directly on the worst genuine case** and would have rejected real users. The empty band runs from 0.145 to 0.455; **0.30** is shipped — 2× above the worst impostor, 1.5× below the worst genuine, and measured against far more pose change than a 25° turn produces.

---

## 5d. Multiple faces — significance, not count

Counting every detection above threshold rejects a valid selfie because a stranger is walking past thirty metres behind you. Real photographs make this immediate: in the LFW sample, bystanders were detected at 68 and 83 px beside subjects of 99 and 102 px.

A second face now only counts when it is **≥ 50 % of the subject's width** (`COMPANION_WIDTH_RATIO`). A person close enough to be a co-conspirator is comparable in size; a passer-by is not. NMS was verified as clean while investigating this — the extra detections were real people, not duplicates.

---

## 6. Everything else verified

- **Detection**: 0 misses on 36 LFW images; landmark order confirmed anatomically (eyes above nose above mouth).
- **Alignment**: Umeyama recovers a synthetic rotation+scale+translation to 1e-6, and maps landmarks onto the canonical template to 1e-3.
- **Embeddings**: unit length, deterministic across repeated runs (self-similarity 1.0 ± 1e-5).
- **PAD crop clamping**: a box hanging off the image corner still yields an 80×80 patch; a degenerate box returns `None` rather than a guess.

---

## 6b. End-to-end, real models, real faces

`tests/test_e2e_models.py` drives the actual HTTP API with evidence bundles built from real photographs (a frontal shot plus two shots posed in opposite directions, per subject):

- enrol → verify with a **different set of photographs of the same person** → pass
- verify a **different person** against that record → `NO_MATCH`, with a lower score
- identify 1:N across two enrolled people → returns the right one
- delete a person → they disappear, and a later verify returns `PERSON_NOT_FOUND`

These tests relax `PAD_MIN` and `SHARPNESS_MIN` on purpose, because both are calibrated for phone selfies (§2, §5b) and archival crops fall outside that distribution by construction. Pose, identity, session and audit rules stay fully strict — those are what the test is proving.

---

## 7. Open items for Phase 6

1. Match threshold on Thai faces — the single highest-value calibration.
2. Real print, cut-out and mask attacks against PAD.
3. Matched open/closed captures to calibrate the eye rule, then `EKYC_EYE_RULE=enforce`.
4. Frame-to-frame yaw-proxy noise within one session, to tighten `TURN_YAW_MIN`.
5. InsightFace `buffalo_l` is research-licensed. Commercial use needs a licence or a different embedder — one class, `OnnxFaceBackend.embed`.
