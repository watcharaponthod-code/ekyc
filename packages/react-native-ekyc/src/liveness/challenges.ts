import type { ChallengeName, FaceSignal } from '../types'
import { Challenge, type ChallengeMemo, type ChallengeMetric } from './Challenge'

/**
 * Which way ML Kit's `yawAngle` grows when the user turns to *their own* left.
 *
 * Calibrated on a real Android phone (Android 35, front camera): ML Kit
 * reports **positive** yaw for a turn to the user's left, so `TurnLeft` must
 * accept positive values — hence -1 under the convention below (`yaw * sign
 * <= -minYaw`). Left as a knob because ML Kit's sign has flipped between
 * releases; re-check with `<EKYCCamera debug />` if instructions ever point
 * the wrong way. The web preview's MediaPipe adapter mirrors its yaw so the
 * same value works there.
 *
 * The server does not depend on this at all: it verifies that the two turns
 * went in *opposite* directions without naming either one (see the design
 * spec, "convention-free pose verification"). So getting it wrong costs you a
 * confusing instruction, not a security hole.
 */
export const DEFAULT_YAW_SIGN: 1 | -1 = -1

/**
 * Defaults, and where they come from.
 *
 * None of these is a magic number typed once and forgotten: each mirrors a
 * server rule (documented in `server/app/config.py`) plus a small margin, so
 * the phone confirms a pose only once the server would also accept it. When a
 * session comes from the server, `EKYCCamera` overrides them from the
 * `policy` the server issued (`tuningFromPolicy`), so the two never drift
 * apart. Every value is a *change from the person's own neutral frame*.
 */
export const CHALLENGE_DEFAULTS = {
  /** |yaw| and |pitch| the centre step accepts as "facing the camera". */
  centerMaxYaw: 12,
  centerMaxPitch: 12,
  /** Server: `turn_yaw_min_deg` 22 from neutral. Margin +3 so the mid-hold snapshot clears it. */
  turnMinYawDelta: 25,
  /** Nod, phase 1: pitch excursion from neutral in either direction. Local-only flow (the server never issues `nod`). */
  nodMinPitchDelta: 12,
  /** Nod, phase 2: excursion to the *opposite* side, as a fraction of `nodMinPitchDelta` — up 12° then down ≥ 7.2° = a real nod, ≥ 19° of travel. */
  nodReturnFraction: 0.6,
  /** Mouth: contour gap ratio *rise* over the neutral frame. Server checks jawOpen ≥ 0.35 & Δ ≥ 0.20; the contour ratio runs ~0 shut → 0.3+ open. */
  mouthOpenMinDelta: 0.18,
  /** Fallback when no baseline exists (a host that skips `center`). */
  mouthOpenMinAbsolute: 0.3,
  /** ML Kit mean eye-open probability at or below this = closed. Open reads 0.9+. */
  eyesClosedMaxOpen: 0.5,
  /** Blink, phase 2: eyes must read open again — a shut photo never does. */
  eyesReopenMinOpen: 0.7,
  /** Mouth, phase 2: after the held open frame the gap must fall back to within this fraction of the required rise — a gaping mask/photo never closes. */
  mouthCloseFraction: 0.5,
  smileMin: 0.7,
  /** Smile, phase 2: probability must drop back below this fraction of `smileMin`. */
  smileRelaxFraction: 0.5,
} as const

export type CenterOptions = {
  /** Max |yaw| and |pitch| in degrees that still counts as facing the camera. */
  maxYaw?: number
  maxPitch?: number
}

export type TurnOptions = {
  /** How far the head must rotate from the neutral frame, in degrees. */
  minYaw?: number
  yawSign?: 1 | -1
}

export type CloseEyesOptions = {
  /** Mean open-probability of the two eyes must be at or below this. */
  maxEyeOpen?: number
  /** ...and rise back to at least this afterwards (phase 2). */
  reopenMinOpen?: number
}

export type SmileOptions = {
  minSmile?: number
}

export type NodOptions = {
  /** Pitch excursion from the neutral frame (degrees), either direction, for phase 1. */
  minPitch?: number
  /** Opposite-side excursion for phase 2, as a fraction of `minPitch`. */
  returnFraction?: number
}

export type OpenMouthOptions = {
  /** Rise of `FaceSignal.mouthOpen` over the neutral frame. */
  minDelta?: number
  /** Absolute floor used only when there is no baseline. */
  minMouthOpen?: number
  /** Phase 2: the gap must fall back to baseline + this fraction of the rise. */
  closeFraction?: number
}

/**
 * Face the camera straight on.
 *
 * Always the first step: its captured frame is the `neutral` evidence the
 * server measures every other frame against, and the baseline every later
 * challenge on the phone is judged relative to.
 */
export class CenterChallenge extends Challenge {
  readonly name: ChallengeName = 'center'
  override readonly requiresRecenter = false

  constructor(private readonly options: CenterOptions = {}) {
    super()
  }

  isSatisfied(signal: FaceSignal): boolean {
    const { maxYaw = CHALLENGE_DEFAULTS.centerMaxYaw, maxPitch = CHALLENGE_DEFAULTS.centerMaxPitch } = this.options
    return Math.abs(signal.yaw) <= maxYaw && Math.abs(signal.pitch) <= maxPitch
  }

  override metric(signal: FaceSignal): ChallengeMetric {
    const { maxYaw = CHALLENGE_DEFAULTS.centerMaxYaw } = this.options
    return { value: Math.max(Math.abs(signal.yaw), Math.abs(signal.pitch)), needed: maxYaw, direction: 'below' }
  }
}

/**
 * Blink (or close the eyes).
 *
 * An event, not a hold: one frame with the eyes shut completes the step, so a
 * natural ~150 ms blink is enough. That is only sound because stills are
 * snapshots of the preview surface — grabbed the instant the closed frame is
 * seen, with no shutter lag — and because the *server* re-checks eye
 * closure on that frame against the neutral one. The device merely picks the
 * moment; it proves nothing.
 */
export class CloseEyesChallenge extends Challenge {
  readonly name: ChallengeName = 'closeEyes'
  readonly holdMs = 0
  /** closed → open again. The evidence frame is the closed one. */
  override readonly phaseCount = 2
  override readonly capturePhase = 0

  constructor(private readonly options: CloseEyesOptions = {}) {
    super()
  }

  isSatisfied(signal: FaceSignal, _baseline: FaceSignal | null = null, phase = 0): boolean {
    // ML Kit's open-probability lags a fast blink and the two eyes rarely
    // bottom out on the same frame, so require the *average* below the
    // threshold rather than both eyes independently.
    const { maxEyeOpen = CHALLENGE_DEFAULTS.eyesClosedMaxOpen, reopenMinOpen = CHALLENGE_DEFAULTS.eyesReopenMinOpen } = this.options
    const open = (signal.leftEye + signal.rightEye) / 2
    return phase === 0 ? open <= maxEyeOpen : open >= reopenMinOpen
  }

  override metric(signal: FaceSignal, _baseline: FaceSignal | null = null, phase = 0): ChallengeMetric {
    const { maxEyeOpen = CHALLENGE_DEFAULTS.eyesClosedMaxOpen, reopenMinOpen = CHALLENGE_DEFAULTS.eyesReopenMinOpen } = this.options
    const open = (signal.leftEye + signal.rightEye) / 2
    return phase === 0 ? { value: open, needed: maxEyeOpen, direction: 'below' } : { value: open, needed: reopenMinOpen, direction: 'above' }
  }
}

/** Yaw change from the baseline, positive towards the requested side. */
function turnDelta(signal: FaceSignal, baseline: FaceSignal | null, sign: 1 | -1, towards: 'left' | 'right'): number {
  const delta = signal.yaw - (baseline?.yaw ?? 0)
  return towards === 'left' ? -delta * sign : delta * sign
}

export class TurnLeftChallenge extends Challenge {
  readonly name: ChallengeName = 'turnLeft'

  constructor(private readonly options: TurnOptions = {}) {
    super()
  }

  isSatisfied(signal: FaceSignal, baseline: FaceSignal | null = null): boolean {
    const { minYaw = CHALLENGE_DEFAULTS.turnMinYawDelta, yawSign = DEFAULT_YAW_SIGN } = this.options
    return turnDelta(signal, baseline, yawSign, 'left') >= minYaw
  }

  override metric(signal: FaceSignal, baseline: FaceSignal | null = null): ChallengeMetric {
    const { minYaw = CHALLENGE_DEFAULTS.turnMinYawDelta, yawSign = DEFAULT_YAW_SIGN } = this.options
    return { value: turnDelta(signal, baseline, yawSign, 'left'), needed: minYaw, direction: 'above' }
  }
}

export class TurnRightChallenge extends Challenge {
  readonly name: ChallengeName = 'turnRight'

  constructor(private readonly options: TurnOptions = {}) {
    super()
  }

  isSatisfied(signal: FaceSignal, baseline: FaceSignal | null = null): boolean {
    const { minYaw = CHALLENGE_DEFAULTS.turnMinYawDelta, yawSign = DEFAULT_YAW_SIGN } = this.options
    return turnDelta(signal, baseline, yawSign, 'right') >= minYaw
  }

  override metric(signal: FaceSignal, baseline: FaceSignal | null = null): ChallengeMetric {
    const { minYaw = CHALLENGE_DEFAULTS.turnMinYawDelta, yawSign = DEFAULT_YAW_SIGN } = this.options
    return { value: turnDelta(signal, baseline, yawSign, 'right'), needed: minYaw, direction: 'above' }
  }
}

export class SmileChallenge extends Challenge {
  readonly name: ChallengeName = 'smile'
  /** smile (held, snapshotted) → relax again: a smiling photo never relaxes. */
  override readonly phaseCount = 2
  override readonly capturePhase = 0

  constructor(private readonly options: SmileOptions = {}) {
    super()
  }

  isSatisfied(signal: FaceSignal, _baseline: FaceSignal | null = null, phase = 0): boolean {
    const { minSmile = CHALLENGE_DEFAULTS.smileMin } = this.options
    return phase === 0 ? signal.smile >= minSmile : signal.smile <= minSmile * CHALLENGE_DEFAULTS.smileRelaxFraction
  }

  override metric(signal: FaceSignal, _baseline: FaceSignal | null = null, phase = 0): ChallengeMetric {
    const { minSmile = CHALLENGE_DEFAULTS.smileMin } = this.options
    return phase === 0
      ? { value: signal.smile, needed: minSmile, direction: 'above' }
      : { value: signal.smile, needed: minSmile * CHALLENGE_DEFAULTS.smileRelaxFraction, direction: 'below' }
  }
}

/**
 * Open the mouth — judged as a *rise* over the person's own resting mouth.
 *
 * The rigid-mask counter-measure: a 3-D-printed, resin or latex mask cannot
 * open its jaw, and a flexible silicone mask opens far less than the wearer's.
 * The phone only picks the moment; the server verifies `jawOpen` against the
 * neutral frame from MediaPipe blendshapes.
 */
export class OpenMouthChallenge extends Challenge {
  readonly name: ChallengeName = 'openMouth'
  /** open (held, snapshotted) → closed again. A gaping photo or mask never closes. */
  override readonly phaseCount = 2
  override readonly capturePhase = 0

  constructor(private readonly options: OpenMouthOptions = {}) {
    super()
  }

  private needed(baseline: FaceSignal | null): number {
    const { minDelta = CHALLENGE_DEFAULTS.mouthOpenMinDelta, minMouthOpen = CHALLENGE_DEFAULTS.mouthOpenMinAbsolute } = this.options
    return baseline ? baseline.mouthOpen + minDelta : minMouthOpen
  }

  private closedBelow(baseline: FaceSignal | null): number {
    const { minDelta = CHALLENGE_DEFAULTS.mouthOpenMinDelta, closeFraction = CHALLENGE_DEFAULTS.mouthCloseFraction } = this.options
    const rest = baseline ? baseline.mouthOpen : 0
    return rest + minDelta * closeFraction
  }

  isSatisfied(signal: FaceSignal, baseline: FaceSignal | null = null, phase = 0): boolean {
    return phase === 0 ? signal.mouthOpen >= this.needed(baseline) : signal.mouthOpen <= this.closedBelow(baseline)
  }

  override metric(signal: FaceSignal, baseline: FaceSignal | null = null, phase = 0): ChallengeMetric {
    return phase === 0
      ? { value: signal.mouthOpen, needed: this.needed(baseline), direction: 'above' }
      : { value: signal.mouthOpen, needed: this.closedBelow(baseline), direction: 'below' }
  }
}

/**
 * Nod: pitch the head clearly away from the resting pitch, either direction.
 *
 * Direction-free on purpose, like the turns: ML Kit's pitch sign differs
 * between devices, and what matters for liveness is that the head *moved*
 * on a second axis. Used by the local-only flow; the server never issues it.
 */
export class NodChallenge extends Challenge {
  readonly name: ChallengeName = 'nod'
  /**
   * Phase 1: pitch away from neutral by `minPitch` in either direction (the
   * memo remembers which). Phase 2: pitch to the *opposite* side by
   * `returnFraction · minPitch`. Up-then-down or down-then-up both count —
   * ML Kit's pitch sign differs between devices and what matters is the
   * movement through the resting pose. A held tilt, or a photo held at an
   * angle, never completes phase 2. The evidence frame is the phase-2 frame.
   */
  override readonly phaseCount = 2
  readonly holdMs = 0

  constructor(private readonly options: NodOptions = {}) {
    super()
  }

  isSatisfied(signal: FaceSignal, baseline: FaceSignal | null = null, phase = 0, memo: ChallengeMemo = {}): boolean {
    const { minPitch = CHALLENGE_DEFAULTS.nodMinPitchDelta, returnFraction = CHALLENGE_DEFAULTS.nodReturnFraction } = this.options
    const delta = signal.pitch - (baseline?.pitch ?? 0)
    if (phase === 0) {
      if (Math.abs(delta) < minPitch) return false
      memo.nodSign = Math.sign(delta)
      return true
    }
    const sign = memo.nodSign ?? 0
    if (sign === 0) return false
    return -sign * delta >= minPitch * returnFraction
  }

  override metric(signal: FaceSignal, baseline: FaceSignal | null = null, phase = 0, memo: ChallengeMemo = {}): ChallengeMetric {
    const { minPitch = CHALLENGE_DEFAULTS.nodMinPitchDelta, returnFraction = CHALLENGE_DEFAULTS.nodReturnFraction } = this.options
    const delta = signal.pitch - (baseline?.pitch ?? 0)
    if (phase === 0) return { value: Math.abs(delta), needed: minPitch, direction: 'above' }
    const sign = memo.nodSign ?? 0
    return { value: -sign * delta, needed: minPitch * returnFraction, direction: 'above' }
  }
}

export type ChallengeTuning = {
  center?: CenterOptions
  closeEyes?: CloseEyesOptions
  turn?: TurnOptions
  smile?: SmileOptions
  openMouth?: OpenMouthOptions
  nod?: NodOptions
}

/**
 * The thresholds a server session carries (`SessionPolicy`), turned into
 * challenge tuning: server rule + a margin, so what the phone confirms is what
 * the server will accept. Anything the policy does not carry keeps the local
 * default; explicit `tuning` from the host app wins over both.
 */
export function tuningFromPolicy(
  policy: { turnYawMinDeg?: number; neutralYawMaxDeg?: number } | undefined,
  tuning: ChallengeTuning = {},
): ChallengeTuning {
  if (!policy) return tuning
  const out: ChallengeTuning = { ...tuning }
  if (policy.turnYawMinDeg !== undefined) {
    out.turn = { minYaw: policy.turnYawMinDeg + 3, ...tuning.turn }
  }
  if (policy.neutralYawMaxDeg !== undefined) {
    // The centre gate should be at least as strict as the server's frontal
    // rule, and never looser than the local default.
    out.center = { maxYaw: Math.min(CHALLENGE_DEFAULTS.centerMaxYaw, policy.neutralYawMaxDeg), ...tuning.center }
  }
  return out
}

/**
 * Build the challenge objects for a server-issued list of names.
 *
 * `center` is always prepended — it is the framing gate and the source of the
 * neutral frame — and is stripped from `names` if the server sent it too.
 */
export function buildChallenges(
  names: ChallengeName[],
  tuning: ChallengeTuning = {},
): Challenge[] {
  const rest = names
    .filter((name) => name !== 'center')
    .map((name) => createChallenge(name, tuning))
  return [new CenterChallenge(tuning.center), ...rest]
}

function createChallenge(name: ChallengeName, tuning: ChallengeTuning): Challenge {
  switch (name) {
    case 'closeEyes':
      return new CloseEyesChallenge(tuning.closeEyes)
    case 'turnLeft':
      return new TurnLeftChallenge(tuning.turn)
    case 'turnRight':
      return new TurnRightChallenge(tuning.turn)
    case 'smile':
      return new SmileChallenge(tuning.smile)
    case 'openMouth':
      return new OpenMouthChallenge(tuning.openMouth)
    case 'nod':
      return new NodChallenge(tuning.nod)
    case 'center':
      return new CenterChallenge(tuning.center)
  }
}
