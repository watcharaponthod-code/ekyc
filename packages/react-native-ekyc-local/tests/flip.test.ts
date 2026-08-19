import { flipHorizontal } from '../src/heavy/identity'

describe('flipHorizontal', () => {
  it('mirrors columns and keeps rows', () => {
    const w = 3
    const h = 2
    // pixel value = 10*y + x in R, alpha 255
    const rgba = new Uint8Array(w * h * 4)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; rgba[i] = 10 * y + x; rgba[i + 3] = 255 }
    const out = flipHorizontal(rgba, w, h)
    const R = (x: number, y: number) => out[(y * w + x) * 4]
    expect([R(0, 0), R(1, 0), R(2, 0)]).toEqual([2, 1, 0])
    expect([R(0, 1), R(1, 1), R(2, 1)]).toEqual([12, 11, 10])
    expect(out[3]).toBe(255)
  })
  it('is an involution', () => {
    const rgba = Uint8Array.from({ length: 4 * 4 * 4 }, (_, i) => (i * 37) % 256)
    expect(Array.from(flipHorizontal(flipHorizontal(rgba, 4, 4), 4, 4))).toEqual(Array.from(rgba))
  })
})
