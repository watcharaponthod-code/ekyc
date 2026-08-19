/**
 * Movement, not pose.
 *
 * The user's complaint that started this: "nod" passed by holding the head
 * tilted. These tests pin the rule that every multi-phase challenge needs a
 * *sequence* of frames, that a single held pose — a person freezing, or a
 * photo held at an angle — never completes it, and that consecutive
 * challenges start from the middle.
 */
import { LivenessSession } from '../src/liveness/LivenessSession'
import { CHALLENGE_DEFAULTS, NodChallenge, OpenMouthChallenge, buildChallenges } from '../src/liveness/challenges'
import type { SessionEvent } from '../src/types'
import { feedFor, signal } from './helpers'

const CENTER_MS = 700
const NOD = CHALLENGE_DEFAULTS.nodMinPitchDelta
const RETURN = NOD * CHALLENGE_DEFAULTS.nodReturnFraction

function start(names: Parameters<typeof buildChallenges>[0], options = {}) {
  const events: SessionEvent[] = []
  const session = new LivenessSession(buildChallenges(names), { holdMs: 300, ...options }, (e) => events.push(e))
  session.start(0)
  return { session, events }
}

describe('nod = away from neutral, then back to it', () => {
  it('a held tilt never completes the step, however long', () => {
    const { session } = start(['nod'])
    let t = feedFor(session, {}, CENTER_MS, 0)
    t = feedFor(session, { pitch: NOD + 6 }, 5000, t) // frozen at +18°
    expect(session.state.stepIndex).toBe(1)
    expect(session.state.stepPhase).toBe(1) // got past phase 1...
    expect(session.state.phase).toBe('running') // ...but never came down
  })

  it('a photo held at a fixed angle from the start never even reaches phase 1', () => {
    // resting pitch +18 is outside the centre gate (12°) → center never completes
    const { session } = start(['nod'])
    feedFor(session, { pitch: NOD + 6 }, 3000, 0)
    expect(session.state.stepIndex).toBe(0)
  })

  it('away ≥ 8° then back to within 3.2° of the resting pitch completes it, from a resting offset', () => {
    const { session, events } = start(['nod'])
    let t = feedFor(session, { pitch: -4 }, CENTER_MS, 0) // resting pitch −4 becomes the baseline
    t = feedFor(session, { pitch: -4 + NOD + 1 }, 200, t) // up
    expect(session.state.stepPhase).toBe(1)
    t = feedFor(session, { pitch: -4 + RETURN + 1 }, 100, t) // on the way back, not there yet
    expect(session.state.phase).toBe('running')
    feedFor(session, { pitch: -4 + RETURN - 0.5 }, 100, t) // back within the return band
    expect(session.state.phase).toBe('uploading')
    expect(events.filter((e) => e.type === 'capture' && e.challenge === 'nod')).toHaveLength(1)
  })

  it('down then back counts equally (device pitch sign is unknown), and past-neutral counts too', () => {
    const a = start(['nod'])
    let t = feedFor(a.session, {}, CENTER_MS, 0)
    t = feedFor(a.session, { pitch: -(NOD + 1) }, 200, t)
    feedFor(a.session, { pitch: 0.5 }, 100, t)
    expect(a.session.state.phase).toBe('uploading')
    // overshooting through neutral to the other side is still "back"
    const b = start(['nod'])
    t = feedFor(b.session, {}, CENTER_MS, 0)
    t = feedFor(b.session, { pitch: NOD + 2 }, 200, t)
    t = feedFor(b.session, { pitch: -(RETURN + 3) }, 100, t) // shot past — not within the band
    expect(b.session.state.phase).toBe('running')
    feedFor(b.session, { pitch: -1 }, 100, t)
    expect(b.session.state.phase).toBe('uploading')
  })

  it('reports each phase in the telemetry', () => {
    const { session } = start(['nod'])
    let t = feedFor(session, {}, CENTER_MS, 0)
    t = feedFor(session, { pitch: NOD + 3 }, 200, t)
    feedFor(session, { pitch: -2 }, 200, t) // came back only 2°
    const m = session.state.stepMetrics
    expect(m['1:nod']).toMatchObject({ phase: 0, needed: NOD })
    expect(m['1:nod']!.best).toBeCloseTo(NOD + 3, 5)
    expect(m['1:nod#1']).toMatchObject({ phase: 1, needed: RETURN, direction: 'below' })
    expect(m['1:nod#1']!.best).toBeCloseTo(2, 5) // came back to within 2° — but only after the phase-2 threshold applied
  })

  it('the challenge itself is stateless: the memo carries the direction', () => {
    const nod = new NodChallenge()
    const memo = {}
    expect(nod.isSatisfied(signal({ pitch: 15 }), signal({}), 0, memo)).toBe(true)
    expect(nod.isSatisfied(signal({ pitch: 15 }), signal({}), 1, memo)).toBe(false) // still up
    expect(nod.isSatisfied(signal({ pitch: RETURN - 0.1 }), signal({}), 1, memo)).toBe(true) // back near neutral
    expect(nod.isSatisfied(signal({ pitch: 1 }), signal({}), 1, {})).toBe(false) // no phase 1 recorded → not a nod
  })
})

describe('blink = closed then open; mouth = open (held) then closed', () => {
  it('eyes shut and kept shut never complete the blink', () => {
    const { session, events } = start(['closeEyes'])
    let t = feedFor(session, {}, CENTER_MS, 0)
    feedFor(session, { leftEye: 0.05, rightEye: 0.05 }, 4000, t)
    expect(session.state.phase).toBe('running')
    expect(session.state.stepPhase).toBe(1)
    // the evidence (shut) frame was still captured immediately
    expect(events.filter((e) => e.type === 'capture' && e.challenge === 'closeEyes')).toHaveLength(1)
  })

  it('an open mouth held forever never completes; opening then closing does', () => {
    const { session, events } = start(['openMouth'])
    let t = feedFor(session, { mouthOpen: 0.03 }, CENTER_MS, 0)
    t = feedFor(session, { mouthOpen: 0.4 }, 3000, t) // wide open, held
    expect(session.state.phase).toBe('running')
    expect(session.state.stepPhase).toBe(1)
    expect(events.filter((e) => e.type === 'capture' && e.challenge === 'openMouth')).toHaveLength(1) // captured mid-hold while open
    feedFor(session, { mouthOpen: 0.05 }, 100, t) // closed again
    expect(session.state.phase).toBe('uploading')
  })

  it('mouth phase 2 threshold is baseline + half the required rise', () => {
    const c = new OpenMouthChallenge()
    const b = signal({ mouthOpen: 0.1 })
    expect(c.isSatisfied(signal({ mouthOpen: 0.1 + CHALLENGE_DEFAULTS.mouthOpenMinDelta * 0.5 }), b, 1)).toBe(true)
    expect(c.isSatisfied(signal({ mouthOpen: 0.1 + CHALLENGE_DEFAULTS.mouthOpenMinDelta * 0.6 }), b, 1)).toBe(false)
  })
})

describe('recenter between challenges', () => {
  it('turn left then turn right requires passing back through the middle', () => {
    const { session } = start(['turnLeft', 'turnRight'])
    let t = feedFor(session, {}, CENTER_MS, 0)
    t = feedFor(session, { yaw: 30 }, 700, t) // left done
    expect(session.state.stepIndex).toBe(2)
    expect(session.state.awaitingRecenter).toBe(true)
    // swinging straight to the right without recentring: ignored
    t = feedFor(session, { yaw: -30 }, 1000, t)
    expect(session.state.stepIndex).toBe(2)
    expect(session.state.awaitingRecenter).toBe(true)
    // back to the middle, then right
    t = feedFor(session, { yaw: 2 }, 100, t)
    expect(session.state.awaitingRecenter).toBe(false)
    feedFor(session, { yaw: -30 }, 700, t)
    expect(session.state.phase).toBe('uploading')
  })

  it('no recenter is demanded straight after center, and it can be switched off', () => {
    const a = start(['turnLeft'])
    let t = feedFor(a.session, {}, CENTER_MS, 0)
    expect(a.session.state.awaitingRecenter).toBe(false)
    feedFor(a.session, { yaw: 30 }, 700, t)
    expect(a.session.state.phase).toBe('uploading')

    const b = start(['turnLeft', 'turnRight'], { requireRecenter: false })
    t = feedFor(b.session, {}, CENTER_MS, 0)
    t = feedFor(b.session, { yaw: 30 }, 700, t)
    feedFor(b.session, { yaw: -30 }, 700, t)
    expect(b.session.state.phase).toBe('uploading')
  })
})
