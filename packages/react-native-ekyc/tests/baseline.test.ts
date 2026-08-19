/**
 * Baseline-relative challenges + step telemetry.
 *
 * The whole point: a person whose resting head is turned 8°, or whose mouth
 * rests slightly open, is judged on the *change* they make, and when a step
 * times out the session says how close they got.
 */
import { LivenessSession } from '../src/liveness/LivenessSession'
import {
  CHALLENGE_DEFAULTS,
  CenterChallenge,
  NodChallenge,
  OpenMouthChallenge,
  TurnLeftChallenge,
  TurnRightChallenge,
  buildChallenges,
  tuningFromPolicy,
} from '../src/liveness/challenges'
import type { SessionEvent } from '../src/types'
import { feedFor, signal } from './helpers'

const SIGN = -1 // DEFAULT_YAW_SIGN: user's left = positive yaw

describe('turns are measured from the neutral baseline', () => {
  it('a resting offset of +8° does not help or hinder the turn', () => {
    const left = new TurnLeftChallenge()
    const baseline = signal({ yaw: 8 })
    // 8 + 25 = 33 → exactly the needed delta
    expect(left.isSatisfied(signal({ yaw: 33 * (SIGN === -1 ? 1 : -1) }), baseline)).toBe(true)
    // 30° absolute is only 22° from an 8° baseline → not yet
    expect(left.isSatisfied(signal({ yaw: 30 }), baseline)).toBe(false)
    // and turning the wrong way never counts
    expect(new TurnRightChallenge().isSatisfied(signal({ yaw: 40 }), baseline)).toBe(false)
  })
  it('without a baseline the absolute yaw is used', () => {
    expect(new TurnLeftChallenge().isSatisfied(signal({ yaw: 26 }))).toBe(true)
    expect(new TurnLeftChallenge().isSatisfied(signal({ yaw: 20 }))).toBe(false)
  })
})

describe('mouth and nod are relative too', () => {
  it('open mouth is a rise over the resting mouth', () => {
    const c = new OpenMouthChallenge()
    const restingOpen = signal({ mouthOpen: 0.15 }) // some people rest with parted lips
    expect(c.isSatisfied(signal({ mouthOpen: 0.3 }), restingOpen)).toBe(false) // only +0.15
    expect(c.isSatisfied(signal({ mouthOpen: 0.15 + CHALLENGE_DEFAULTS.mouthOpenMinDelta }), restingOpen)).toBe(true)
    // no baseline → absolute floor
    expect(c.isSatisfied(signal({ mouthOpen: 0.3 }))).toBe(true)
  })
  it('nod is a pitch change from the resting pitch, either direction', () => {
    const c = new NodChallenge()
    const b = signal({ pitch: -6 })
    expect(c.isSatisfied(signal({ pitch: -6 + 12 }), b)).toBe(true)
    expect(c.isSatisfied(signal({ pitch: -6 - 12 }), b)).toBe(true)
    expect(c.isSatisfied(signal({ pitch: 4 }), b)).toBe(false) // only 10 from -6
  })
})

describe('LivenessSession records the baseline and per-step telemetry', () => {
  it('captures the centre frame as baseline and judges the turn from it', () => {
    const events: SessionEvent[] = []
    const session = new LivenessSession(buildChallenges(['turnLeft']), { holdMs: 300 }, (e) => events.push(e))
    session.start(0)
    // resting head at +8° yaw (within the 12° centre gate)
    let t = feedFor(session, { yaw: 8 }, 700, 0)
    expect(session.state.stepIndex).toBe(1)
    expect(session.neutralBaseline?.yaw).toBe(8)
    // 30° absolute is only 22° from baseline: not enough
    t = feedFor(session, { yaw: 30 }, 700, t)
    expect(session.state.stepIndex).toBe(1)
    const m = session.state.stepMetrics['1:turnLeft']!
    expect(m.best).toBeCloseTo(22, 5)
    expect(m.needed).toBe(CHALLENGE_DEFAULTS.turnMinYawDelta)
    // 34° absolute = 26° from baseline: done
    feedFor(session, { yaw: 34 }, 700, t)
    expect(session.state.phase).toBe('uploading')
  })

  it('a timeout reports how close the step got', () => {
    const events: SessionEvent[] = []
    const session = new LivenessSession(buildChallenges(['openMouth']), { holdMs: 300, perStepTimeoutMs: 2000 }, (e) => events.push(e))
    session.start(0)
    let t = feedFor(session, { mouthOpen: 0.05 }, 700, 0)
    // opens only a little, never enough
    t = feedFor(session, { mouthOpen: 0.15 }, 2500, t)
    expect(session.state.phase).toBe('failed')
    const failed = events.at(-1)
    expect(failed).toMatchObject({ type: 'failed', reason: 'timeout', stepIndex: 1, challenge: 'openMouth' })
    if (failed?.type === 'failed') {
      const m = failed.stepMetrics['1:openMouth']!
      expect(m.best).toBeCloseTo(0.15, 5)
      expect(m.needed).toBeCloseTo(0.05 + CHALLENGE_DEFAULTS.mouthOpenMinDelta, 5)
    }
  })

  it('centre metric is the max head angle and counts down', () => {
    const c = new CenterChallenge()
    expect(c.metric(signal({ yaw: 5, pitch: -9 }))).toEqual({ value: 9, needed: CHALLENGE_DEFAULTS.centerMaxYaw, direction: 'below' })
  })
})

describe('tuningFromPolicy', () => {
  it('derives the turn threshold from the server rule plus a margin, host tuning wins', () => {
    const t = tuningFromPolicy({ turnYawMinDeg: 22, neutralYawMaxDeg: 25 })
    expect(t.turn?.minYaw).toBe(25)
    expect(t.center?.maxYaw).toBe(12) // never looser than the local default
    expect(tuningFromPolicy({ turnYawMinDeg: 22 }, { turn: { minYaw: 30 } }).turn?.minYaw).toBe(30)
    expect(tuningFromPolicy(undefined, { nod: { minPitch: 9 } })).toEqual({ nod: { minPitch: 9 } })
  })
})
