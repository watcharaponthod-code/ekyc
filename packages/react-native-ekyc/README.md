# @ekyc/react-native-ekyc

Liveness capture for React Native. The phone runs the interaction; a server makes the decision.

```tsx
import { EKYCCamera, EKYCClient } from '@ekyc/react-native-ekyc'

const client = new EKYCClient({ baseUrl: 'https://ekyc.example.com' })

<EKYCCamera
  client={client}
  purpose="enroll"
  displayName="สมชาย ใจดี"
  onResult={(d) => (d.decision === 'pass' ? next(d.personId) : showRetry(d.reasons))}
  onCancel={() => navigation.goBack()}
/>
```

That is the whole API surface most apps need.

---

## What it does, and what it deliberately does not

**On the phone**
- Front camera, oval framing guide, live coaching ("move closer", "center your face")
- Walks the user through the challenges the *server* chose, in the order the server chose
- Captures one still per step — a snapshot of the preview the instant the pose is confirmed (turns: 120 ms hold; blink: a single frame), so there is no shutter lag to hide
- Uploads the evidence and renders the verdict

**Not on the phone**
- Whether the person is live. Whether it is the right person. The thresholds. The template.

All of that is server-side, because the phone belongs to whoever is holding it. A rooted device or a patched build can make a client-side `liveness = true` say anything; it cannot fabricate photographs that survive server-side re-verification.

The server measures with **MediaPipe** (detection, 478 landmarks, head pose in degrees, eye aspect ratio) and identifies with **DeepFace** (ArcFace embeddings, MiniFASNet anti-spoofing). ML Kit on the phone produces the real-time signal that drives the coaching UI, and nothing else — the server re-derives every number from the pixels. See `docs/superpowers/specs/2026-08-17-ekyc-hybrid-design.md`.

The module stores **no biometric data on the device**.

---

## Install

```sh
npm install @ekyc/react-native-ekyc
```

Publishing it for your team: `npm publish` (set `publishConfig.registry` for a
private registry). `prepare` builds `lib/` first, so Node consumers get compiled
JS plus `.d.ts` through the `exports` map. React Native apps take the
`react-native` condition — `src/index.ts` — and Metro compiles the TypeScript
directly.

That split is not cosmetic. With `main` pointing at `lib/`, a release bundle
silently shipped a `lib/` that had been built *before* three bug fixes, while
debug builds (which resolve `src/`) worked — the two behaved differently and it
took a device to notice. `main` now points at `src/` too, so there is no build
output for Metro to pick up stale.

Peer dependencies (all native, so a development build is required — this does not run in Expo Go):

```sh
npx expo install react-native-vision-camera react-native-vision-camera-face-detector \
  react-native-nitro-modules react-native-nitro-image react-native-svg expo-haptics
```

| Package | Version | Why |
|---|---|---|
| `react-native-vision-camera` | ≥ 5.0 | camera, preview, photo capture |
| `react-native-vision-camera-face-detector` | ≥ 2.0 | ML Kit face signals on the JS thread |
| `react-native-svg` | ≥ 15 | the oval mask and hold ring |
| `expo-haptics` | any | optional — silently skipped if absent |

Declare the camera permission in `app.json`. VisionCamera v5 ships **no Expo
config plugin** — listing one there makes `expo start` and `expo prebuild` fail
outright — so set the platform keys directly:

```json
{
  "expo": {
    "ios":     { "infoPlist": { "NSCameraUsageDescription": "ใช้กล้องหน้าเพื่อยืนยันตัวตนของคุณ" } },
    "android": { "permissions": ["android.permission.CAMERA"] }
  }
}
```

ML Kit ships no arm64 iOS simulator slice, so **test on a physical device**.

---

## Props

| Prop | Type | Notes |
|---|---|---|
| `client` | `EKYCClient` | required |
| `purpose` | `'enroll' \| 'verify' \| 'identify'` | required |
| `personId` | `string` | required when `purpose="verify"` |
| `displayName` | `string` | stored with the enrolment |
| `tier` | `'full' \| 'reduced'` | `reduced` asks one challenge instead of three |
| `locale` | `'th' \| 'en'` | default `'th'` |
| `theme` | `EKYCTheme` | spread `defaultTheme` and override what you need |
| `tuning` | `ChallengeTuning` | detection thresholds, including `yawSign` |
| `onResult` | `(d: Decision) => void` | required; fires on pass **and** fail |
| `onCancel` | `() => void` | back button and the result screen's dismiss |
| `onProgress` | `(s: LivenessState) => void` | for analytics |
| `debug` | `boolean` | overlays live yaw/pitch/eye numbers |

`onResult` is not an error channel. A failed liveness check is a normal outcome and arrives as `{ decision: 'fail', reasons: [...] }`. Only camera, network and permission problems throw, as `EKYCError` with a `code`.

---

## One thing to calibrate

ML Kit's `yawAngle` sign depends on device and mirroring. Run once with `debug`, turn your head left, and see whether yaw goes negative:

```tsx
<EKYCCamera debug ... />                       // read the live numbers
<EKYCCamera tuning={{ turn: { yawSign: -1 } }} ... />   // if they are inverted
```

This only affects which instruction the user sees. The server verifies that the two turns went in *opposite* directions without naming either, so a wrong sign is a confusing prompt, never a security hole.

---

## Composing it yourself

The pieces are exported, so you can build a different flow:

```tsx
import { IntroView, LivenessSession, buildChallenges, FrameOverlay, StepDots } from '@ekyc/react-native-ekyc'
```

`LivenessSession` and the `Challenge` classes are pure TypeScript with no React and no react-native imports — they take a `FaceSignal` per frame and return a `LivenessState`. Every timing decision comes from `signal.t`, never `Date.now()`, so an entire session replays deterministically in a unit test.

---

## Re-verification: no, a face scan alone is never enough

A stored template answers "who is this". It cannot answer "is a person here right now" — that is what liveness is for, and a photograph of you matches your template perfectly. So liveness runs **every time**; only its length changes:

| Situation | Flow |
|---|---|
| Enrolment, new device, profile change | `tier="full"` — three challenges, ~15 s |
| High-value transaction, password change | `tier="reduced"` — one challenge, ~5 s |
| Ordinary app unlock | no face scan — OS biometrics (`expo-local-authentication`) |

This mirrors how the certified vendors work: FaceTec's stored FaceMap deliberately contains no liveness data, precisely so that fresh liveness must be collected before every match.

---

## Testing

```sh
npm test          # 77 tests, no device, no native modules
npm run typecheck
```

---

## Design notes

The visual details come from measuring what shipped identity SDKs actually do, not from taste:

- **oval aspect 1.42** — Persona 1.46, Sumsub 1.443, Veriff 1.50, FaceTec 1.47–1.70
- **near-opaque scrim** — every decompiled native SDK uses one; translucency lets background clutter compete with the instruction
- **a dot per challenge**, state carried by size and glyph as well as colour — a sector ring is for a continuous head sweep, and colour-only state fails colour-blind users
- **hold ring that seals** — four brackets closing into a ring, the clearest way to say "keep holding"
- **haptics on every passed step, and never a shutter sound** — the convention across Persona, Regula and Onfido
- **instruction area reserved for three lines, bottom-aligned** — otherwise the oval jumps when copy wraps
- **`accessibilityLiveRegion` + explicit announcements** — missing from at least one shipped production SDK, which leaves screen-reader users with no feedback at all
- **`prefers-reduced-motion` respected** — only two of fifteen surveyed SDKs do this

## Licence

MIT.
