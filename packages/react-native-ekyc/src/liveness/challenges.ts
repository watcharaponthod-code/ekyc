import type { ChallengeName, FaceSignal } from '../types'
import { Challenge } from './Challenge'

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

export type CenterOptions = {
  /** Max |yaw| and |pitch| in degrees that still counts as facing the camera. */
  maxYaw?: number
  maxPitch?: number
}

export type TurnOptions = {
  /** How far the head must rotate, in degrees. */
  minYaw?: number
  yawSign?: 1 | -1
}

export type CloseEyesOptions = {
  /** Mean open-probability of the two eyes must be at or below this. */
  maxEyeOpen?: number
}

export type SmileOptions = {
  minSmile?: number
}

export type NodOptions = {
  /** How far the head must pitch (degrees) from level, either direction. */
  minPitch?: number
}

export type OpenMouthOptions = {
  /** `FaceSignal.mouthOpen` must reach this. Contour gap ratio: 0.3 is a clear open mouth. */
  minMouthOpen?: number
}

/**
 * Face the camera straight on.
 *
 * Always the first step: its captured frame is the `neutral` evidence the
 * server measures every other frame against.
 */
export class CenterChallenge extends Challenge {
  readonly name: ChallengeName = 'center'

  constructor(private readonly options: CenterOptions = {}) {
    super()
  }

  isSatisfied(signal: FaceSignal): boolean {
    const { maxYaw = 12, maxPitch = 12 } = this.options
    return Math.abs(signal.yaw) <= maxYaw && Math.abs(signal.pitch) <= maxPitch
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

  constructor(private readonly options: CloseEyesOptions = {}) {
    super()
  }

  isSatisfied(signal: FaceSignal): boolean {
    // ML Kit's open-probability lags a fast blink and the two eyes rarely
    // bottom out on the same frame, so require the *average* below the
    // threshold rather than both eyes independently. 0.5 accepts a real blink;
    // an open eye reads 0.9+.
    const { maxEyeOpen = 0.5 } = this.options
    return (signal.leftEye + signal.rightEye) / 2 <= maxEyeOpen
  }
}

export class TurnLeftChallenge extends Challenge {
  readonly name: ChallengeName = 'turnLeft'

  constructor(private readonly options: TurnOptions = {}) {
    super()
  }

  isSatisfied(signal: FaceSignal): boolean {
    const { minYaw = 18, yawSign = DEFAULT_YAW_SIGN } = this.options
    return signal.yaw * yawSign <= -minYaw
  }
}

export class TurnRightChallenge extends Challenge {
  readonly name: ChallengeName = 'turnRight'

  constructor(private readonly options: TurnOptions = {}) {
    super()
  }

  isSatisfied(signal: FaceSignal): boolean {
    const { minYaw = 18, yawSign = DEFAULT_YAW_SIGN } = this.options
    return signal.yaw * yawSign >= minYaw
  }
}

export class SmileChallenge extends Challenge {
  readonly name: ChallengeName = 'smile'

  constructor(private readonly options: SmileOptions = {}) {
    super()
  }

  isSatisfied(signal: FaceSignal): boolean {
    const { minSmile = 0.7 } = this.options
    return signal.smile >= minSmile
  }
}

/**
 * Open the mouth.
 *
 * The rigid-mask counter-measure: a 3-D-printed, resin or latex mask cannot
 * open its jaw, and a flexible silicone mask opens far less than the wearer's.
 * The phone only picks the moment; the server verifies `jawOpen` against the
 * neutral frame from MediaPipe blendshapes.
 */
export class OpenMouthChallenge extends Challenge {
  readonly name: ChallengeName = 'openMouth'

  constructor(private readonly options: OpenMouthOptions = {}) {
    super()
  }

  isSatisfied(signal: FaceSignal): boolean {
    const { minMouthOpen = 0.3 } = this.options
    return signal.mouthOpen >= minMouthOpen
  }
}

/**
 * Nod: pitch the head clearly down (or up).
 *
 * Direction-free on purpose, like the turns: ML Kit's pitch sign differs
 * between devices, and what matters for liveness is that the head *moved*
 * on a second axis. Used by the local-only flow; the server never issues it.
 */
export class NodChallenge extends Challenge {
  readonly name: ChallengeName = 'nod'

  constructor(private readonly options: NodOptions = {}) {
    super()
  }

  isSatisfied(signal: FaceSignal): boolean {
    const { minPitch = 15 } = this.options
    return Math.abs(signal.pitch) >= minPitch
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
