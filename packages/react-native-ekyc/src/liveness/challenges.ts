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
  /** Both eyes must be below this open-probability. */
  maxEyeOpen?: number
}

export type SmileOptions = {
  minSmile?: number
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
 * Close both eyes and hold.
 *
 * Deliberately not "blink": a blink lasts ~150 ms and `takePhoto()` has
 * 150–400 ms of shutter lag, so a blink would be missed systematically. A held
 * eyes-closed pose is also stronger evidence — a printed photo cannot do it.
 */
export class CloseEyesChallenge extends Challenge {
  readonly name: ChallengeName = 'closeEyes'

  constructor(private readonly options: CloseEyesOptions = {}) {
    super()
  }

  isSatisfied(signal: FaceSignal): boolean {
    const { maxEyeOpen = 0.3 } = this.options
    return signal.leftEye <= maxEyeOpen && signal.rightEye <= maxEyeOpen
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

export type ChallengeTuning = {
  center?: CenterOptions
  closeEyes?: CloseEyesOptions
  turn?: TurnOptions
  smile?: SmileOptions
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
    case 'center':
      return new CenterChallenge(tuning.center)
  }
}
