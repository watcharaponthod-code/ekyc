import { mouthOpenness } from '../src/liveness/mouth'
import { OpenMouthChallenge, buildChallenges } from '../src/liveness/challenges'
import { signal } from './helpers'

function lips(gap: number, width = 100, y = 300) {
  // upper lip bottom edge at y, lower lip top edge at y + gap, mouth `width` px wide
  const row = (yy: number) => Array.from({ length: 5 }, (_, i) => ({ x: 100 + (i * width) / 4, y: yy }))
  return {
    UPPER_LIP_TOP: row(y - 10),
    UPPER_LIP_BOTTOM: row(y),
    LOWER_LIP_TOP: row(y + gap),
    LOWER_LIP_BOTTOM: row(y + gap + 10),
  }
}

describe('mouthOpenness', () => {
  it('reads ~0 with the lips together and the gap ratio when open, from contours', () => {
    expect(mouthOpenness({ contours: lips(0) })).toBeCloseTo(0, 3)
    expect(mouthOpenness({ contours: lips(40) })).toBeCloseTo(0.4, 3)
  })

  it('is independent of the distance to the camera (scale-free)', () => {
    const near = mouthOpenness({ contours: lips(60, 200) })
    const far = mouthOpenness({ contours: lips(30, 100) })
    expect(near).toBeCloseTo(far, 5)
  })

  it('falls back to landmarks when contours are missing', () => {
    const shut = { landmarks: { NOSE_BASE: { x: 150, y: 200 }, MOUTH_BOTTOM: { x: 150, y: 255 }, MOUTH_LEFT: { x: 100, y: 240 }, MOUTH_RIGHT: { x: 200, y: 240 } } }
    const open = { landmarks: { NOSE_BASE: { x: 150, y: 200 }, MOUTH_BOTTOM: { x: 150, y: 300 }, MOUTH_LEFT: { x: 100, y: 240 }, MOUTH_RIGHT: { x: 200, y: 240 } } }
    expect(mouthOpenness(shut)).toBeLessThan(0.05)
    expect(mouthOpenness(open)).toBeGreaterThan(0.3)
  })

  it('never goes negative and is 0 with no geometry at all', () => {
    expect(mouthOpenness({})).toBe(0)
    expect(mouthOpenness({ contours: lips(-20) })).toBe(0)
  })
})

describe('OpenMouthChallenge', () => {
  it('needs a clearly open mouth', () => {
    const challenge = new OpenMouthChallenge()
    expect(challenge.isSatisfied(signal({ mouthOpen: 0.05 }))).toBe(false)
    expect(challenge.isSatisfied(signal({ mouthOpen: 0.45 }))).toBe(true)
  })

  it('is a hold, not an event, and honours tuning', () => {
    const challenge = new OpenMouthChallenge({ minMouthOpen: 0.6 })
    expect(challenge.holdMs).toBeUndefined()
    expect(challenge.isSatisfied(signal({ mouthOpen: 0.45 }))).toBe(false)
  })

  it('is built from the server-issued name', () => {
    const built = buildChallenges(['openMouth', 'turnLeft'])
    expect(built.map((c) => c.name)).toEqual(['center', 'openMouth', 'turnLeft'])
    expect(built[1]).toBeInstanceOf(OpenMouthChallenge)
  })
})
