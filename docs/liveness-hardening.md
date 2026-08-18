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
| 2 | **Active-flash liveness** | 🔨 building | screen flashes random colours; real skin tracks them. iProov/AWS/FaceTec technique. No depth HW needed. |
| 3 | **Depth/3D (landmark planarity)** | ⬜ | flat-photo detector from MediaPipe 478 z; honest: not a silicone-mask detector |
| 4 | **Injection/deepfake defence** | ⬜ | replay/frame-dup detection + attestation enforcement + flash-binding |
| 5 | Server authority / nonce / delete | ✅ shipped | |

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

## Next
- 8: **Adversarial flash robustness** — harden the correlation against real
  noise (low ambient, one-channel-dominant room light, partial reflection,
  motion between frames); tune FLASH_MIN; add edge-case tests.
- 9: update spec + architecture artifact with the new layers (team handoff).
- 10: build APK with EKYC_FLASH_FRAMES on, emulator/device smoke.
- 7: RN flash overlay (cycle colours, tag snapshots flash_N) — needs a device build.
- 8+: adversarial threshold tuning, end-to-end with real models, tighten.

## Handoff decision list (for the dev team) — delivered to user this turn
Top-10 decision table given in chat: architecture(hybrid), PAD(MiniFASNet→FLIP),
active-flash(building), recognition(ArcFace), DB(SQLite→Postgres), 1:N(pgvector),
injection(attestation), deploy(Docker→Railway), cert(iBeta L1→L2), handoff(npm module).
- 3: landmark planarity score from `FrameFacts` (needs landmark z in facts).
- 4: replay (frame hash dup / low inter-frame diff) + require attestation when configured.
- 5+: adversarial threshold tuning, end-to-end tests, tighten.
