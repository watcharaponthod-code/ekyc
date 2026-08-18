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

## Next (reordered: server-testable layers before the RN overlay)
- 4: **Injection/deepfake defence** — reject byte/near-identical frames (an
  injected static stream repeats), require flash frames to differ, enforce
  device attestation when `require_attestation` is set.
- 5: **Depth/3D** — landmark-planarity flat-photo cue (honest: not a mask detector).
- 6: RN flash overlay (cycle colours, tag snapshots flash_N) — needs a device build.
- 7+: adversarial threshold tuning, end-to-end with real models, tighten.
- 3: landmark planarity score from `FrameFacts` (needs landmark z in facts).
- 4: replay (frame hash dup / low inter-frame diff) + require attestation when configured.
- 5+: adversarial threshold tuning, end-to-end tests, tighten.
