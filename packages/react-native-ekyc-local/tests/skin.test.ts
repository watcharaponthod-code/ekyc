import { DEFAULT_PATCHES, FACE_THUMB, patchMean, samplePatches, stableFaceBox } from '../src/skin'

function thumb(fill: (x: number, y: number) => [number, number, number]): Uint8Array {
  const out = new Uint8Array(FACE_THUMB * FACE_THUMB * 4)
  for (let y = 0; y < FACE_THUMB; y++) {
    for (let x = 0; x < FACE_THUMB; x++) {
      const [r, g, b] = fill(x, y)
      const i = (y * FACE_THUMB + x) * 4
      out[i] = r
      out[i + 1] = g
      out[i + 2] = b
      out[i + 3] = 255
    }
  }
  return out
}

describe('skin patches', () => {
  it('averages the right region: top strip vs bottom half', () => {
    const rgba = thumb((_x, y) => (y < FACE_THUMB / 3 ? [200, 100, 50] : [50, 100, 200]))
    const [forehead, cheekR, cheekL] = samplePatches(rgba, FACE_THUMB)
    expect(forehead![0]).toBeCloseTo(200 / 255, 2)
    expect(cheekR![2]).toBeCloseTo(200 / 255, 2)
    expect(cheekL![2]).toBeCloseTo(200 / 255, 2)
  })
  it('patches stay inside the box and off the eyes/lips band', () => {
    for (const p of DEFAULT_PATCHES) {
      expect(p.x).toBeGreaterThanOrEqual(0)
      expect(p.x + p.w).toBeLessThanOrEqual(1)
      expect(p.y + p.h).toBeLessThanOrEqual(1)
    }
    // nothing overlaps the eye line (~0.3–0.45 of the ML Kit box)
    expect(DEFAULT_PATCHES.every((p) => p.y + p.h <= 0.3 || p.y >= 0.45)).toBe(true)
  })
  it('an empty rectangle returns black rather than NaN', () => {
    expect(patchMean(new Uint8Array(FACE_THUMB * FACE_THUMB * 4), FACE_THUMB, { x: 0.99, y: 0.99, w: 0.001, h: 0.001 })).toEqual([0, 0, 0])
  })
  it('stableFaceBox grows and clamps to the frame', () => {
    const b = stableFaceBox({ x: 0.9, y: 0.05, w: 0.2, h: 0.3 })
    expect(b.x + b.w).toBeLessThanOrEqual(1)
    expect(b.y).toBeGreaterThanOrEqual(0)
    expect(b.w).toBeGreaterThan(0)
  })
})
