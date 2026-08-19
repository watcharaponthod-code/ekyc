import type { ChallengeName, FaceSignal } from '../types'

/**
 * How far along a challenge the current frame is, in the challenge's own
 * unit — degrees of turn, mouth-gap ratio, eye-open probability. `value` is
 * what the frame shows, `needed` is what would satisfy the current phase.
 * Reported on every frame so a timeout can say *how close* the user got
 * ("reached 14° of the 22° needed") instead of just "timed out"; that number
 * is what tuning runs on.
 */
export type ChallengeMetric = {
  value: number
  needed: number
  /** Whether *larger* values are better (turn, mouth) or *smaller* (eyes). */
  direction: 'above' | 'below'
}

/**
 * Scratch space a multi-phase challenge may write to while a step runs — e.g.
 * which way the head went first, so the second phase can demand the opposite.
 * Owned and reset by `LivenessSession` per step; challenges stay stateless.
 */
export type ChallengeMemo = Record<string, number>

/**
 * One thing we ask the user to do.
 *
 * A challenge is a predicate over a single frame plus the person's own
 * baseline — the frame captured while they looked straight at the camera.
 * Every action is judged as a *change from that baseline* (the server does
 * exactly the same with its neutral frame), so a person whose resting head is
 * turned 8°, or whose mouth rests slightly open, is not penalised.
 *
 * A challenge may have several **phases** that must be satisfied in order —
 * a nod is "pitch up, then pitch down", a blink is "closed, then open again",
 * an open mouth is "open (held), then closed". Phases are what make a step a
 * *movement* rather than a pose: no single frame, and no still photo held at
 * an angle, satisfies a two-phase challenge. The session tracks the phase;
 * the challenge only answers "does this frame satisfy phase N?".
 */
export abstract class Challenge {
  abstract readonly name: ChallengeName

  /** Number of phases; 1 = a plain pose. */
  readonly phaseCount: number = 1

  /**
   * Which phase yields the evidence frame (the one snapshotted and, for the
   * server flow, uploaded under this challenge's name). The session's hold
   * applies to this phase; the others are events. Defaults to the last phase.
   */
  readonly capturePhase?: number

  /**
   * Whether the head must come back to the neutral pose before this step
   * starts counting. True for everything but `center`: it turns "left then
   * right" into two movements through the middle instead of one long swing,
   * and it means a step can never begin from the pose the previous one ended in.
   */
  readonly requiresRecenter: boolean = true

  /**
   * True while the frame satisfies `phase` of the challenge. `baseline` is the
   * signal recorded when the `center` step completed, or null before that.
   */
  abstract isSatisfied(signal: FaceSignal, baseline?: FaceSignal | null, phase?: number, memo?: ChallengeMemo): boolean

  /** Progress of `phase` in the challenge's own unit; null when it has no scalar. */
  metric(_signal: FaceSignal, _baseline?: FaceSignal | null, _phase?: number, _memo?: ChallengeMemo): ChallengeMetric | null {
    return null
  }

  /**
   * How long the capture phase must be held, overriding the session's
   * `holdMs`. `0` makes it an *event*: one confirming frame completes it.
   * `undefined` (the default) means "use the session's hold".
   */
  readonly holdMs?: number
}
