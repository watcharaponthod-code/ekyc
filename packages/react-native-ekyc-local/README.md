# @ekyc/react-native-ekyc-local

100 % on-device liveness + identity for React Native. **No server, no network,
no biometric data leaves the phone.**

```tsx
import { LocalLivenessCamera } from '@ekyc/react-native-ekyc-local'

<LocalLivenessCamera
  reference={savedEmbedding /* or null */}
  onResult={(r) => (r.passed ? next(r.embedding) : retry(r.reasons))}
  onCancel={() => navigation.goBack()}
/>
```

## What it does

1. **Coaching + challenges** — ML Kit (`react-native-vision-camera-face-detector`)
   drives `center` → a random order of **turn left · turn right · open mouth ·
   nod**, with the same engine and UI as `@ekyc/react-native-ekyc`
   (`LivenessSession`, `FrameOverlay`, `DirectionHint`, Thai/English copy).
2. **One still per pose** — grabbed from the preview the instant the pose is
   held (no shutter lag).
3. **Identity across poses** — each still is re-detected with ML Kit (exact
   face box + roll in the JPEG), cropped/levelled/resized to 112×112 with
   `expo-image-manipulator`, embedded with **MobileFaceNet** (TFLite, 5 MB,
   192-d, bundled in `assets/`) via `react-native-fast-tflite`, and every pair
   of frames is compared. **Pass = the worst pair still looks like the same
   person** — a photo swapped in for one step, or a second person doing the
   turns, fails.
4. **Optional local enrol/verify** — `result.embedding` (the neutral frame) is
   a 192-number template you can store; pass it back as `reference` and the
   next run also checks the neutral frame matches it.

## What it does not do

There is **no presentation-attack detection on the phone** in this package:
a video of the person on a screen that turns, opens its mouth and nods, will
pass. That is by design — "local only" means no PAD model, no server-side
MiniFASNet, no flash, no rPPG. Use it for low-risk step-up (unlock a feature,
confirm the same user is still there), not for onboarding. For anything that
must resist spoofing, use `@ekyc/react-native-ekyc` against the server.

## Thresholds

From MobileFaceNet on an unaligned LFW crop, 40 subjects (2026-08-18):
genuine median 0.59 · p10 0.30; impostor median 0.21 · p95 0.47 · p99 0.56.

| knob | default | meaning |
|---|---|---|
| `consistencyMin` | 0.45 | worst pair across the session's frames must be ≥ this |
| `matchMin` | 0.55 | neutral frame vs `reference` must be ≥ this |

Frames from one session (same light, seconds apart) score far above LFW's
cross-year pairs, so 0.45 leaves room for a turned head. Measure on your
users; the app's result screen prints every pairwise score for exactly that.

## Install

Peer deps: `@ekyc/react-native-ekyc`, `react-native-vision-camera`,
`react-native-vision-camera-face-detector`, `react-native-nitro-modules`,
`react-native-fast-tflite`, `expo-image-manipulator`, `react-native-svg`.
Add `'tflite'` to Metro's `resolver.assetExts` (see `apps/local/metro.config.js`).
Needs a development build — Expo Go cannot load the native modules.

`apps/local` is a complete Expo app around it; its release APK is published on
GitHub Releases.
