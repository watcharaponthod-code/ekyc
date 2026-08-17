import { explainReasons, instructionFor, strings } from '../src/ui/copy'
import { hasVisualHint, hintSide } from '../src/ui/hints'
import { defaultTheme, ellipsePerimeter, frameGeometry, holdRingDash } from '../src/ui/theme'

describe('frameGeometry', () => {
  it('centres the oval horizontally and lifts it slightly', () => {
    const g = frameGeometry(390, 844)
    expect(g.cx).toBe(195)
    expect(g.cy).toBeLessThan(422)
    expect(g.cy).toBeGreaterThan(844 * 0.35)
  })

  it('keeps the researched 1.42 face aspect', () => {
    const g = frameGeometry(390, 844)
    expect(g.ry / g.rx).toBeCloseTo(defaultTheme.frame.aspect, 5)
  })

  it('leaves the oval comfortably inside the screen on a small phone', () => {
    const g = frameGeometry(320, 568)
    expect(g.cx - g.rx).toBeGreaterThan(0)
    expect(g.cx + g.rx).toBeLessThan(320)
  })

  it('puts the hold ring outside the oval border', () => {
    const g = frameGeometry(390, 844)
    expect(g.ringRx).toBeGreaterThan(g.rx)
    expect(g.ringRy).toBeGreaterThan(g.ry)
  })

  it('scales with the screen', () => {
    const small = frameGeometry(320, 568)
    const large = frameGeometry(430, 932)
    expect(large.rx).toBeGreaterThan(small.rx)
  })
})

describe('ellipsePerimeter', () => {
  it('matches the circle formula when the radii are equal', () => {
    expect(ellipsePerimeter(50, 50)).toBeCloseTo(2 * Math.PI * 50, 3)
  })

  it('grows with the radii', () => {
    expect(ellipsePerimeter(80, 110)).toBeGreaterThan(ellipsePerimeter(40, 55))
  })
})

describe('holdRingDash', () => {
  const perimeter = 1000

  it('shows four separated brackets at rest', () => {
    const [filled, gap] = holdRingDash(perimeter, 0)
    expect(gap).toBeGreaterThan(0)
    expect(filled).toBeGreaterThan(0)
    expect(filled + gap).toBeCloseTo(perimeter / 4, 6)
  })

  it('seals into an unbroken ring when the hold completes', () => {
    const [filled, gap] = holdRingDash(perimeter, 1)
    expect(gap).toBeCloseTo(0, 6)
    expect(filled).toBeCloseTo(perimeter / 4, 6)
  })

  it('closes monotonically', () => {
    const gaps = [0, 0.25, 0.5, 0.75, 1].map((p) => holdRingDash(perimeter, p)[1])
    for (let i = 1; i < gaps.length; i++) expect(gaps[i]!).toBeLessThan(gaps[i - 1]! + 1e-9)
  })

  it('clamps out-of-range progress instead of drawing nonsense', () => {
    expect(holdRingDash(perimeter, -3)).toEqual(holdRingDash(perimeter, 0))
    expect(holdRingDash(perimeter, 9)).toEqual(holdRingDash(perimeter, 1))
  })
})

describe('instructionFor', () => {
  it('puts framing ahead of the challenge', () => {
    const text = instructionFor('en', 'tooFar', 'turnLeft', false)
    expect(text).toBe('Move closer')
  })

  it('asks for the challenge once framing is good', () => {
    expect(instructionFor('en', 'ok', 'closeEyes', false)).toBe('Close your eyes and hold')
  })

  it('switches to hold coaching while the pose is being held', () => {
    expect(instructionFor('en', 'ok', 'turnRight', true)).toBe('Hold steady')
  })

  it('falls back to the checking message when no challenge is left', () => {
    expect(instructionFor('en', 'ok', null, false)).toBe('Checking…')
  })

  it('speaks Thai too', () => {
    expect(instructionFor('th', 'ok', 'closeEyes', false)).toBe('หลับตาค้างไว้')
    expect(instructionFor('th', 'tooClose', null, false)).toBe('ถอยออกมาเล็กน้อย')
  })
})

describe('copy quality', () => {
  const locales = ['th', 'en'] as const

  it.each(locales)('keeps every %s capture instruction short enough to read at a glance', (locale) => {
    const dict = strings(locale)
    const lines = [...Object.values(dict.framing), ...Object.values(dict.challenge), dict.holdOn]
    for (const line of lines) {
      // ZOLOZ caps its face-scan prompt at 60 characters; so do we.
      expect(line.length).toBeLessThanOrEqual(60)
      expect(line.length).toBeGreaterThan(0)
    }
  })

  it.each(locales)('covers every framing and challenge state in %s', (locale) => {
    const dict = strings(locale)
    expect(Object.keys(dict.framing).sort()).toEqual(
      ['multipleFaces', 'noFace', 'offCentre', 'tooClose', 'tooFar'].sort(),
    )
    expect(Object.keys(dict.challenge).sort()).toEqual(
      ['center', 'closeEyes', 'smile', 'turnLeft', 'turnRight'].sort(),
    )
  })

  it('explains the same reason codes in both languages', () => {
    expect(Object.keys(strings('th').reason).sort()).toEqual(Object.keys(strings('en').reason).sort())
  })
})

describe('explainReasons', () => {
  it('turns codes into advice', () => {
    expect(explainReasons('en', ['PAD_LOW'])).toEqual([
      'That looked like a photo or a screen. Please scan your real face.',
    ])
  })

  it('lists several problems at once', () => {
    expect(explainReasons('en', ['QUALITY_SHARPNESS', 'QUALITY_BRIGHTNESS'])).toHaveLength(2)
  })

  it('never repeats the same advice', () => {
    expect(explainReasons('en', ['PAD_LOW', 'PAD_LOW'])).toHaveLength(1)
  })

  it('falls back to a generic line for an unknown code', () => {
    expect(explainReasons('en', ['SOMETHING_NEW'])).toEqual(["That didn't work"])
  })

  it('drops unknown codes when a known one is present', () => {
    expect(explainReasons('en', ['SOMETHING_NEW', 'NO_MATCH'])).toEqual([
      "That doesn't match the enrolled face.",
    ])
  })
})

describe('hintSide', () => {
  it('points at the screen side matching the user in a mirrored preview', () => {
    expect(hintSide('turnLeft')).toBe('left')
    expect(hintSide('turnRight')).toBe('right')
  })

  it('shows nothing for steps that have no direction', () => {
    expect(hintSide('center')).toBeNull()
    expect(hintSide('closeEyes')).toBeNull()
    expect(hintSide('smile')).toBeNull()
    expect(hintSide(null)).toBeNull()
  })

  it('never points both turns at the same side', () => {
    expect(hintSide('turnLeft')).not.toBe(hintSide('turnRight'))
  })
})

describe('hasVisualHint', () => {
  it('covers every step a user could turn the wrong way on', () => {
    expect(hasVisualHint('turnLeft')).toBe(true)
    expect(hasVisualHint('turnRight')).toBe(true)
    expect(hasVisualHint('closeEyes')).toBe(true)
  })

  it('leaves the framing step alone — the oval is already the instruction', () => {
    expect(hasVisualHint('center')).toBe(false)
    expect(hasVisualHint(null)).toBe(false)
  })

  it('agrees with hintSide about which steps have a direction', () => {
    for (const step of ['center', 'closeEyes', 'turnLeft', 'turnRight', 'smile'] as const) {
      if (hintSide(step) !== null) expect(hasVisualHint(step)).toBe(true)
    }
  })
})

describe('explainReasons — local failures', () => {
  it('explains a failure that never reached the server', () => {
    expect(explainReasons('th', ['LOCAL_faceLost'])).toEqual(['ใบหน้าหลุดจากกรอบ ลองใหม่อีกครั้ง'])
    expect(explainReasons('en', ['LOCAL_timeout'])).toEqual(['That took too long. Try again.'])
  })

  it('covers every local failure reason', () => {
    for (const reason of ['timeout', 'faceLost', 'multipleFaces', 'captureFailed', 'cancelled']) {
      expect(explainReasons('th', [`LOCAL_${reason}`])[0]).not.toBe(strings('th').result.failTitle)
    }
  })

  it('still handles server codes alongside', () => {
    expect(explainReasons('en', ['LOCAL_faceLost', 'PAD_LOW'])).toHaveLength(2)
  })
})
