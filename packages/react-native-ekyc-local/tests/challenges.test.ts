// Straight from the core source: the package barrel pulls in react-native UI.
import { NodChallenge } from '../../react-native-ekyc/src/liveness/challenges'

import { LOCAL_ALWAYS, LOCAL_CHALLENGES, pickLocalChallenges } from '../src/challenges'

function seeded(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return s / 4294967296
  }
}

describe('pickLocalChallenges', () => {
  it('mirrors the server policy: openMouth always, three more at random, no repeats', () => {
    for (let i = 0; i < 20; i++) {
      const picked = pickLocalChallenges(undefined, seeded(i + 1))
      expect(picked).toHaveLength(4)
      expect(picked).toContain(LOCAL_ALWAYS)
      expect(new Set(picked).size).toBe(4)
      for (const c of picked) expect(LOCAL_CHALLENGES).toContain(c)
    }
    expect(LOCAL_CHALLENGES).toEqual(['closeEyes', 'turnLeft', 'turnRight', 'openMouth', 'moveCloser', 'moveFarther'])
  })
  it('the order varies between runs', () => {
    const orders = new Set(Array.from({ length: 30 }, (_, i) => pickLocalChallenges(undefined, seeded(i + 1)).join(',')))
    expect(orders.size).toBeGreaterThan(3)
  })
  it('clamps the count', () => {
    expect(pickLocalChallenges(0)).toEqual(['openMouth'])
    expect(pickLocalChallenges(9)).toHaveLength(6)
  })
})

describe('NodChallenge (from the core module)', () => {
  const base = {
    count: 1,
    yaw: 0,
    roll: 0,
    leftEye: 0.9,
    rightEye: 0.9,
    smile: 0,
    mouthOpen: 0,
    box: { x: 0.3, y: 0.3, w: 0.4, h: 0.4 },
    t: 0,
  }
  it('accepts a clear pitch in either direction and rejects level', () => {
    const nod = new NodChallenge()
    expect(nod.isSatisfied({ ...base, pitch: -20 })).toBe(true)
    expect(nod.isSatisfied({ ...base, pitch: 20 })).toBe(true)
    expect(nod.isSatisfied({ ...base, pitch: 5 })).toBe(false)
  })
})
