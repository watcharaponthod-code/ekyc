# eKYC — liveness capture and face identity

A React Native module plus a Python server. The phone runs the interaction; the server makes the decision.

```
packages/react-native-ekyc/   the module the team consumes
apps/example/                 Expo demo (enrol / verify / identify)
server/                       FastAPI + ONNX decision service
docs/                         design spec, ML validation, UI research, device QA
```

## Why it is split this way

The phone belongs to whoever is holding it. A rooted device or a patched build can make a client-side `liveness = true` say anything, so the phone collects evidence and the server judges it — the same split FaceTec, AWS Rekognition Face Liveness, iProov and Onfido all use.

The phone stores **no biometric data at all**.

## Start here

- `docs/superpowers/specs/2026-08-17-ekyc-hybrid-design.md` — the design, the threat model, and what this system does not defend against
- `docs/ml-validation.md` — what was measured, and three published claims that turned out to be wrong
- `docs/qa-checklist.md` — what still needs a physical phone
- `packages/react-native-ekyc/README.md` — how to use the module

## Run it

```sh
npm install
npm test                      # 77 module tests

cd server
py -3.12 -m pip install -r requirements.txt
py -3.12 scripts/fetch_models.py          # ~198 MB, SHA-256 verified
py -3.12 -m pytest tests -m ""            # 68 tests, 18 of them on real models
py -3.12 -m uvicorn app.main:app --host 0.0.0.0 --port 8000

cd ../apps/example
npx expo run:ios              # a development build — this cannot run in Expo Go
```

## Status

Phases 0–5 are built and tested. Nothing has run on a physical phone yet, and the thresholds are calibrated against Western press photography and one vendor's selfie set rather than the target population. Both are gates before production; see `docs/qa-checklist.md`.
