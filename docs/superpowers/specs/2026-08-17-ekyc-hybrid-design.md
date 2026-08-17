# eKYC — Hybrid Liveness + Face Identity — Design Spec v2

- Date: 2026-08-17
- Status: **APPROVED — implementing**
- Supersedes: `2026-08-17-ekyc-liveness-face-design.md` (v1, on-device-only). v1 is kept for the rationale on library selection; its architecture is obsolete.

## What changed from v1 and why

v1 put everything on the phone: liveness decision, embedding, template storage. That is not defensible for identity verification — **the phone belongs to the attacker.** A rooted device, a Frida hook on `LivenessSession.status`, or a patched APK defeats an on-device decision in an afternoon, and there is no audit trail for a regulator.

v2 follows what every serious vendor does (FaceTec, AWS Rekognition Face Liveness, iProov, Onfido, ZOLOZ): **the device collects evidence, the server judges.** The device keeps the real-time UX — that part genuinely cannot live on a server.

| Concern | v1 (rejected) | v2 (this spec) |
|---|---|---|
| Liveness decision | phone | **server** (independent re-verification of every claim) |
| Face embedding | phone (TFLite FaceNet) | **server** (ONNX ArcFace R50) |
| Template storage | phone (MMKV) | **server** (DB) |
| Challenge order | phone chose | **server issues**, client cannot pick |
| Anti-spoofing | none | **MiniFASNet-V2 PAD on every frame** |
| Audit trail | none | every decision persisted |
| Phone dependencies | +TFLite +24 MB model +MMKV | none of those — module is lighter |

---

## 1. Trust boundary

```
        UNTRUSTED (attacker-controlled)      │        TRUSTED
 ───────────────────────────────────────────┼──────────────────────────────
  • camera preview & framing                │  • is this a live human?
  • real-time face tracking (MLKit)         │  • did the requested motions happen?
  • instruction UI, progress, haptics       │  • is it the same human in all frames?
  • quality gate before upload              │  • who is this? (embedding + match)
  • picking the peak moment to capture      │  • what is the threshold?
  • device attestation token (generated)    │  • audit log
```

**Rule:** every claim the client makes is a *hint* that the server re-derives from the pixels. The client's `yaw`, `eyeOpen`, `passed` values are logged for diagnostics and never trusted for the decision.

### Threats handled
| Attack | Defence |
|---|---|
| Printed photo | MiniFASNet PAD + eyes-closed frame impossible for a print + pose change |
| Screen replay (video of the real user) | MiniFASNet PAD (moiré/print artefacts) + server-issued random challenge order + 120 s session TTL + one-shot session |
| Patched app claiming `passed: true` | server re-verifies from pixels; client verdict is ignored |
| Swap attack (pass liveness as A, submit B's photo) | ArcFace pairwise consistency across all evidence frames — all frames must be the same person |
| Replaying a previously captured evidence bundle | nonce + TTL + `consumed_at` one-shot + frame hash blacklist |
| Emulator / hooked runtime | Play Integrity / App Attest bound to `sessionId` (Phase 5) |
| Deepfake / 3D mask | **NOT handled.** See §12. |

---

## 2. Architecture

```
┌─── PHONE (React Native module) ──────────────┐      ┌─── SERVER (FastAPI) ────────────────┐
│ 1. POST /sessions ───────────────────────────┼─────▶│ issue sessionId + nonce +           │
│                                              │◀─────┼─ challenge ORDER (server-random)    │
│ 2. MLKit (camera asks 60 fps) → FaceSignal → │      │                                     │
│    LivenessSession: center → per-step pose   │      │                                     │
│ 3. takeSnapshot() of the preview the instant │      │                                     │
│    a pose is confirmed (no shutter lag)      │      │                                     │
│ 4. quality gate, then                        │      │                                     │
│    POST /sessions/{id}/submit (4 JPEGs) ─────┼─────▶│ decode → SCRFD detect → quality      │
│                                              │      │ → MiniFASNet PAD (every frame)      │
│                                              │      │ → pose/eye re-verification          │
│                                              │      │ → ArcFace identity consistency      │
│                                              │      │ → enroll(store template)|verify|id  │
│ 5. ◀── decision + reasons + scores ──────────┼──────┤ → audit row, delete frames          │
└──────────────────────────────────────────────┘      └─────────────────────────────────────┘
```

### Capture: preview snapshots, short holds, a real blink (v3 — measured on device)
The first design used `takePhoto()` and 700 ms holds because a photo capture lands 150–400 ms after the request. On a real phone that was the wrong trade: captures took 470–770 ms each (full-sensor JPEG encode), some front cameras refuse the third stream outright ("Failed to apply the stream configuration"), and the last step's capture was still in flight when the camera was released, failing an otherwise perfect run.

Stills are now **snapshots of the preview surface** (`takeSnapshot()`, TextureView), taken the instant a pose is confirmed: no shutter lag, no extra stream, a preview-sized JPEG in tens of milliseconds. Preview resolution is far above what the server's models consume (ArcFace 112 px, MiniFASNet 80 px), so nothing is lost. With no lag to hide:

- **Turns** are held for **120 ms** (2 detections at the ~15–20 fps ML Kit fast mode actually delivers at 720p on a mid-range phone; more at 30–60) — enough to reject one bad frame, short enough that a natural turn passes at the speed people make it.
- **Blink is an event**: one frame with mean eye-open probability ≤ 0.5 captures and completes the step (`Challenge.holdMs = 0`). The server still measures eye closure on that frame against the neutral one, so the device only picks the moment; it proves nothing.
- Capture happens on the **first** confirming frame (`captureAtProgress: 0`).
- A step cannot complete within **250 ms** of starting (`minStepMs`), mirroring the server's `step_duration_min_ms`; without it a pre-emptive turn or a stray blink would pass on the phone and be rejected as implausible on the server.
- The camera stays active through `uploading` so the final snapshot always lands.

The module still contains **zero worklet code**; ML Kit runs on the JS-thread callback path.

---

## 3. Protocol

All endpoints under `/v1`. `Content-Type: application/json` unless stated.

### 3.1 `POST /v1/sessions`
```jsonc
// request
{ "purpose": "enroll" | "verify" | "identify",
  "personId": "p_01H…",        // required iff purpose == "verify"
  "displayName": "สมชาย ใจดี",  // optional, purpose == "enroll"
  "client": { "platform": "ios", "osVersion": "26.0", "model": "iPhone15,2", "appVersion": "1.0.0" } }

// 201
{ "sessionId": "s_01H…",
  "nonce": "b64url-32B",
  "challenges": ["closeEyes", "turnRight", "turnLeft"],   // SERVER-RANDOMISED ORDER
  "expiresAt": "2026-08-17T10:12:00Z",
  "policy": { "holdMs": 120, "perStepTimeoutMs": 12000, "totalTimeoutMs": 60000 } }
```
The server always prepends the implicit `center` step client-side; it is a framing gate, and its captured frame is the `neutral` evidence frame.

### 3.2 `POST /v1/sessions/{sessionId}/submit`
`multipart/form-data`:

| field | type | content |
|---|---|---|
| `manifest` | `application/json` | see below |
| `frames` | `image/jpeg` (repeated) | one part per step; the **filename** carries the key — `neutral.jpg`, `turnLeft.jpg`, … |

Frames travel under a single repeated field rather than one field per challenge: a dynamic field name cannot be expressed in the server's typed signature, and a filename is unambiguous.

```jsonc
// manifest
{ "nonce": "…echoed…",
  "startedAt": 1786936800123, "finishedAt": 1786936812456,
  "steps": [ { "name": "center",   "tStart": 123, "tEnd": 987,
               "observed": { "yaw": 1.2, "pitch": -3.0, "roll": 0.4,
                             "leftEye": 0.98, "rightEye": 0.97, "smile": 0.05 } },
             { "name": "closeEyes", "tStart": 1100, "tEnd": 2050, "observed": { … } } ],
  "capture": { "frameWidth": 1280, "frameHeight": 720, "fps": 28.4, "mirrored": true },
  "attestation": { "type": "playIntegrity" | "appAttest" | "none", "token": "…" } }
```

```jsonc
// 200 — decision is always returned with HTTP 200; transport errors use 4xx/5xx
{ "decision": "pass" | "fail",
  "reasons": ["PAD_LOW"],                       // empty when pass
  "scores": { "pad": 0.94, "identityConsistency": 0.81,
              "quality": { "sharpness": 142.0, "brightness": 0.51, "faceRatio": 0.42 },
              "steps": { "neutral":  { "yawProxy": 0.18, "ok": true },
                         "turnLeft": { "yawProxy": -0.24, "yawDelta": -0.42, "ok": true },
                         "closeEyes": { "openness": 0.19, "neutralOpenness": 0.58,
                                        "ratio": 0.33, "ok": true, "rule": "advisory" } } },
  "personId": "p_01H…",                          // enroll: created; verify/identify: matched
  "match": { "ok": true, "score": 0.71 }         // verify/identify only
}
```

### 3.3 Other endpoints
| method | path | purpose |
|---|---|---|
| `GET` | `/v1/persons` | list enrolled persons (id, displayName, templateCount, createdAt) |
| `GET` | `/v1/persons/{id}` | one person + audit summary |
| `DELETE` | `/v1/persons/{id}` | PDPA erasure — deletes person, templates, audit frame refs |
| `GET` | `/v1/health` | model load status + version |

### 3.4 Reason codes (stable, client switches on these)
`SESSION_NOT_FOUND` `SESSION_EXPIRED` `SESSION_CONSUMED` `NONCE_MISMATCH` `CHALLENGE_MISMATCH`
`TIMING_IMPLAUSIBLE` `FRAME_MISSING` `FRAME_UNREADABLE` `NO_FACE` `MULTIPLE_FACES`
`QUALITY_SHARPNESS` `QUALITY_BRIGHTNESS` `QUALITY_FACE_TOO_SMALL`
`PAD_LOW` `POSE_NOT_FRONTAL` `POSE_INSUFFICIENT_TURN` `POSE_SAME_DIRECTION` `EYES_NOT_CLOSED`
`IDENTITY_INCONSISTENT` `PERSON_NOT_FOUND` `NO_MATCH`

---

## 4. Server design

### 4.1 Vision stack

`EKYC_BACKEND` selects it. **`deepface` is the default**; `onnx` is a
TensorFlow-free alternative; `fake` runs the API with no models at all.

#### Default — MediaPipe + DeepFace

| Job | Library | Model | Licence |
|---|---|---|---|
| detection, 478 landmarks, head pose, eye openness, blendshapes | **MediaPipe Face Landmarker** | `face_landmarker.task` (3.6 MB) | Apache-2.0 |
| face embedding | **DeepFace** | ArcFace, 512-d | MIT (weights fetched on first use) |
| presentation-attack detection | **DeepFace** | MiniFASNet ensemble, 2.7x + 4.0x crops | Apache-2.0 |

One MediaPipe pass per frame yields geometry, pose and eye openness together;
running the landmarker once instead of three times is the difference between a
snappy check and a slow one.

#### Alternative — `EKYC_BACKEND=onnx`

| Job | File | Note |
|---|---|---|
| detection + 5 points | `det_10g.onnx` (SCRFD-10GF) | InsightFace `buffalo_l` |
| embedding | `w600k_r50.onnx` (ArcFace R50) | InsightFace `buffalo_l` |
| PAD | `minifasnet_v2.onnx` | Apache-2.0, SHA-256 `d7b3cd9b…eecc7b` |

Loads in `onnxruntime` alone — no TensorFlow, no PyTorch. It measures worse on
every axis tested (see `docs/ml-validation.md` §0) and needs
`EKYC_NEUTRAL_YAW_MAX_DEG` raised to ~45, because five-point pose carries a
±13° per-person bias.

> **Licence note:** the InsightFace `buffalo_l` weights are published for
> research use, so `EKYC_BACKEND=onnx` is not commercially deployable without
> resolving that. The default stack has no such restriction.

Fetched by `server/scripts/fetch_models.py`; `GET /v1/health` reports what loaded.

### 4.2 Preprocessing that matters

- **MiniFASNet must see the whole frame.** It reads the border *around* a face —
  the edge of a phone, the rim of a print. Handing it a pre-made crop makes it
  crop the crop, the context vanishes, and screen replays start passing: AUC
  0.976 with a pre-crop against **1.000** with the full frame. `pad_score` calls
  `Fasnet.analyze(frame, facial_area)` directly for this reason, and a test pins
  it.
- **ArcFace alignment** uses a five-point similarity warp (Umeyama) onto the
  canonical template at 112×112. Anatomy then lands on fixed pixels in every
  crop, which is what makes cross-frame comparison meaningful.
- **`onnx` backend only:** SCRFD letterboxes to 640×640 with
  `blobFromImage(1/128, mean 127.5, swapRB)`; its MiniFASNet export needs **raw
  0…255** input and reads live from **class 1** — the published card is wrong on
  both, and following it yields a detector that emits a near-constant vector.

### 4.3 Verification pipeline (cheapest checks first; short-circuits)
1. **Session**: exists → not expired → not consumed → nonce equal → `manifest.steps[1:]` names == issued `challenges` in order. Mark consumed **before** any ML work (prevents parallel replay).
2. **Timing**: `finishedAt - startedAt ∈ [2 s, 90 s]`; every step `tEnd > tStart`; step durations ≥ 250 ms; steps monotonic and non-overlapping.
3. **Decode** every frame; reject > 8 MB or < 480 px on the short side.
4. **Detect** per frame: exactly one *significant* face, score ≥ 0.5, else `NO_FACE` / `MULTIPLE_FACES`. A second face only counts when it is ≥ 50 % of the subject's width — otherwise a passer-by thirty metres behind you fails the session.
5. **Quality** on `neutral`: Laplacian variance ≥ 60 (sharpness), mean luma ∈ [0.25, 0.85], face box width ≥ 0.22 × frame width.
6. **PAD** on every frame → `min(liveScore) ≥ 0.45` else `PAD_LOW`.
7. **Pose / eye re-verification** (§4.4).
8. **Identity consistency**: embed all frames, min pairwise cosine ≥ 0.30 else `IDENTITY_INCONSISTENT`. (The turned frames legitimately score lower than two frontal ones — hence the loose bound. It is a *swap* detector, not a match.)
9. **Decision** → enroll / verify / identify.
10. **Audit** row; frames discarded (default `RETAIN_FRAMES=none`).

### 4.4 Convention-free pose, and a real eye measure

Absolute left/right is a swamp: front cameras mirror, EXIF rotates, and
detectors disagree on sign. The server therefore **never asserts a direction**.

Pose comes from MediaPipe's 4×4 facial transformation matrix, decomposed to
degrees (ZYX, with the gimbal-lock case handled). Rules:

- `neutral`: `|yaw| ≤ 25°` — a loose sanity bound that rejects a profile shot.
- each turn: `|yaw(turn) − yaw(neutral)| ≥ 22°`, measured **as a change from the
  subject's own neutral frame**. Nobody rests at exactly zero, and under the
  `onnx` fallback the resting offset (±13°) exceeds the turn threshold itself.
- both turns present: the two deltas must have **opposite signs**, else
  `POSE_SAME_DIRECTION`.

That proves the head physically rotated both ways without naming either, so
mirroring cannot change the verdict and relabelling the frames gains an attacker
nothing.

**Eye openness** is a textbook eye-aspect-ratio from MediaPipe's eye contours:

```
EAR = (|p2−p6| + |p3−p5|) / (2 · |p1−p4|)
```

Scale-free by construction — no normalisation for face size, distance or
lighting. Open eyes measure ~0.27 median; shut lids fall below 0.08. The rule
requires **both** a drop against the subject's own neutral frame (`ratio ≤ 0.65`)
**and** an absolute floor (`EAR ≤ 0.12`); the floor catches a neutral frame that
was itself captured mid-blink, which would make any ratio look fine.

`EKYC_EYE_RULE` defaults to **`enforce`**. It was advisory while the metric was
an uncalibrated image statistic; a real EAR is what changed that.

### 4.5 Data model (SQLAlchemy; SQLite dev → Postgres prod)
```
sessions(id PK, purpose, person_id, nonce, challenges_json, policy_json,
         created_at, expires_at, consumed_at, state, client_json)
persons(id PK, display_name, created_at, deleted_at)
templates(id PK, person_id FK, embedding BLOB(2048B = 512×f32), created_at, session_id)
audit_events(id PK, session_id, at, decision, reasons_json, scores_json, frame_sha256_json)
```
Identify is a linear scan over `templates` — fine to ~50 k templates on CPU (512-d dot products). Beyond that, swap `TemplateStore` for pgvector; the interface does not change.

### 4.6 Thresholds

Every value below was set from measurement. Full workings, sample sizes and the
three defaults that would have rejected genuine users are in
`docs/ml-validation.md`.

| Name | Default | Basis |
|---|---|---|
| `PAD_MIN` | 0.45 | live min 0.501 vs spoof max 0.393 — AUC 1.000 |
| `MATCH_MIN` | 0.42 | 60 genuine / 1710 impostor pairs, AUC 0.994: FAR 0.06 %, FRR 13 % |
| `CONSISTENCY_MIN` | 0.25 | worst genuine within-person pair 0.155, impostor median 0.065 |
| `NEUTRAL_YAW_MAX_DEG` | 25 | frontal LFW median 7.7°, p90 19.1° |
| `TURN_YAW_MIN_DEG` | 22 | as a delta from neutral |
| `EYE_CLOSED_RATIO` / `EAR_CLOSED_MAX` | 0.65 / 0.12 | open-eye EAR median 0.265, p10 0.131 |
| `SHARPNESS_MIN` | 60 | real phone selfies bottom out at 98 |
| `FACE_RATIO_MIN` | 0.22 | real phone selfies bottom out at 0.252 |

What is still **not** calibrated: the **target population** — every measurement
above is on Western press photography plus one vendor's selfie set — and
**non-replay attacks**: print, cut-out and mask are untested.

### 4.7 Logging

One line per decision carrying the whole picture, plus per-stage timings:
`session.created`, `submit.rejected`, `submit.decided`, `measure.analyze`,
`measure.pad`, `measure.embed`, `decide`. `EKYC_LOG_FORMAT=json` for ingestion,
`text` for a readable console.

Logs complement the `audit_events` table rather than duplicating it, and a
redaction filter drops any field whose name mentions an embedding, an image, a
frame, a nonce or a token — so no biometric or replayable material can reach a
log sink.

## 5. Mobile module design

```
packages/react-native-ekyc/src/
  index.ts                  public surface only
  types.ts                  FaceSignal, Step, LivenessState, EvidenceBundle, Decision, EKYCError
  liveness/
    Challenge.ts            abstract Challenge { name, instruction, isSatisfied(signal) }
    challenges.ts           CenterChallenge, CloseEyesChallenge, TurnLeftChallenge,
                            TurnRightChallenge, SmileChallenge
    LivenessSession.ts      pure-TS hold-based state machine; emits LivenessState + capture requests
  client/
    EKYCClient.ts           createSession / submit / persons / deletePerson (fetch, no deps)
  ui/
    EKYCCamera.tsx          orchestrator: camera + detector + session + capture + submit
    FrameOverlay.tsx        SVG oval mask + progress ring  (§6)
    InstructionBanner.tsx   animated instruction text
    StatusStrip.tsx         step dots
    ResultView.tsx          success / failure
    theme.ts                design tokens (§6)
    haptics.ts              optional expo-haptics, no-ops when absent
```

| Unit | Responsibility | Depends on |
|---|---|---|
| `Challenge` | one predicate over a `FaceSignal`; no timing, no state | nothing (pure) |
| `LivenessSession` | ordering, hold accumulation, timeouts, failure reasons, *when to capture* | `Challenge` (pure) |
| `EKYCClient` | HTTP only; knows nothing about cameras | `fetch` |
| `EKYCCamera` | the only stateful React piece; wires detector → session → photo → client | VisionCamera, face-detector |
| `FrameOverlay` etc. | render `LivenessState`; zero logic | `react-native-svg` |

`liveness/` and `client/` are pure TypeScript with **no react-native imports**, so they run under plain Jest with no native mocks. That is where the interesting logic lives, and it is 100 % unit-testable.

### 5.1 Hold-based state machine
```
                    ┌───────────── signal lost > 1 s / multiple faces / timeout ──────────┐
                    ▼                                                                      │
idle ─start()→ step[i] ──satisfied for holdMs (0 = one frame)──→ CAPTURE(step[i]) ──→ step[i+1] … → uploading → passed
                    ▲                                                                      │
                    └── predicate breaks → hold resets to 0 (progress ring rewinds) ───────┘
                                                                                        failed(reason)
```
`LivenessState = { phase, stepIndex, stepCount, challenge, holdProgress 0..1, framing, reason? }` — the UI is a pure function of this.

`framing = 'ok' | 'noFace' | 'multipleFaces' | 'tooFar' | 'tooClose' | 'offCentre' | 'tooDark'` drives the coaching copy and is evaluated *before* the challenge predicate, so the user is never asked to turn while they are out of frame.

### 5.2 Client-side signal (from MLKit, JS thread — no worklets)
```ts
type FaceSignal = {
  count: number
  yaw: number; pitch: number; roll: number          // degrees
  leftEye: number; rightEye: number; smile: number  // 0..1
  box: { x: number; y: number; w: number; h: number } // normalised to frame
  t: number
}
```
Detector options: `performanceMode: 'fast'`, `runClassifications: true`, `runLandmarks: false`, `runContours: false`, `trackingEnabled: false`, `cameraFacing: 'front'`.

**Yaw sign is not hardcoded.** `TurnLeftChallenge` takes a `sign: 1 | -1` from config; the module ships a `__DEV__` debug overlay showing live yaw so calibration on a real device takes seconds. The server does not care either way (§4.4).

### 5.3 Public API — everything the consuming team must learn
```tsx
import { EKYCCamera, EKYCClient } from '@ekyc/react-native-ekyc'

const client = new EKYCClient({ baseUrl: 'https://ekyc.example.com' })

<EKYCCamera
  client={client}
  purpose="enroll"                    // 'enroll' | 'verify' | 'identify'
  personId={personId}                 // required for 'verify'
  displayName="สมชาย ใจดี"
  onResult={(d) => d.decision === 'pass' ? goNext(d.personId) : showRetry(d.reasons)}
  onCancel={() => nav.goBack()}
/>
```
Optional props: `theme`, `locale ('th' | 'en')`, `onProgress(state)`, `debug`.

### 5.4 Errors
`EKYCError { code, message, retriable }` with codes `CAMERA_PERMISSION`, `NO_CAMERA`, `NETWORK`, `SERVER`, `SESSION_EXPIRED`, `CANCELLED`. Liveness failures are **not** exceptions — they arrive through `onResult` with `decision: 'fail'` and reason codes, because retrying is the normal path.

---

## 6. UI/UX design

Every number below is measured from shipped identity SDKs (decompiled Android/iOS binaries, production stylesheets, published theming APIs) rather than chosen by taste. Research notes: `docs/ui-research.md`.

### 6.1 Capture frame

| Property | Value | Evidence |
|---|---|---|
| Shape | oval (ellipse) | 13 of 15 surveyed SDKs; Persona and Cash App use a circle, Incode a silhouette |
| Aspect (h/w) | **1.42** | Persona 1.46 - Sumsub 1.443 - Veriff 1.50 - FaceTec 1.47-1.70 - Onfido 1.241 |
| Width | 74 % of screen | between Onfido's 35 % (a small web canvas) and Sumsub's ~90 % |
| Vertical offset | -5 % of screen height | leaves room for three lines of instruction below |
| Border | 3 px | Onfido 3 px - Persona 3 dp - FaceTec 6 px |
| Scrim | near-opaque `rgba(7,10,18,0.90)` | Persona `#0B051D`, Sumsub `?colorBackground`, AWS white are all **opaque**; translucency lets background clutter fight the text |

### 6.2 Progress

Two indicators, because there are two different quantities:

- **Hold ring** - four brackets around the oval that seal into a closed ring as the pose is held. Implemented as an ellipse dash pattern (`holdRingDash`), the same visual Regula produces with `startAngle = i*90 + 20(1-p)`. Justified here because hold progress is genuinely continuous; most vendors ship no meter at capture time precisely because they have nothing continuous to show.
- **Step dots** - one per challenge. Discrete challenges call for dots, not a sweep ring. Done = larger filled dot **with a tick**; current = ring; pending = small and dim. Never colour alone.

### 6.3 Colour

| Token | Value | Note |
|---|---|---|
| background | `#070A12` | |
| accent | `#6C8CFF` | deliberately not a brand colour - WeChat's capture accent is `#5065FF` against a `#07C160` brand, because this screen is governed by contrast against live video |
| success | `#4ADE80` | |
| danger | `#FB7185` | |
| oval idle | `rgba(255,255,255,0.34)` | |

Border colour is the primary state channel (idle -> active -> success -> error), which is what almost every vendor actually uses.

### 6.4 Copy

One short imperative clause, **at most 60 characters** (ZOLOZ's documented cap; Tencent's short tip is 17). Thai and English ship together; a unit test enforces the length budget and that both dictionaries cover every state.

Phrasing follows real vendor strings - `Move closer`, `Hold steady`, `Center your face` - not the widely-copied "Position your face in the oval", which appears in **no** shipped SDK.

Failure is explained as advice, not as an error restatement: "The photo was blurry. Hold the phone a little steadier." (Sumsub's suggestion-card pattern.)

### 6.5 Motion and feedback

| Event | Treatment |
|---|---|
| Instruction change | 220 ms cross-fade |
| Hold progress | 120 ms follow - short enough to feel attached to the pose |
| Result badge | spring, damping 15 / stiffness 200 |
| Step passed | 500 ms vibration (RN `Vibration`; expo-haptics fallback) — the phone is at arm's length, a 20 ms tick does not register |
| Final pass / fail | success / error notification haptic |
| Any capture | **no sound**, ever - not one surveyed SDK plays audio |

`AccessibilityInfo.isReduceMotionEnabled()` disables all of the above animation. Only 2 of 15 surveyed SDKs honour reduced motion; it costs almost nothing.

### 6.6 Accessibility

- Instruction carries `accessibilityLiveRegion="polite"` **and** calls `announceForAccessibility` - omitting this is a real shipped bug in at least one production SDK, leaving screen-reader users with no state feedback at all.
- The instruction area reserves three lines and is bottom-aligned, so the oval never jumps when copy wraps.
- Step state is carried by size and glyph as well as colour.
- Progress is exposed as an `accessibilityRole="progressbar"` with min/max/now.

### 6.7 Flow

Three screens: **intro -> capture -> result**. The intro is not optional decoration - Onfido's own documentation warns that removing it raises drop-off - and it is the only honest place for the PDPA consent line, before the camera opens.

---

## 7. Re-verification policy (answering "next time can they just scan a face?")

**No.** Liveness is collected on every verification; only the *template* is created once. This mirrors FaceTec, whose stored FaceMap deliberately contains no liveness data so that fresh liveness must be captured before every match.

What scales with risk is the *number of challenges*, not whether liveness happens:

| Risk tier | Flow | Steps | ~Time |
|---|---|---|---|
| Enrolment, new device binding, profile change | full | `center` + 3 random challenges | 10–15 s |
| High-value transaction, password change | reduced | `center` + **1** server-chosen challenge | 3–5 s |
| Ordinary app unlock | **no face scan** — OS biometrics (`expo-local-authentication`) + device token | — | <1 s |

The server chooses the tier from `purpose` and returns fewer `challenges`. One config value, same code path.

---

## 8. Privacy / PDPA

- Face images are transient: decoded in memory, never written to disk by default (`RETAIN_FRAMES=none`); SHA-256 of each frame is stored for replay detection, which is not reversible to an image.
- Only 512 float32 (2 KB) per template persists. Templates are pseudonymous — they carry no name unless the app sets `displayName`.
- `DELETE /v1/persons/{id}` performs real erasure (person + templates + audit frame refs), satisfying the PDPA right to erasure.
- Consent screen is part of the example app flow, before the camera is opened. Biometric data under PDPA §26 requires explicit consent.
- Transport: TLS only; certificate pinning is Phase 5.
- The phone stores **no biometric data at all** — a deliberate reduction of the attack/compliance surface versus v1.

---

## 9. Testing

| Layer | What | How |
|---|---|---|
| Mobile unit (Jest, no device) | every `Challenge` predicate; `LivenessSession` — happy path, hold reset on predicate break, per-step timeout, total timeout, face lost, multiple faces, capture requests emitted exactly once per step, framing precedence over challenge; `EKYCClient` request shape + error mapping against a stubbed `fetch` | `npm test -w @ekyc/react-native-ekyc` |
| Mobile typecheck | strict TS across module + example | `tsc --noEmit` |
| Server unit (pytest) | session lifecycle (expiry, one-shot, nonce, challenge-order mismatch), timing plausibility, pose rules incl. same-direction rejection, threshold boundaries, template store round-trip, PDPA delete cascade — all with a **fake** model backend so they run without model files | `pytest server/tests` |
| Server ML integration | real ONNX models on real images: detection finds a face, embedding of the same face ≥ 0.9 self-similarity, alignment is stable, PAD runs and returns a 3-vector, eye-index calibration reproduces | `pytest server/tests -m models` (skipped when models absent) |
| End-to-end | example app against a locally running server, on a physical device | manual checklist `docs/qa-checklist.md` |
| Attack tests | printed photo, photo on a second phone's screen, video replay of a real session — recorded verbatim, including what got through | Phase 6, physical devices |

MLKit ships no arm64 iOS simulator slice, so all device testing is on physical hardware.

---

## 10. Phases

| # | Deliverable | Done when |
|---|---|---|
| 0 | ✅ Monorepo scaffold, deps installed, Expo dev-build config, model fetch script | `npm install` clean, `tsc --noEmit` clean, `fetch_models.py` verifies SHA-256 |
| 1 | ✅ `types` + `Challenge` + `LivenessSession` + Jest suite | 51 tests covering every branch in §9 row 1 |
| 2 | ✅ Server core: FastAPI, session lifecycle, data model, decision engine + pytest | 50 tests green without any model file |
| 3 | ✅ Server ML: SCRFD, ArcFace, MiniFASNet; integration + end-to-end tests | 18 tests on real models and real faces |
| 4 | ✅ Mobile UI: `EKYCCamera`, overlay, ring, banner, intro, result, theme, haptics, Thai + English | typecheck clean; 26 UI-logic tests |
| 5 | ✅ Example app: consent → capture → result, enrol / verify / identify, wired to the server | typecheck clean; **not yet run on a physical device** |
| 6 | ⬜ Calibration on the target population + attack tests | see `docs/qa-checklist.md` |
| 7 | ⬜ Hardening: Play Integrity / App Attest, cert pinning, rate limiting | — |

Phases 0–5 are built. Phase 5's device run and Phase 6 are the remaining gates before production; Phase 7 follows business need.

**Device findings (Android 35 phone + Android 36 emulator), all folded back into the code:** ML Kit reports *positive* yaw for a turn to the user's left (`DEFAULT_YAW_SIGN = -1`); some front cameras reject preview + analysis + capture (→ snapshots); photo captures took 470–770 ms (→ snapshots); RN `FormData` needs `file://` on native paths or the upload dies on the device with no server trace (→ `asFileUri`); the first submit after a cold server took ~25 s, longer than the client's 20 s timeout (→ models warmed at startup, health only answers when ready). Phone diagnostics are POSTed to `/v1/client-log` so device and server lines interleave in one log (`server/scripts/tail_log.py`).

---

## 11. Repository layout
```
EKYC/
├─ packages/react-native-ekyc/    the module handed to the team
├─ apps/example/                  Expo dev-build demo
├─ server/
│  ├─ app/{main,config,db,models,schemas}.py
│  ├─ app/ml/{detector,embedder,landmarks,pad,align,backend}.py
│  ├─ app/services/{sessions,verification,persons}.py
│  ├─ scripts/{fetch_models,calibrate_eye_indices}.py
│  ├─ tests/
│  └─ models/                     gitignored, ~198 MB
└─ docs/
```

---

## 12. Limitations — stated plainly

1. **Deepfakes and 3D masks are not handled.** MiniFASNet-V2 is a 2015-era-lineage print/replay classifier. A real-time face-swap injected as a virtual camera, or a high-quality silicone mask, will very likely pass. Defeating those needs certified vendor tech (FaceTec, iProov) or, at minimum, camera-injection detection. Do not describe this system as deepfake-resistant.
2. **No certification.** ISO 30107-3 / iBeta Level 1–2 is what regulators ask for in bank account opening. Nobody self-builds through that audit. This system is appropriate for **internal and medium-assurance** use — staff login, attendance, step-up auth inside an app whose KYC happened elsewhere. It is *not* appropriate as the sole identity proof for opening a regulated financial account (ETDA IAL 2.3 / NDID territory).
3. **All six thresholds are unvalidated defaults** (§4.6). They come from model documentation and general practice, not from measurement on the target population. ArcFace R50 is trained on WebFace600K, which under-represents Thai faces; the match threshold in particular will move.
4. **InsightFace `buffalo_l` weights are research-licensed** (§4.1). Commercial deployment requires resolving this. Nothing else in the stack has this problem — MiniFASNet is Apache-2.0.
5. **Server-side eye-openness relies on a calibrated landmark-index constant.** If the calibration image is unrepresentative the metric degrades. Mitigation: it is relative to the user's own neutral frame, and it is one of several signals, not a sole gate.
6. **Single-maintainer dependency**: `react-native-vision-camera-face-detector`. The `FaceSignal` type is the seam; replacing it means rewriting one adapter file, not the state machine.
7. **No offline mode.** By design — an offline decision is an untrusted decision. Apps needing offline unlock use OS biometrics (§7).

---

## 13. Decisions made, and what would reverse them

| Decision | Reverse if |
|---|---|
| Hybrid device/server, server judges | never, for identity verification |
| Stills are preview snapshots; turns hold 120 ms, blink is one frame | a regulator demands sensor-resolution stills → add `usePhotoOutput` back behind a flag and accept the latency |
| Server issues the challenge order | never |
| Convention-free `yawProxy` with opposite-sign rule | field data shows the proxy is unstable for very wide faces → move to 3-D pose from 106 landmarks + PnP |
| ONNX + `onnxruntime` (no PyTorch/TensorFlow at inference) | need GPU batching at scale → same ONNX files, add CUDA EP |
| ArcFace R50 512-d | licensing (§12.4) → swap `ArcFaceEmbedder` for a commercially-licensed model |
| SQLite + linear scan | > 50 k templates → Postgres + pgvector behind the same `TemplateStore` |
| `react-native-svg` + RN `Animated`, no Reanimated | complex gesture-driven motion appears → add Reanimated |
| No worklets in the module | continuous-authentication feature needs per-frame embeddings |
| Phone stores no biometric data | never |

---

## Sources verified 2026-08-17
- FaceTec: fresh liveness required before every match, FaceMap holds no liveness data — <https://dev.facetec.com/3d-liveness>, <https://www.facetec.com/security>
- AWS Rekognition Face Liveness client/server split — <https://docs.aws.amazon.com/rekognition/latest/APIReference/API_CreateFaceLivenessSession.html>, <https://docs.aws.amazon.com/rekognition/latest/dg/face-liveness-programming-api.html>
- iProov active vs passive — <https://www.iproov.com/videos/active-vs-passive-liveness-which-is-better>
- Thai IAL 2.3 / ETDA (NIST SP 800-63 derived) — <https://www.asco.or.th/uploads/articles_attc/1669619590.pdf>
- npm registry (2026-08-17): `react-native-vision-camera@5.2.2`, `react-native-vision-camera-face-detector@2.0.6` (peer VisionCamera ≥ 5.0), `react-native-nitro-image@0.15.1`, `expo@57.0.13`
- VisionCamera v5 API read from package source 5.2.2: `usePhotoOutput`/`takePhoto`, `Photo.saveToTemporaryFileAsync`, `HybridFrameConverter`
- InsightFace preprocessing constants read from `insightface/model_zoo/{scrfd,arcface_onnx}.py`, `utils/face_align.py`
- MiniFASNet-V2 ONNX card (Apache-2.0, 80×80 BGR [0,1], 2.7× crop, 3-class) — <https://huggingface.co/garciafido/minifasnet-v2-anti-spoofing-onnx>
- Model I/O shapes verified locally with `onnxruntime` 1.26.0
