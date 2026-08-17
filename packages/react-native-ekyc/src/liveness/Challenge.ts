import type { ChallengeName, FaceSignal } from '../types'

/**
 * One thing we ask the user to do.
 *
 * A challenge is a *predicate over a single frame* — nothing more. It holds no
 * timing state and no history; `LivenessSession` owns all of that. That split
 * is what makes both pieces trivial to test.
 */
export abstract class Challenge {
  abstract readonly name: ChallengeName

  /** True while the user is currently doing the thing. */
  abstract isSatisfied(signal: FaceSignal): boolean

  /**
   * How long the pose must be held, overriding the session's `holdMs`.
   * `0` makes the step an *event*: one confirming frame completes it.
   * `undefined` (the default) means "use the session's hold".
   */
  readonly holdMs?: number
}
