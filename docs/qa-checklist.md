# Device QA checklist

Nothing in this repository has run on a physical phone yet. Everything below is what type checking and unit tests **cannot** tell you, in the order that finds problems fastest.

ML Kit ships no arm64 iOS simulator slice, so all of this needs real hardware: one iPhone and one mid-range Android.

---

## 0. Before you start

```sh
# server
py -3.12 server/scripts/fetch_models.py
py -3.12 -m uvicorn app.main:app --host 0.0.0.0 --port 8000   # from server/
curl http://localhost:8000/v1/health     # expect backend "deepface+mediapipe"

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

- [ ] Each step's instruction appears; arrows point where *you* turn (left arrows = turn your left)
- [ ] A quick natural turn (no slow sweep) passes; you should not need to hold
- [ ] A single ordinary blink passes the "กระพริบตา" step
- [ ] Turning back to centre before 120 ms is up rewinds the ring; the step does not complete
- [ ] A 500 ms vibration fires on each completed step
- [ ] **No shutter sound**, on either platform, at any point
- [ ] The step dots fill left to right, each with a tick
- [ ] Whole flow takes 4–8 s at a normal pace

**Read the numbers, don't guess them** — every line below reaches the server log (`py -3.12 server/scripts/tail_log.py`):

- [ ] `camera config N fps` — 60 on a sensor that supports it, else 30
- [ ] `captured <step> Nms` — snapshot + JPEG encode; expect < 150 ms
- [ ] `submitting N frames, detector F fps` — F is real ML Kit throughput; below ~12 raise `holdMs` so a turn is still ≥ 2 detections
- [ ] `decision pass|fail <reasons>` — the server's verdict as the phone saw it; `submit failed <code>` if it never got there

---

## 5. Decisions from the server

- [ ] Enrol → `pass`, a person appears in the list
- [ ] Verify the same person, same lighting → `pass`, score above 0.6
- [ ] Verify a **different** person against that record → `fail` / `NO_MATCH`
- [ ] Identify with two people enrolled → returns the right one
- [ ] Delete a person → they vanish; verifying again returns `PERSON_NOT_FOUND`
- [ ] Airplane mode mid-upload → a retriable network failure, not a crash
- [ ] Submit the same session twice (background the app mid-upload) → second attempt `SESSION_CONSUMED`

Record for each run: `scores.pad`, `scores.identityConsistency`,
`scores.steps.*.yawDelta`, `scores.steps.closeEyes.ear` and `match.score`.
Those are the input to Phase 6 — and the server already logs every one of them
per submission (`submit.decided`), so `EKYC_LOG_FORMAT=json` plus a file sink is
enough to collect the whole campaign.

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

The closed-eyes rule is **enforced** now that it measures a real eye-aspect-ratio from MediaPipe's eye contours. A printed photo cannot close its eyes, so expect it to contribute here — record whether it actually does.

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
2. **PAD on print attacks.** Only screen replay has been measured (AUC 1.000, n=70). Print, cut-out and mask attacks are untested.
3. **Eye rule.** Already enforced, with the floor set under the measured open-eye p10 (0.131). Confirm on the target population that genuinely closed eyes clear `EKYC_EAR_CLOSED_MAX=0.12` and open eyes do not.
4. **Within-session yaw noise.** Ten sessions of the same person; look at the spread of `yawDeg` across repeated neutral frames. If it is well under 22°, `EKYC_TURN_YAW_MIN_DEG` can come down and the turn gets easier.

---

## 9. Do not ship without

- [ ] Phase 6 complete
- [ ] If running `EKYC_BACKEND=onnx`: InsightFace `buffalo_l` licensing resolved. The default MediaPipe + DeepFace stack has no such restriction.
- [ ] TLS with certificate pinning
- [ ] Play Integrity / App Attest bound to `sessionId`
- [ ] Rate limiting on `/v1/sessions`
- [ ] A decision on deepfake and 3-D-mask exposure — this system does not address either
