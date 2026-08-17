# What shipped identity SDKs actually look like

Source material for the capture screen's design decisions. Gathered by reading decompiled Android/iOS SDK binaries, production stylesheets, published theming APIs and vendor documentation for FaceTec, iProov, Onfido, Jumio, Veriff, Persona, Stripe Identity, Sumsub, Regula, Incode, ZOLOZ, AWS Rekognition, plus the onboarding flows of 17 banking and fintech apps.

The point of collecting it was to stop guessing. Every number in `src/ui/theme.ts` traces to a row here.

---

## Frame geometry

| Vendor | Shape | Aspect (h/w) | Width | Border | Scrim |
|---|---|---|---|---|---|
| Onfido (web) | egg-oval | 1.241 | 35.7 % of canvas | 3 px | 0.80 |
| FaceTec | oval, **resizes** 0.65→0.98 as you approach | 1.48→1.70 | 65–98 % | 6 px | opaque white |
| Veriff | oval | 1.50 | — | — | — |
| Persona (K0000) | stadium-oval | **1.46** | `marginHorizontal 48dp` | 3 dp | **opaque `#0B051D`** |
| Sumsub (video selfie) | oval 244×352 dp | **1.443** | — | 4 dp | opaque `?colorBackground` |
| Sumsub (Liveness3D) | circle | 1.0 | 88–92 % | — | opaque |
| Cash App, Robinhood | circle | 1.0 | — | — | — |
| Stripe Identity | rounded square | 1.0 | ~73 % | none | **none** |
| Incode | human silhouette | — | — | — | 0.80 |
| AWS Rekognition | oval | 1.618 | 80 % | 3 px | opaque white |

**Taken:** aspect **1.42**, width **74 %**, border **3 px**, scrim **0.90**.

Persona and Sumsub landing independently on 1.46 and 1.443 is the strongest signal in the table. Opaque scrims dominate among natively-decompiled SDKs; the reason given is legibility — a translucent backdrop lets background clutter compete with the instruction text.

Grab is the interesting dissent: they tested geometric cutouts, found *"geometric cutouts created a disorienting experience"*, and shipped a human silhouette instead. Worth prototyping against the oval if drop-off is ever a problem.

---

## Progress

Most vendors ship **no meter at capture time**. The dominant mechanic is a three-state stroke colour: Grab white→green, Tencent 20 %-white→`#5065FF`→`#FF6034`, iProov white→`#01AC41`, Jumio `#3E4753`→`#2ABC6D`→`#14482C`.

Exceptions: Incode (arc around the silhouette), Sumsub WebSDK (72-segment ring, `[RIGHT, BOTTOM, LEFT, TOP]` sweep), Sumsub Mobile (dot ring), Persona (four independent arc segments, `SWEEP_GAP 7°`, `STROKE_WIDTH 4dp`, accent `#A8F3B7`), Regula (8 sectors, ring rotated a half-sector so no boundary sits at 12 o'clock).

Regula's closing formula is the most directly copyable: `startAngle = i·90 + 20(1−p)`, `sweepAngle = 90 − 40(1−p)` — four corner brackets at p=0, a sealed ring at p=1.

**Taken:** the sealing-bracket ring for *hold* progress, because hold progress is genuinely continuous, plus **dots** for step progress, because the challenges are discrete. Regula's sector ring exists for a continuous head sweep, which is a different interaction.

Persona documents a detail worth stealing: *"The selfie pose progress indicator no longer fills completely before capture occurs."* Capture happens mid-progress, exactly as here.

---

## Colour

`#3640F5` Onfido · `#417FB2` FaceTec · `#01AC41` iProov · `#1693E9` Sumsub · `#4700EB` Persona · `#006AFF` Incode · `#2ABC6D` Jumio · `#7E57C5` Regula · `#5065FF` WeChat.

**Brand colour rarely survives onto the capture screen.** WeChat's is `#5065FF` against a `#07C160` brand. This screen's palette is governed by contrast against live video, not by a brand kit.

Regula ships a genuine accessibility defect worth avoiding: `overlay_border_default` and `overlay_border_active` are both `#7E57C5`, so normal and active differ only by stroke width.

---

## Micro-copy

Character budgets are real: ZOLOZ caps the face-scan instruction at **60 characters**, Tencent at **17** for the short tip.

Verbatim, from shipped bundles:

```
Onfido   "Keep your face within the oval" · "Move closer" · "Move back"
         "Face not centered" · "Please look forward" · "Too bright" · "Too dark"
         "Turn your head slowly to both sides" · "Multiple faces found"
FaceTec  "Frame Your Face In The Oval" · "Center Your Face" · "Move Closer" · "Even Closer"
         "Hold Your Head Straight" · "Hold Steady" · "Light Face More Evenly"
         "Remove Dark Glasses" · "Neutral Expression, No Smiling" · "Let's Try That Again" · "Success!"
iProov   "Put your face in the oval" · "Hold still" · "Too close" · "Move closer"
         "Go somewhere shadier" · "Assessing genuine presence…"
Regula   "Center your face" · "Look straight" · "Move closer" · "Move away" · "Hold steady"
         "Turn your head a bit" · "Add more light" · "Blink your eyes"
         "Make sure there is only one face on the screen."
Sumsub   "Fit your face into the frame" · "Face too far. Please, move closer to the camera."
         "Look straight into the camera" · "Hold still" · "Almost there. Checking..." · "You're all set"
Stripe   the entire capture vocabulary is three strings:
         "Position your face in the center of the frame." → "Capturing…" → "Selfie captures are complete"
```

**"Position your face in the oval" appears in no shipped SDK** — it is a teardown-site invention that has been copied widely. Onfido says *within the oval*, Jumio *in the oval frame*.

Sumsub's post-failure suggestion cards are the best failure-copy model: eight cards, each a title plus two to four concrete fixes ("Improve your lighting", "Hold still for a clear image", "Remove sunglasses"). That pattern is what `explainReasons` implements.

Regula localises its hints into 38 languages **including Thai** (`hint.turnHead` → `หันศีรษะเล็กน้อย`).

---

## Motion, haptics, sound

- Persona: state tween 400 ms linear, hint fade 500 ms, direction hint 700 ms; Lottie capture-success 0.833 s.
- Sumsub: `SpringAnimation` with `dampingRatio 0.75`, `stiffness 200` — the only spring physics found.
- Stripe: one 200 ms white flash, peak alpha 0.8, on the first captured sample. That is the whole animation budget.

**Haptics are a convention, not a flourish.** Regula: `setVibrateOnStep(boolean)`, **default true**, 200 ms — the only documented public toggle. Persona: `HapticFeedbackConstants.CONFIRM` on capture. Onfido: one per completed side.

**Sound: zero vendors play audio on capture.** Do not add a shutter sound.

**Reduced motion:** 2 of 15 implement it (Onfido natively, Sumsub WebSDK via a global CSS override).

---

## Accessibility

Three things every well-built SDK does:

1. `accessibilityLiveRegion="polite"` on the instruction, plus an explicit announcement on iOS. **Stripe's Android SDK omits this and TalkBack never announces their state changes** — a real shipped bug.
2. Reserve height for three lines of instruction, bottom-aligned, so the oval does not jump when copy wraps. Stripe iOS does this with `minHeightNumberOfLines = 3`; Stripe Android clamps to `100.dp` and truncates at large font scales. Copy the iOS one.
3. Never encode state in colour alone. Persona always pairs `#A8F3B7` with a check glyph.

Regula's `LivenessProcessStatus` enum (`START · PREPARING · NEW_SESSION · NEXT_STAGE · SECTOR_CHANGED · PROGRESS · LOW_BRIGHTNESS · FIT_FACE · MOVE_AWAY · MOVE_CLOSER · TURN_HEAD · PROCESSING · FAILED · RETRY · SUCCESS`) is the cleanest published state model, and `LivenessState` here mirrors its shape.

---

## Flow

**Document capture always precedes the selfie. No exception across 17 apps** — the selfie's stated purpose is comparison, so it is structurally dependent.

**The face step is three screens: intro → capture → confirm.** Onfido, Sumsub, FaceTec and Persona all ship this triad and all let you disable the intro; Onfido's docs warn *"Removing this screen could lead to confusion and higher drop-off."*

Auto-capture is winning (ZOLOZ, Wise, Incode with a 30 s manual fallback), though Grab deliberately kept a manual Confirm tap.

Most banks do not build any of this: 13 of 17 surveyed apps ship a third-party SDK, so the vendor's defaults *are* the bank's UI, modified by a theme object. Revolut → Onfido, Monzo → Jumio (which is iProov underneath), Cash App and Robinhood → Persona, Alipay → ZOLOZ, N26 → a live human video call. Toss has no custom face screen at all: it delegates to OS biometrics and verifies the ID document *after* opening the account.

ZOLOZ dropped nodding as a challenge because evening users were lying in bed and could not nod. Worth remembering before adding a pitch-based step.
