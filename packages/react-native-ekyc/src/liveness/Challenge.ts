import type { ChallengeName, FaceSignal } from '../types'

/**
 * How far along a challenge the current frame is, in the challenge's own
 * unit — degrees of turn, mouth-gap ratio, eye-open probability. `value` is
 * what the frame shows, `needed` is what would satisfy the step. Reported on
 * every frame so a timeout can say *how close* the user got ("reached 14° of
 * the 22° needed") instead of just "timed out"; that number is what tuning
 * runs on.
 */
export type ChallengeMetric = {
  value: number
  needed: number
  /** Whether *larger* values are better (turn, mouth) or *smaller* (eyes). */
  direction: 'above' | 'below'
}

/**
 * One thing we ask the user to do.
 *
 * A challenge is a *predicate over a single frame* plus the person's own
 * baseline — the frame captured while they looked straight at the camera.
 * Every action is judged as a *change from that baseline* (the server does
 * exactly the same with its neutral frame), so a person whose resting head is
 * turned 8°, or whose mouth rests slightly open, is not penalised. Holds no
 * timing state and no history; `LivenessSession` owns all of that.
 */
export abstract class Challenge {
  abstract readonly name: ChallengeName

  /**
   * True while the user is currently doing the thing. `baseline` is the
   * signal recorded when the `center` step completed, or null before that
   * (and for `center` itself).
   */
  abstract isSatisfied(signal: FaceSignal, baseline?: FaceSignal | null): boolean

  /** Progress in the challenge's own unit; null when the challenge has no scalar. */
  metric(_signal: FaceSignal, _baseline?: FaceSignal | null): ChallengeMetric | null {
    return null
  }

  /**
   * How long the pose must be held, overriding the session's `holdMs`.
   * `0` makes the step an *event*: one confirming frame completes it.
   * `undefined` (the default) means "use the session's hold".
   */
  readonly holdMs?: number
}
