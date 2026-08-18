# eKYC — liveness capture and face identity

A React Native module plus a Python server. The phone runs the interaction; the server makes the decision.

```
packages/react-native-ekyc/        the module the team consumes (server-verified)
packages/react-native-ekyc-local/  100 % on-device variant: ML Kit + MobileFaceNet, no server
apps/example/                      Expo demo for the server flow (enrol / verify / identify)
apps/local/                        Expo app for the local flow → release APK on GitHub Releases
server/                            FastAPI decision service (MediaPipe + DeepFace; onnx image on Railway)
docs/                              design spec, ML validation, PAD evaluation, UI research, device QA
```

## Why it is split this way

The phone belongs to whoever is holding it. A rooted device or a patched build can make a client-side `liveness = true` say anything, so the phone collects evidence and the server judges it — the same split FaceTec, AWS Rekognition Face Liveness, iProov and Onfido all use.

The phone stores **no biometric data at all**.

## The vision stack

**MediaPipe** measures — detection, 478 landmarks, head pose in degrees, eye
aspect ratio, blendshapes. **DeepFace** identifies — ArcFace embeddings and the
MiniFASNet anti-spoofing ensemble. Every decision the system makes comes from
those two.

On the phone, ML Kit produces a real-time signal that drives the coaching UI
only; the server never trusts it and re-derives everything from the pixels.

`EKYC_BACKEND=onnx` swaps in an ONNX-only stack (SCRFD + ArcFace + MiniFASNet)
for deployments that cannot carry TensorFlow and PyTorch. It measures worse —
see `docs/ml-validation.md` §0.

## Start here

- `docs/superpowers/specs/2026-08-17-ekyc-hybrid-design.md` — the design, the threat model, and what this system does not defend against
- `docs/ml-validation.md` — what was measured, and three published claims that turned out to be wrong
- `docs/pad-evaluation.md` — how to measure APCER/BPCER per attack species (ISO/IEC 30107-3 metrics) with the built-in harness
- `docs/qa-checklist.md` — what still needs a physical phone
- `packages/react-native-ekyc/README.md` — how to use the module

## Run it

```sh
npm install
npm test                      # 105 module tests + 16 local-package tests

cd server
py -3.12 -m pip install -r requirements.txt
py -3.12 scripts/fetch_models.py          # ~202 MB, SHA-256 verified
py -3.12 -m pytest tests -m ""            # 187 tests, 42 of them on real models
py -3.12 -m uvicorn app.main:app --host 0.0.0.0 --port 8000

cd ../apps/example
npx expo run:ios              # a development build — this cannot run in Expo Go
```

## Status

Phases 0–5 are built and tested: **90 server tests and 77 module tests pass**,
including enrol → verify → identify → erase end-to-end on real faces.

Two gates remain before production, both in `docs/qa-checklist.md`:

1. **Nothing has run on a physical phone.** The capture flow is verified by type
   checking and unit tests over the pure logic; the camera, shutter latency and
   the `yawSign` calibration need real hardware.
2. **Thresholds are calibrated against Western press photography and one
   vendor's selfie set**, not the target population, and only screen-replay
   attacks have been tested — not print, cut-out or mask. The mask defences
   (`openMouth` challenge, rPPG pulse) and the ISO/IEC 30107-3 harness exist;
   see `docs/pad-evaluation.md` for how to run the measurement that turns
   "defended" into a number.
