import { LivenessSession } from '../src/liveness/LivenessSession'
import { buildChallenges } from '../src/liveness/challenges'
import type { SessionEvent } from '../src/types'
import { feedFor, signal } from './helpers'

// Tests pin the *mechanism*, so they fix the hold length instead of inheriting
// the product default (which is tuned on real devices and may move).
const HOLD = { holdMs: 700, captureAtProgress: 0.5, minStepMs: 0 }

function makeSession(
  names: Parameters<typeof buildChallenges>[0] = ['closeEyes', 'turnLeft'],
  options: Partial<typeof HOLD> = {},
) {
  const events: SessionEvent[] = []
  const session = new LivenessSession(buildChallenges(names), { ...HOLD, ...options }, (e) => events.push(e))
  session.start(0)
  return { session, events }
}

const CENTERED = {}
const EYES_SHUT = { leftEye: 0.05, rightEye: 0.05 }
const TURNED_LEFT = { yaw: 30 } // positive = user's left, per the calibrated default sign

describe('LivenessSession — happy path', () => {
  it('walks every step and completes', () => {
    const { session, events } = makeSession()

    let t = feedFor(session, CENTERED, 800, 0)
    expect(session.state.stepIndex).toBe(1)
    expect(session.state.challenge).toBe('closeEyes')

    t = feedFor(session, EYES_SHUT, 800, t)
    expect(session.state.stepIndex).toBe(2)
    expect(session.state.challenge).toBe('turnLeft')

    feedFor(session, TURNED_LEFT, 800, t)
    expect(session.state.phase).toBe('uploading')
    expect(events.at(-1)).toEqual({ type: 'complete' })
  })

  it('emits exactly one capture per step, mid-hold', () => {
    const { session, events } = makeSession(['closeEyes'])

    let t = feedFor(session, CENTERED, 800, 0)
    t = feedFor(session, EYES_SHUT, 800, t)

    const captures = events.filter((e) => e.type === 'capture')
    expect(captures).toEqual([
      { type: 'capture', challenge: 'center', stepIndex: 0 },
      { type: 'capture', challenge: 'closeEyes', stepIndex: 1 },
    ])
  })

  it('captures before the step completes, so the pose is still held', () => {
    const { session, events } = makeSession(['closeEyes'])
    feedFor(session, CENTERED, 800, 0)

    const order = events.map((e) => e.type)
    expect(order.indexOf('capture')).toBeLessThan(order.indexOf('stepComplete'))
  })

  it('reports hold progress between 0 and 1', () => {
    const { session } = makeSession(['closeEyes'])
    feedFor(session, CENTERED, 300, 0)
    const progress = session.state.holdProgress
    expect(progress).toBeGreaterThan(0.2)
    expect(progress).toBeLessThan(1)
  })
})

describe('LivenessSession — hold discipline', () => {
  it('rewinds the hold when the pose breaks', () => {
    const { session } = makeSession(['turnLeft'])
    feedFor(session, CENTERED, 800, 0)

    let t = feedFor(session, TURNED_LEFT, 400, 800)
    expect(session.state.holdProgress).toBeGreaterThan(0.4)

    // head back to centre — progress must collapse, step must not complete
    session.feed(signal({ t: (t += 33) }))
    expect(session.state.holdProgress).toBe(0)
    expect(session.state.stepIndex).toBe(1)
  })

  it('re-captures after a broken hold rather than trusting the stale photo', () => {
    const { session, events } = makeSession(['turnLeft'])
    feedFor(session, CENTERED, 800, 0)

    let t = feedFor(session, TURNED_LEFT, 400, 800)
    session.feed(signal({ t: (t += 33) })) // break
    feedFor(session, TURNED_LEFT, 800, t)

    const captures = events.filter((e) => e.type === 'capture' && e.challenge === 'turnLeft')
    expect(captures.length).toBe(2)
  })

  it('ignores a pose held in the first minStepMs of a step (server would call it implausible)', () => {
    const { session, events } = makeSession(['turnLeft'], { minStepMs: 250 })
    const t = feedFor(session, CENTERED, 800, 0)
    // already turned when the step begins: nothing counts until 250 ms in
    feedFor(session, TURNED_LEFT, 240, t)
    expect(events.filter((e) => e.type === 'capture' && e.challenge === 'turnLeft').length).toBe(0)
    expect(session.state.holdProgress).toBe(0)
  })

  it('treats a challenge with holdMs 0 as an event: one frame captures and completes it', () => {
    const { session, events } = makeSession(['closeEyes', 'turnLeft'])
    const t = feedFor(session, CENTERED, 800, 0)
    expect(session.state.challenge).toBe('closeEyes')

    session.feed(signal({ ...EYES_SHUT, t: t + 300 })) // a single blink frame, past minStepMs

    expect(events.filter((e) => e.type === 'capture' && e.challenge === 'closeEyes').length).toBe(1)
    expect(events.some((e) => e.type === 'stepComplete' && e.challenge === 'closeEyes')).toBe(true)
    expect(session.state.challenge).toBe('turnLeft')
  })

  it('does not advance while framing is bad, even with a satisfied pose', () => {
    const { session } = makeSession(['closeEyes'])
    feedFor(session, { ...CENTERED, box: { x: 0.45, y: 0.45, w: 0.1, h: 0.1 } }, 2000, 0)
    expect(session.state.stepIndex).toBe(0)
    expect(session.state.framing).toBe('tooFar')
  })
})

describe('LivenessSession — framing', () => {
  const cases: [string, Parameters<typeof signal>[0], string][] = [
    ['no face', { count: 0 }, 'noFace'],
    ['two faces', { count: 2 }, 'multipleFaces'],
    ['too far', { box: { x: 0.45, y: 0.45, w: 0.1, h: 0.1 } }, 'tooFar'],
    ['too close', { box: { x: 0.05, y: 0.05, w: 0.9, h: 0.9 } }, 'tooClose'],
    ['off centre', { box: { x: 0.0, y: 0.0, w: 0.4, h: 0.4 } }, 'offCentre'],
    ['well framed', {}, 'ok'],
  ]

  it.each(cases)('classifies %s', (_label, overrides, expected) => {
    const { session } = makeSession(['closeEyes'])
    session.feed(signal({ ...overrides, t: 33 }))
    expect(session.state.framing).toBe(expected)
  })

  it('ignores head pose when judging framing', () => {
    const { session } = makeSession(['turnLeft'])
    session.feed(signal({ yaw: -40, t: 33 }))
    expect(session.state.framing).toBe('ok')
  })
})

describe('LivenessSession — failures', () => {
  it('tolerates a brief face loss', () => {
    const { session } = makeSession(['closeEyes'])
    feedFor(session, { count: 0 }, 3000, 0)
    expect(session.state.phase).toBe('running')
  })

  it('fails when the face is gone past the grace period', () => {
    const { session, events } = makeSession(['closeEyes'])
    feedFor(session, { count: 0 }, 5000, 0)
    expect(session.state.phase).toBe('failed')
    expect(session.state.reason).toBe('faceLost')
    expect(events.at(-1)).toEqual({ type: 'failed', reason: 'faceLost' })
  })

  it('fails with its own reason when a second face lingers', () => {
    const { session } = makeSession(['closeEyes'])
    feedFor(session, { count: 2 }, 5000, 0)
    expect(session.state.reason).toBe('multipleFaces')
  })

  it('restarts the grace clock when the failure mode changes', () => {
    const { session } = makeSession(['closeEyes'])
    let t = feedFor(session, { count: 0 }, 3000, 0)
    t = feedFor(session, { count: 2 }, 3000, t)
    expect(session.state.phase).toBe('running')
  })

  it('times out a step the user never performs', () => {
    const { session } = makeSession(['closeEyes'])
    let t = feedFor(session, CENTERED, 800, 0)
    feedFor(session, {}, 13_000, t)
    expect(session.state.phase).toBe('failed')
    expect(session.state.reason).toBe('timeout')
  })

  it('times out the whole session', () => {
    const { session } = makeSession(['closeEyes'])
    // stay well framed but never satisfy, with a generous per-step budget
    const s = new LivenessSession(buildChallenges(['closeEyes']), { ...HOLD, perStepTimeoutMs: 999_000 })
    s.start(0)
    feedFor(s, { yaw: 40 }, 61_000, 0)
    expect(s.state.phase).toBe('failed')
    expect(s.state.reason).toBe('timeout')
    expect(session.state.phase).toBe('running')
  })

  it('ignores frames once it has failed', () => {
    const { session, events } = makeSession(['closeEyes'])
    feedFor(session, { count: 0 }, 5000, 0)
    const after = events.length
    feedFor(session, CENTERED, 2000, 6000)
    expect(events.length).toBe(after)
    expect(session.state.phase).toBe('failed')
  })

  it('can be aborted by the caller', () => {
    const { session } = makeSession()
    session.abort('cancelled')
    expect(session.state.phase).toBe('failed')
    expect(session.state.reason).toBe('cancelled')
  })

  it('does not resurrect a finished session on abort', () => {
    const { session } = makeSession(['closeEyes'])
    feedFor(session, CENTERED, 800, 0)
    session.notifyResult(true)
    session.abort('cancelled')
    expect(session.state.phase).toBe('passed')
  })
})

describe('LivenessSession — clock hygiene', () => {
  it('caps a huge frame gap so a stalled camera cannot fake a hold', () => {
    const session = new LivenessSession(buildChallenges([]), { ...HOLD, perStepTimeoutMs: 999_000 })
    session.start(0)
    session.feed(signal({ t: 10_000 }))
    expect(session.state.holdProgress).toBeLessThan(1)
    expect(session.state.stepIndex).toBe(0)
  })

  it('ignores out-of-order timestamps instead of going backwards', () => {
    const session = new LivenessSession(buildChallenges([]), HOLD)
    session.start(0)
    session.feed(signal({ t: 300 }))
    const before = session.state.holdProgress
    session.feed(signal({ t: 100 }))
    expect(session.state.holdProgress).toBe(before)
  })
})

describe('LivenessSession — result reporting', () => {
  it('moves to uploading and then to the server verdict', () => {
    const { session } = makeSession(['closeEyes'])
    let t = feedFor(session, CENTERED, 800, 0)
    feedFor(session, EYES_SHUT, 800, t)
    expect(session.state.phase).toBe('uploading')

    session.notifyResult(false, 'captureFailed')
    expect(session.state.phase).toBe('failed')
    expect(session.state.reason).toBe('captureFailed')
  })

  it('rejects an empty challenge list rather than silently passing', () => {
    expect(() => new LivenessSession([])).toThrow(/at least one challenge/)
  })
})
