import { MIN_FRAMES, PROMINENCE_CENTRE_DB, pulseLivenessScore, type Rgb } from '../src/heavy/pulse'

/** Deterministic Gaussian noise (Box–Muller over an LCG). */
function rng(seed: number) {
  let s = seed >>> 0
  const uniform = () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return (s + 0.5) / 4294967296
  }
  return {
    uniform,
    normal: () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform()),
  }
}

const BASE: Rgb = [0.62, 0.45, 0.38]

function trace(seed: number, opts: { fs?: number; secs?: number; bpm?: number | null; amp?: number; noise?: number; patches?: number; drift?: number } = {}) {
  const { fs = 12, secs = 7, bpm = 72, amp = 0.002, noise = 0.001, patches = 3, drift = 0 } = opts
  const r = rng(seed)
  const n = Math.floor(fs * secs)
  const times: number[] = []
  let t = 0
  for (let i = 0; i < n; i++) {
    times.push(Math.round(t))
    t += (1000 / fs) * (1 + 0.02 * r.normal())
  }
  const gains = Array.from({ length: patches }, () => 0.7 + 0.6 * r.uniform())
  const colors: Rgb[][] = times.map((ti, i) => {
    const pulse = bpm ? Math.sin(2 * Math.PI * (bpm / 60) * (ti / 1000)) : 0
    const d = 1 + (drift * i) / n
    return gains.map((g) => [
      BASE[0] * d + pulse * amp * 0.5 * g + noise * r.normal(),
      BASE[1] * d + pulse * amp * g + noise * r.normal(),
      BASE[2] * d + pulse * amp * 0.4 * g + noise * r.normal(),
    ] as Rgb)
  })
  return { times, colors }
}

function pct(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!
}

describe('pulseLivenessScore', () => {
  it('reads a beating face high with the right rate', () => {
    const { times, colors } = trace(1, { fs: 15, secs: 8, bpm: 72, noise: 0.0008 })
    const r = pulseLivenessScore(times, colors)
    expect(r.score).toBeGreaterThan(0.8)
    expect(Math.abs(r.bpm - 72)).toBeLessThan(6)
    expect(r.patches).toBe(3)
    expect(r.note).toBe('')
  })

  it('separates real from mask at moderate SNR (real p10 > mask p90)', () => {
    const reals = Array.from({ length: 30 }, (_, i) => pulseLivenessScore(...Object.values(trace(100 + i)) as [number[], Rgb[][]]).prominenceDb)
    const masks = Array.from({ length: 30 }, (_, i) => pulseLivenessScore(...Object.values(trace(200 + i, { bpm: null })) as [number[], Rgb[][]]).prominenceDb)
    expect(pct(reals, 10)).toBeGreaterThan(pct(masks, 90))
    expect(pct(masks, 90)).toBeLessThan(PROMINENCE_CENTRE_DB)
  })

  it('a slow illumination drift is not a pulse', () => {
    const scores = Array.from({ length: 20 }, (_, i) => pulseLivenessScore(...Object.values(trace(300 + i, { bpm: null, drift: 0.05 })) as [number[], Rgb[][]]).score)
    expect(pct(scores, 90)).toBeLessThan(0.5)
  })

  it('a static photo is flat and scores 0', () => {
    const times = Array.from({ length: 100 }, (_, i) => i * 80)
    const colors: Rgb[][] = times.map(() => [BASE, BASE, BASE])
    const r = pulseLivenessScore(times, colors)
    expect(r.score).toBe(0)
    expect(r.note).toBe('flat')
  })

  it('fails closed on short bursts, bad shapes and NaN', () => {
    const short = trace(4, { secs: 1.5 })
    expect(pulseLivenessScore(short.times, short.colors).note).toBe('too_short')
    const dense = trace(5, { fs: 60, secs: 2 })
    expect(dense.times.length).toBeGreaterThan(MIN_FRAMES)
    expect(pulseLivenessScore(dense.times, dense.colors).note).toBe('too_short')
    expect(pulseLivenessScore([1, 2, 3], [[BASE]]).note).toBe('shape')
    expect(pulseLivenessScore([], []).score).toBe(0)
    const bad = trace(6)
    bad.colors[3]![1]![1] = Number.NaN
    expect(pulseLivenessScore(bad.times, bad.colors).note).toBe('nan')
  })

  it.each([8, 12, 20, 30])('works at %i fps', (fs) => {
    const reals = Array.from({ length: 12 }, (_, i) => pulseLivenessScore(...Object.values(trace(400 + i + fs, { fs })) as [number[], Rgb[][]]).score)
    const masks = Array.from({ length: 12 }, (_, i) => pulseLivenessScore(...Object.values(trace(500 + i + fs, { fs, bpm: null })) as [number[], Rgb[][]]).score)
    expect(pct(reals, 50)).toBeGreaterThan(pct(masks, 90))
  })
})
