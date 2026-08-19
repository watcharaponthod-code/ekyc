/**
 * `@ekyc/react-native-ekyc-local`
 *
 * 100 % on-device liveness, light edition: ML Kit drives turn-left /
 * turn-right / open-mouth / move-closer / move-farther as movements from the
 * person's own neutral pose, with a face-continuity check across the run.
 * No network, no model, no image processing — the verdict is the sequence.
 *
 * ```tsx
 * <LocalLivenessCamera onResult={(r) => (r.passed ? next() : retry(r.reasons))} />
 * ```
 *
 * The MobileFaceNet + rPPG edition is under `@ekyc/react-native-ekyc-local/heavy`.
 */
export { LocalLivenessCamera } from './LocalLivenessCamera'
export type { ContinuityRule, LocalLivenessCameraProps, LocalResult, SessionReport } from './LocalLivenessCamera'
export { ContinuityTracker, DEFAULT_CONTINUITY } from './continuity'
export type { ContinuityOptions, ContinuityReport } from './continuity'
export { LOCAL_CHALLENGES, pickLocalChallenges } from './challenges'
