/**
 * Active-flash liveness on the phone — a port of the server's `app/flash.py`.
 *
 * The screen flashes a random sequence of colours; a real 3-D face lit by the
 * screen reflects them, so the mean colour of the face tracks the commanded
 * sequence (per channel, Pearson correlation across frames). A printed photo
 * or a phone screen held up does not follow a sequence it never knew.
 *
 * Plainly: this catches **photos and screen replays**. It does **not** catch a
 * mask — a mask is a 3-D surface and reflects the screen much like skin. The
 * mask counter-measures are the movement challenges (a rigid mask cannot
 * open its mouth) and, in the heavy edition, rPPG.
 *
 * Pure maths here; sampling the face colour from frames is `colour.ts`.
 * Calibrated on synthetic reflectance (server tests) and, on 2026-08-19, four
 * real Railway sessions scored 0.82–0.92 with a real face — so 0.5 is a
 * comfortable gate; still shipped advisory in the local flow until its own
 * device numbers exist.
 */

export type Rgb = [number, number, number]

/** Same off-primaries as the server: bright enough to light a face, still separable per channel. */
export const FLASH_PALETTE: Record<string, Rgb> = {
  red: [1.0, 0.15, 0.15],
  green: [0.15, 1.0, 0.15],
  blue: [0.15, 0.15, 1.0],
  white: [1.0, 1.0, 1.0],
}
export const FLASH_MIN = 0.5
export const FLASH_MIN_FRAMES = 3

export function flashHex(name: string): string {
  const c = FLASH_PALETTE[name] ?? FLASH_PALETTE.white!
  return '#' + c.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')
}

/** A random permutation of the palette (4 colours → every channel varies). */
export function pickFlashSequence(random: () => number = Math.random): string[] {
  const names = Object.keys(FLASH_PALETTE)
  for (let i = names.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[names[i], names[j]] = [names[j]!, names[i]!]
  }
  return names
}

function pearson(a: number[], b: number[]): number {
  const n = a.length
  const ma = a.reduce((s, v) => s + v, 0) / n
  const mb = b.reduce((s, v) => s + v, 0) / n
  let num = 0
  let da = 0
  let db = 0
  for (let i = 0; i < n; i++) {
    const x = a[i]! - ma
    const y = b[i]! - mb
    num += x * y
    da += x * x
    db += y * y
  }
  if (da <= 1e-18 || db <= 1e-18) return 0
  return num / Math.sqrt(da * db)
}

function std(v: number[]): number {
  const m = v.reduce((s, x) => s + x, 0) / v.length
  return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / v.length)
}

/**
 * 0..1: how well the observed face colours tracked the commanded flash
 * colours. Per channel the screen varied, the correlation across frames,
 * negatives clamped to 0, averaged. A constant face (photo) scores 0.
 */
export function flashLivenessScore(commanded: Rgb[], observed: Rgb[]): number {
  if (commanded.length < FLASH_MIN_FRAMES || commanded.length !== observed.length) return 0
  const scores: number[] = []
  for (let ch = 0; ch < 3; ch++) {
    const c = commanded.map((v) => v[ch]!)
    const o = observed.map((v) => v[ch]!)
    if (std(c) < 1e-3) continue
    if (std(o) < 1e-6) {
      scores.push(0)
      continue
    }
    scores.push(Math.max(0, pearson(c, o)))
  }
  if (scores.length === 0) return 0
  return scores.reduce((s, v) => s + v, 0) / scores.length
}
