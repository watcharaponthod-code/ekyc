# Device QA checklist

Nothing in this repository has run on a physical phone yet. Everything below is what type checking and unit tests **cannot** tell you, in the order that finds problems fastest.

ML Kit ships no arm64 iOS simulator slice, so all of this needs real hardware: one iPhone and one mid-range Android.

---

## 0. Before you start

```sh
# server
py -3.12 server/scripts/fetch_models.py
py -3.12 -m uvicorn app.main:app --host 0.0.0.0 --port 8000   # from server/
curl http://localhost:8000/v1/health     # expect backend "onnx", all three models true

# app — a development build, not Expo Go
npx expo prebuild && npx expo run:ios      # or run:android
```

Set the server URL on the app's home screen to your machine's **LAN address**, not `localhost` — on the phone, `localhost` is the phone.

---

## 1. Calibrate the yaw sign (2 minutes, do this first)

Run `<EKYCCamera debug />`, watch the live readout, and turn your head to **your** left.

- [ ] `yaw` goes **negative** → leave `DEFAULT_YAW_SIGN` at `1`
- [ ] `yaw` goes **positive** → pass `tuning={{ turn: { yawSign: -1 } }}`

Record the answer per platform; they can differ. Getting this wrong shows the wrong instruction, never a security hole — the server checks that the two turns were *opposite* without naming either direction.

---

## 2. Signal sanity

With `debug` on, confirm the numbers are plausible:

- [ ] `n=1` with one face, `n=2` when a colleague leans in
- [ ] `w` (face width as a fraction of frame) is around 0.3–0.5 at a comfortable arm's length
- [ ] `eyes` drops below 0.3 when you close them and returns above 0.7 when you open them
- [ ] `pitch` moves when you nod — expect it to be noisier than `yaw`; that is why no challenge uses it

If `w` is wildly off, `frameWidth`/`frameHeight` from the detector are not what `toSignal` assumes — fix that before tuning anything else.

---

## 3. Framing coaching

- [ ] Too far → "ขยับเข้าใกล้อีกนิด", the oval border goes dim, the hold does not accumulate
- [ ] Too close → "ถอยออกมาเล็กน้อย"
- [ ] Face off to one side → "เลื่อนใบหน้ามาตรงกลาง"
- [ ] Cover the camera → "ไม่พบใบหน้าในกรอบ", then a failure after ~1.2 s
- [ ] Second person in shot → warning colour, failure after the grace period
- [ ] Turning your head during a **turn** step does **not** trigger a framing complaint

---

## 4. The capture flow

- [ ] Each step's instruction appears, and switches to "ค้างไว้" once you are holding
- [ ] The ring's four brackets close smoothly and seal at the end of the hold
- [ ] Breaking the pose mid-hold rewinds the ring and the step does not complete
- [ ] A haptic fires on each completed step
- [ ] **No shutter sound**, on either platform, at any point
- [ ] The step dots fill left to right, each with a tick
- [ ] Whole flow takes 12–20 s at a normal pace

**Measure the shutter latency** (the one number that could break the design):

- [ ] Time from "ring reaches halfway" to the photo landing. If it regularly exceeds ~500 ms, raise `holdMs` above 700 so the pose is still held when the shutter fires.

---

## 5. Decisions from the server

- [ ] Enrol → `pass`, a person appears in the list
- [ ] Verify the same person, same lighting → `pass`, score above 0.6
- [ ] Verify a **different** person against that record → `fail` / `NO_MATCH`
- [ ] Identify with two people enrolled → returns the right one
- [ ] Delete a person → they vanish; verifying again returns `PERSON_NOT_FOUND`
- [ ] Airplane mode mid-upload → a retriable network failure, not a crash
- [ ] Submit the same session twice (background the app mid-upload) → second attempt `SESSION_CONSUMED`

Record for each run: `scores.pad`, `scores.identityConsistency`, `scores.steps.*.yawDelta`, `match.score`. Those four numbers are the input to Phase 6.

---

## 6. Attack tests — write down what gets through

Do these honestly and record the outcome even when the system loses.

| Attack | Expected | Result |
|---|---|---|
| Printed photo held to the camera | `PAD_LOW` | |
| Printed photo, bent to fake a turn | `PAD_LOW` | |
| Photo displayed on a second phone | `PAD_LOW` | |
| Video of a real session replayed on a screen | `PAD_LOW` — but the challenge order is randomised, so it must also match | |
| Real person, but a photo of someone else swapped into one step | `IDENTITY_INCONSISTENT` | |
| Two people, the enrolled one turning while the other stays frontal | `MULTIPLE_FACES` | |

The eye rule is **advisory** by default and will not fail any of these on its own — see `docs/ml-validation.md` §5.

---

## 7. Accessibility

- [ ] VoiceOver / TalkBack announces each instruction change
- [ ] Step progress is announced as "ขั้นที่ 2 จาก 4"
- [ ] At the largest system font, the instruction still fits and the oval does not jump
- [ ] With Reduce Motion on, nothing animates and the flow still completes
- [ ] The dots are distinguishable with a colour-blindness simulator (they differ in size and glyph, not only hue)

---

## 8. Threshold calibration (Phase 6 — required before production)

Everything shipped today is calibrated against Western press photography and one vendor's selfie set. What must be measured on the actual user population:

1. **Match threshold.** ≥ 20 people × 3 captures each, varying light, glasses on/off. Plot genuine vs impostor cosine, pick the point where FAR ≈ 0.1 %, record the resulting FRR. Update `EKYC_MATCH_MIN`.
2. **PAD on print attacks.** Only screen replay has been measured (AUC 0.996, n=60). Print and cut-out masks are untested.
3. **Eye rule.** Capture matched open/closed pairs of the same faces, measure the openness ratio, then set `EKYC_EYE_RULE=enforce` with a calibrated `EKYC_EYE_CLOSED_RATIO`.
4. **Within-session yaw noise.** Ten sessions of the same person, look at the spread of `yawProxy` on repeated neutral frames. If it is well under 0.30, `EKYC_TURN_YAW_MIN` can come down and the turn gets easier.

---

## 9. Do not ship without

- [ ] Phase 6 complete
- [ ] InsightFace `buffalo_l` licensing resolved, or the embedder swapped (one class: `OnnxFaceBackend.embed`)
- [ ] TLS with certificate pinning
- [ ] Play Integrity / App Attest bound to `sessionId`
- [ ] Rate limiting on `/v1/sessions`
- [ ] A decision on deepfake and 3-D-mask exposure — this system does not address either
