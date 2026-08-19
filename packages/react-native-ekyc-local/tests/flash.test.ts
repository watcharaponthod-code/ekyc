import { FLASH_MIN, FLASH_PALETTE, flashHex, flashLivenessScore, pickFlashSequence, type Rgb } from '../src/flash'

const CMD = ['red', 'green', 'blue', 'white'].map((n) => FLASH_PALETTE[n]!)

/** A real face: ambient + albedo·k·flash + a little noise. */
function reflected(c: Rgb, noise = 0.005, seed = 1): Rgb {
  const amb: Rgb = [0.2, 0.18, 0.16]
  const alb: Rgb = [0.9, 0.6, 0.5]
  let s = seed
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5) * 2 * noise
  return [0, 1, 2].map((i) => Math.min(1, amb[i]! + alb[i]! * 0.35 * c[i]! + rnd())) as unknown as Rgb
}

describe('flashLivenessScore (port of server flash.py)', () => {
  it('a real face tracks the sequence', () => {
    expect(flashLivenessScore(CMD, CMD.map((c, i) => reflected(c, 0.005, i + 1)))).toBeGreaterThan(0.85)
  })
  it('a photo (constant colour) scores ~0; a wrong sequence scores low', () => {
    expect(flashLivenessScore(CMD, CMD.map(() => [0.5, 0.4, 0.35] as Rgb))).toBe(0)
    const other = ['blue', 'white', 'red', 'green'].map((n) => FLASH_PALETTE[n]!)
    expect(flashLivenessScore(CMD, other.map((c, i) => reflected(c, 0.005, i + 1)))).toBeLessThan(FLASH_MIN)
  })
  it('fails closed on short or mismatched input', () => {
    expect(flashLivenessScore(CMD.slice(0, 2), CMD.slice(0, 2))).toBe(0)
    expect(flashLivenessScore(CMD, CMD.slice(0, 3))).toBe(0)
  })
  it('sequence is a permutation of the palette; hex matches', () => {
    let s = 7
    const seq = pickFlashSequence(() => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296))
    expect([...seq].sort()).toEqual(Object.keys(FLASH_PALETTE).sort())
    expect(flashHex('white')).toBe('#ffffff')
    expect(flashHex('red')).toBe('#ff2626')
  })
})
