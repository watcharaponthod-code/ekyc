# Liveness Hardening — running plan (`/loop`)

Goal: climb from "2D PAD + active-challenge" toward world-class (iBeta L2-class)
defence in depth, using only the screen + camera we already have where possible.
Build + test every iteration; commit each. Stop when every layer below is built,
tested green, threshold-tuned on synthetic adversarial data, and no cheap
hardening remains.

## Layers (world-class stack, mapped to what we can build)

| # | Layer | Status | Notes |
|---|-------|--------|-------|
| 0 | Recognition (ArcFace) | ✅ shipped | identity embedding |
| 1 | Passive PAD (MiniFASNet 2D) | ✅ shipped | weak end; upgrade path = FLIP/CDCN |
| 2 | **Active-flash liveness** | ✅ built (server+device); device runtime pending build | screen flashes random colours; real skin tracks them. iProov/AWS/FaceTec technique. |
| 3 | **Depth/3D (landmark planarity)** | ✅ built (advisory, empirically weak) | flat/degenerate-input cue only; not a photo/mask detector |
| 4 | **Injection/deepfake defence** | ✅ built | frame-dup + attestation enforcement + flash-binding |
| 5 | Server authority / nonce / delete | ✅ shipped | |
| 6 | **Expression challenge (`openMouth`, `smile`)** | ✅ built (server+device) | rigid-mask defence: MediaPipe `jawOpen`/`mouthSmile*` vs neutral, two-part rule; full tier always includes `openMouth` |
| 7 | **rPPG pulse liveness** | ✅ built (server+device), **advisory** | silicone/latex-mask defence: burst of stills, POS + multi-patch spectral prominence. Calibrated on synthetic traces only. |
| 8 | **ISO/IEC 30107-3 evaluation harness** | ✅ built | `EKYC_RETAIN_FRAMES=all` + `label` → `scripts/pad_eval.py`: APCER per species, BPCER, ACER, NRR, Wilson CI, gate attribution, `--rescore` |
| 9 | API key + attestation hook | ✅ built | `EKYC_API_KEYS`; `<EKYCCamera attestation={…}>` provider feeds the manifest |

## Iteration log
- **1 (active-flash core):** `server/app/flash.py` — pure scorer: correlation of
  commanded flash colours vs observed face colour per channel. Synthetic test
  separates real (skin reflects) from photo/replay/wrong-sequence spoof.

- **2 (active-flash decision gate):** `FrameFacts.face_rgb` + `geometry.mean_face_color`
  + `decision._check_flash` (FLASH_SPOOF/FLASH_FRAME_MISSING) + `config.flash_min`
  + `verify_evidence(flash_commanded=…)`. 5 decision tests; whole fast suite 66 green.
  Flash gate skipped unless a plan was issued → zero effect on existing sessions.

- **3 (active-flash issuance + API):** `settings.flash_frames` (0=off, server-
  controlled), `sessions.pick_flash` (random colour permutation), stored on the
  session, returned in `CreatedSession.flash`, resolved to RGB at `/submit` and
  passed to `verify_evidence`. 4 API tests (off by default, randomised, real
  clears the gate, photo→FLASH_SPOOF). Fast suite 70 green.

- **4 (deploy prep) DONE:** `Dockerfile` (slim onnx, EKYC_BACKEND=onnx),
  `requirements-deploy.txt` (opencv-headless + psycopg, no TF/torch), `.dockerignore`,
  `railway.json`, `config.normalize_db_url` reads Railway `DATABASE_URL` → psycopg.
  Proven: `docker build` ok, image 1.09 GB, container `/v1/health` = onnx ok,
  session creates in-container. 3 config tests. See `server/DEPLOY.md`.

- **5 (injection/deepfake defence) DONE:** `decision._check_injection`
  (FRAMES_DUPLICATE — same bytes across two steps = injected/replayed stream)
  + `_check_attestation` (ATTESTATION_MISSING when `require_attestation` and the
  manifest carries no Play Integrity / App Attest token; presence-only, crypto
  verification is a follow-up). 6 tests; fast suite 79 green. Flash's random
  colour frames differ by construction, so legit sessions never trip the dup check.

- **6 (depth/3-D planarity) DONE — and empirically confirmed weak:**
  `geometry.planarity_score` (PCA λ_min/Σλ), computed from MediaPipe's 478 3-D
  landmarks in the backend, on `FrameFacts.planarity`; advisory `_check_planarity`
  gate (FLAT_FACE only under `planarity_rule=enforce`). Measured on real LFW
  faces: planarity **~0.09-0.11**, a flat point set 0.0. BUT LFW are 2-D photos
  and still score ~0.10 — MediaPipe infers face-shaped z — so this does **not**
  catch a photo of a face, only truly-flat/degenerate/injected frames. Kept as an
  advisory sanity signal; real depth defence needs hardware. 84 tests green.

- **7 (RN device flash overlay) DONE:** `ui/flashColors.ts` (palette matching
  server), EKYCCamera runs a flash phase after the steps (show each colour
  full-screen, snapshot flash_N, then submit; `snapshot` refactor, isActive
  covers flashing, full-screen overlay), client copy for FLASH_SPOOF / FLAT_FACE
  / FRAMES_DUPLICATE / ATTESTATION_MISSING (th+en). TS clean; 96 module tests.
  On-device runtime pending an APK build, like the rest of the RN UI.

- **8 (mask defence, 2026-08-18):** `FrameFacts.mouth_open/smile/skin_patches`;
  `EXPRESSION_CHALLENGES` issued only when `backend.supports_expressions`
  (deepface yes, onnx no); `decision._check_expression` (MOUTH_NOT_OPEN /
  SMILE_ABSENT / EXPRESSION_UNVERIFIABLE, `expression_rule`); `app/pulse.py`
  + `_check_pulse` (PULSE_ABSENT / PULSE_FRAME_MISSING, `pulse_rule`
  advisory), pulse frames measured on the light path (landmarker only), first/
  last anchored into identity consistency; PAD now judged on challenge frames
  only (flash frames were dragging `pad_min` down); `services/retention.py` +
  `scripts/pad_eval.py`; `require_api_key`. Device: `OpenMouthChallenge`,
  ML Kit contours → `mouthOpenness`, pulse burst phase before flash,
  `attestation` prop, `apiKey`. Server fast suite 145, module 105.

- **9 (measure-first tuning, 2026-08-19):** no session data existed for the
  reported "hard to pass" runs (Railway held only 2 test sessions; laptop
  audit empty), so the fix is instrumentation + removing structural
  strictness, not moving numbers by hand:
  challenges are judged as a *change from the person's own neutral frame*
  (turn Δyaw, nod Δpitch, mouth Δratio) with per-step `stepMetrics`
  (best/needed) surfaced in state, failed events, client logs and the local
  session log; client thresholds derive from the server `SessionPolicy`
  (`turnYawMinDeg`, `neutralYawMaxDeg` + margin via `tuningFromPolicy`) instead
  of a second copy (client 18° vs server 22° was a built-in mismatch); local
  identity uses **star topology** (each pose vs neutral, not left-vs-right)
  and flip-TTA embeddings; `flash_rule` advisory until measured; `/v1/audit`
  + `scripts/audit_report.py` (server) and `local_calibrate.py` (phone log)
  give per-gate distributions; project skill `.claude/skills/liveness-tuning`.
  Tests: core 113, local 32, server 149.

## Next
- Collect ≥ 20 genuine sessions per flow (audit endpoint / shared local log),
  run the calibrate scripts, and set thresholds from the p5/p10 of genuine
  sessions with impostor guards — then flip flash/pulse to enforce where the
  data supports it.
- **rPPG calibration on phones** — record `bona_fide` + `mask_*` with retention
  on, run `pad_eval.py`, decide `pulse_min` / `pulse_rule=enforce`. This is the
  gate between "defended" and "measured".
- 8: **Adversarial flash robustness** — harden the correlation against real
  noise (low ambient, one-channel-dominant room light, partial reflection,
  motion between frames); tune FLASH_MIN; add edge-case tests.
- 9: update spec + architecture artifact with the new layers (team handoff).
- 10: build APK with EKYC_FLASH_FRAMES on, emulator/device smoke.
