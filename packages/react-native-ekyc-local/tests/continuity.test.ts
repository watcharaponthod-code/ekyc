import { ContinuityTracker, DEFAULT_CONTINUITY } from '../src/continuity'
import { signal } from './helpers'

function feed(tracker: ContinuityTracker, frames: { t: number; count?: number; x?: number; y?: number }[]) {
  for (const f of frames) tracker.feed(signal({ t: f.t, count: f.count ?? 1, box: { x: (f.x ?? 0.3) , y: (f.y ?? 0.3), w: 0.4, h: 0.5 } }))
}

describe('ContinuityTracker', () => {
  it('a face that stays and moves smoothly is continuous', () => {
    const tr = new ContinuityTracker()
    feed(tr, Array.from({ length: 60 }, (_, i) => ({ t: i * 66, x: 0.3 + 0.002 * i })))
    const r = tr.report(60 * 66)
    expect(r.ok).toBe(true)
    expect(r.gaps).toBe(0)
    expect(r.jumps).toBe(0)
    expect(r.frames).toBe(60)
    expect(r.maxJump).toBeLessThan(0.01)
  })

  it('a short dropout at a hard turn is tolerated; a long one is a gap', () => {
    const tr = new ContinuityTracker()
    feed(tr, [{ t: 0 }, { t: 66 }, { t: 132, count: 0 }, { t: 900, count: 0 }, { t: 1000 }])
    expect(tr.report(1000).ok).toBe(true)
    expect(tr.report(1000).maxGapMs).toBe(1000 - 132)
    const long = new ContinuityTracker()
    feed(long, [{ t: 0 }, { t: 66, count: 0 }, { t: 2000 }])
    const r = long.report(2000)
    expect(r.gaps).toBe(1)
    expect(r.ok).toBe(false)
  })

  it('a swap shows as a jump: the face teleports between consecutive frames', () => {
    const tr = new ContinuityTracker()
    feed(tr, [{ t: 0, x: 0.05, y: 0.1 }, { t: 66, x: 0.05, y: 0.1 }, { t: 132, x: 0.55, y: 0.5 }])
    const r = tr.report(132)
    expect(r.jumps).toBe(1)
    expect(r.ok).toBe(false)
    expect(r.maxJump).toBeGreaterThan(DEFAULT_CONTINUITY.maxJump)
  })

  it('a session ending with no face counts the trailing gap', () => {
    const tr = new ContinuityTracker()
    feed(tr, [{ t: 0 }, { t: 66, count: 0 }])
    expect(tr.report(66 + 5000).gaps).toBe(1)
    expect(tr.report(66 + 500).gaps).toBe(0)
  })
})
