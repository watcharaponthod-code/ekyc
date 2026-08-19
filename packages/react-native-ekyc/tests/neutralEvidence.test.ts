import { LivenessSession } from '../src/liveness/LivenessSession'
import { buildChallenges } from '../src/liveness/challenges'
import { laplacianVariance } from '../src/quality/sharpness'
import type { SessionEvent } from '../src/types'
import { feedFor } from './helpers'

const HOLD = { holdMs: 700, captureAtProgress: 0.5, minStepMs: 0 }

function makeSession(verifyNeutral: boolean, maxRetakes = 3) {
  const events: SessionEvent[] = []
  const session = new LivenessSession(buildChallenges(['turnLeft']), { ...HOLD, verifyNeutral, maxRetakes }, (e) => events.push(e))
  session.start(0)
  return { session, events }
}
const captures = (events: SessionEvent[]) => events.filter((e) => e.type === 'capture' && e.stepIndex === 0).length

describe('neutral evidence gate (client-side sharpness retake)', () => {
  it('is off by default: the centre step completes on the hold alone', () => {
    const { session } = makeSession(false)
    feedFor(session, {}, 800, 0)
    expect(session.state.stepIndex).toBe(1)
    expect(session.state.retakes).toBe(0)
  })

  it('when on, the centre step holds until the frame is accepted', () => {
    const { session, events } = makeSession(true)
    let t = feedFor(session, {}, 800, 0)
    expect(captures(events)).toBe(1)
    expect(session.state.stepIndex).toBe(0) // hold done, still waiting for the verdict
    session.acceptEvidence()
    feedFor(session, {}, 50, t)
    expect(session.state.stepIndex).toBe(1)
    expect(session.state.retakes).toBe(0)
  })

  it('a rejected frame is retaken within the same step, and the step completes after acceptance', () => {
    const { session, events } = makeSession(true)
    let t = feedFor(session, {}, 800, 0)
    session.rejectEvidence()
    expect(session.state.retakes).toBe(1)
    expect(session.state.stepIndex).toBe(0)
    t = feedFor(session, {}, 800, t)
    expect(captures(events)).toBe(2) // one more shot
    expect(session.state.stepIndex).toBe(0)
    session.acceptEvidence()
    feedFor(session, {}, 50, t)
    expect(session.state.stepIndex).toBe(1)
  })

  it('never takes a second shot while the first is under review, even if the hold resets', () => {
    const { session, events } = makeSession(true)
    let t = feedFor(session, {}, 400, 0) // captured at 350 ms, pending
    expect(captures(events)).toBe(1)
    t = feedFor(session, { yaw: 40 }, 200, t) // head swings away: hold resets
    t = feedFor(session, {}, 800, t)
    expect(captures(events)).toBe(1)
    session.acceptEvidence()
    feedFor(session, {}, 50, t)
    expect(session.state.stepIndex).toBe(1)
  })

  it('gives up after maxRetakes and lets the server judge', () => {
    const { session, events } = makeSession(true, 2)
    let t = feedFor(session, {}, 800, 0)
    session.rejectEvidence()
    t = feedFor(session, {}, 800, t)
    session.rejectEvidence() // second rejection = maxRetakes
    expect(captures(events)).toBe(2)
    // the hold was not reset this time: the step goes through on the next frame
    feedFor(session, {}, 50, t)
    expect(session.state.stepIndex).toBe(1)
  })
})

describe('laplacianVariance (server metric, JS port)', () => {
  const W = 32
  const H = 32
  it('is ~0 on a flat image and large on a checkerboard', () => {
    const flat = new Float32Array(W * H).fill(120)
    expect(laplacianVariance(flat, W, H)).toBeCloseTo(0, 5)
    const board = new Float32Array(W * H)
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) board[y * W + x] = (x + y) % 2 ? 255 : 0
    expect(laplacianVariance(board, W, H)).toBeGreaterThan(100_000)
  })
  it('drops when the same image is blurred', () => {
    const sharp = new Float32Array(W * H)
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) sharp[y * W + x] = x < W / 2 ? 0 : 255
    const blurred = new Float32Array(W * H)
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) blurred[y * W + x] = Math.max(0, Math.min(255, ((x - W / 2) / 6 + 0.5) * 255))
    expect(laplacianVariance(blurred, W, H)).toBeLessThan(laplacianVariance(sharp, W, H) / 5)
  })
})
