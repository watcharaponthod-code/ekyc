/**
 * rPPG pulse liveness on the phone — the silicone-mask counter-measure, in
 * pure TypeScript. A line-for-line port of the server's `app/pulse.py`
 * (POS projection per skin patch, Hann-windowed spectrum in 0.7–3 Hz,
 * spectra averaged across patches, peak prominence in dB → logistic score),
 * so the two agree on the same input.
 *
 * Skin has blood; masks, prints and screens showing a still image do not.
 * The face's mean colour over a few seconds carries the heartbeat as a tiny
 * periodic change. This module only does the maths; sampling the patch colours
 * from frames is `PulseSampler`'s job in `LocalLivenessCamera`.
 *
 * Calibrated on synthetic traces only (see tests): clean separation when the
 * pulse amplitude is ≥ ~2× the per-frame colour noise, overlap at ≈1×. Hence
 * `pulseRule` defaults to `advisory` — the score is reported, not enforced —
 * until real phones have been measured.
 */

export const BAND_HZ: [number, number] = [0.7, 3.0]
export const PEAK_HALF_WIDTH_HZ = 0.15
export const POS_WINDOW_S = 1.6
export const MIN_FRAMES = 24
export const MIN_SPAN_MS = 3000
export const RESAMPLE_HZ: [number, number] = [5, 60]
export const PROMINENCE_CENTRE_DB = 7.0
export const PROMINENCE_SCALE_DB = 1.0
/** Default gate on `score` (logistic of prominence, 0.5 at 7 dB). */
export const DEFAULT_PULSE_MIN = 0.5

export type Rgb = [number, number, number]

export type PulseResult = {
  /** 0..1 — confidence that a periodic pulse is present. */
  score: number
  bpm: number
  prominenceDb: number
  frames: number
  spanMs: number
  samplingHz: number
  patches: number
  /** Why the score is 0 without measurement, or '' when measured. */
  note: '' | 'shape' | 'too_short' | 'nan' | 'flat'
}

/** `colors[i]` = one RGB (0..1) per patch for frame i. */
export function pulseLivenessScore(timesMs: ArrayLike<number>, colors: Rgb[][]): PulseResult {
  const n0 = timesMs.length
  const k = colors[0]?.length ?? 0
  if (n0 === 0 || colors.length !== n0 || k === 0) return zero(n0, 0, 0, k, 'shape')

  // sort by time, drop duplicate timestamps
  const order = Array.from({ length: n0 }, (_, i) => i).sort((a, b) => timesMs[a]! - timesMs[b]!)
  const t: number[] = []
  const c: Rgb[][] = []
  for (const i of order) {
    const ti = timesMs[i]!
    if (t.length > 0 && ti <= t[t.length - 1]!) continue
    const row = colors[i]!
    if (row.length !== k) return zero(n0, 0, 0, k, 'shape')
    t.push(ti)
    c.push(row)
  }
  const n = t.length
  const span = n > 1 ? Math.round(t[n - 1]! - t[0]!) : 0
  if (n < MIN_FRAMES || span < MIN_SPAN_MS) return zero(n, span, 0, k, 'too_short')
  for (const row of c) for (const p of row) for (const v of p) if (!Number.isFinite(v)) return zero(n, span, 0, k, 'nan')

  // 1. uniform resampling at the burst's own median rate
  const dts: number[] = []
  for (let i = 1; i < n; i++) dts.push(t[i]! - t[i - 1]!)
  const medianDt = median(dts) / 1000
  const fs = clamp(1 / Math.max(medianDt, 1e-3), RESAMPLE_HZ[0], RESAMPLE_HZ[1])
  const grid: number[] = []
  for (let g = t[0]!; g < t[n - 1]!; g += 1000 / fs) grid.push(g)
  if (grid.length < MIN_FRAMES) return zero(n, span, fs, k, 'too_short')

  // 2./3. per-patch POS → normalised band spectrum, averaged
  let accumulated: Float64Array | null = null
  let freqs: Float64Array | null = null
  let used = 0
  for (let patch = 0; patch < k; patch++) {
    const channels: number[][] = [0, 1, 2].map((ch) => c.map((row) => row[patch]![ch]!))
    if (channels.some((ch) => std(ch) < 1e-9)) continue
    const rgb = channels.map((ch) => interp(grid, t, ch))
    const signal = posSignal(rgb, fs)
    if (!signal || std(Array.from(signal)) < 1e-12) continue
    const { freqs: f, power } = bandSpectrum(signal, fs)
    let total = 0
    for (const v of power) total += v
    if (total <= 0) continue
    for (let i = 0; i < power.length; i++) power[i] = power[i]! / total
    if (!accumulated) {
      accumulated = new Float64Array(power)
      freqs = f
    } else {
      for (let i = 0; i < power.length; i++) accumulated[i] = accumulated[i]! + power[i]!
    }
    used++
  }
  if (!accumulated || !freqs) return zero(n, span, fs, k, 'flat')
  for (let i = 0; i < accumulated.length; i++) accumulated[i] = accumulated[i]! / used

  // 4. prominence of the strongest peak
  const { prominenceDb, peakHz } = peakProminence(freqs, accumulated)
  const score = 1 / (1 + Math.exp(-(prominenceDb - PROMINENCE_CENTRE_DB) / PROMINENCE_SCALE_DB))
  return { score, bpm: peakHz * 60, prominenceDb, frames: n, spanMs: span, samplingHz: fs, patches: used, note: '' }
}

function zero(frames: number, spanMs: number, fs: number, patches: number, note: PulseResult['note']): PulseResult {
  return { score: 0, bpm: 0, prominenceDb: 0, frames, spanMs, samplingHz: fs, patches, note }
}

/** Plane-Orthogonal-to-Skin pulse signal from uniformly sampled RGB channels. */
export function posSignal(rgb: number[][], fs: number): Float64Array | null {
  const n = rgb[0]!.length
  let win = Math.max(Math.round(POS_WINDOW_S * fs), 8)
  if (n < win) win = n
  const h = new Float64Array(n)
  let any = false
  for (let start = 0; start + win <= n; start++) {
    const mean = [0, 1, 2].map((ch) => {
      let s = 0
      for (let i = start; i < start + win; i++) s += rgb[ch]![i]!
      return s / win
    })
    if (mean.some((m) => m <= 1e-9)) continue
    const s1 = new Float64Array(win)
    const s2 = new Float64Array(win)
    for (let i = 0; i < win; i++) {
      const r = rgb[0]![start + i]! / mean[0]! - 1
      const g = rgb[1]![start + i]! / mean[1]! - 1
      const b = rgb[2]![start + i]! / mean[2]! - 1
      s1[i] = g - b
      s2[i] = -2 * r + g + b
    }
    const sigma2 = std(Array.from(s2))
    const alpha = sigma2 > 1e-12 ? std(Array.from(s1)) / sigma2 : 0
    const p = new Float64Array(win)
    let pm = 0
    for (let i = 0; i < win; i++) {
      p[i] = s1[i]! + alpha * s2[i]!
      pm += p[i]!
    }
    pm /= win
    for (let i = 0; i < win; i++) {
      h[start + i] = h[start + i]! + (p[i]! - pm)
      any = true
    }
  }
  return any ? h : null
}

/** (freqs, power) restricted to the physiological band — Hann window, zero-padded DFT. */
export function bandSpectrum(signal: Float64Array, fs: number): { freqs: Float64Array; power: Float64Array } {
  const n = signal.length
  let mean = 0
  for (const v of signal) mean += v
  mean /= n
  const nfft = 1 << Math.ceil(Math.log2(Math.max(n, 8) * 8))
  const x = new Float64Array(nfft)
  for (let i = 0; i < n; i++) x[i] = (signal[i]! - mean) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)))
  const df = fs / nfft
  const kLo = Math.ceil(BAND_HZ[0] / df)
  const kHi = Math.floor(BAND_HZ[1] / df)
  const count = Math.max(0, kHi - kLo + 1)
  const freqs = new Float64Array(count)
  const power = new Float64Array(count)
  // Direct DFT over the band bins only — the band is narrow (≈2.3 Hz of a
  // ≤60 Hz spectrum) so this is far cheaper than a full FFT and needs no library.
  for (let j = 0; j < count; j++) {
    const kk = kLo + j
    let re = 0
    let im = 0
    const w = (-2 * Math.PI * kk) / nfft
    for (let i = 0; i < n; i++) {
      const a = w * i
      re += x[i]! * Math.cos(a)
      im += x[i]! * Math.sin(a)
    }
    freqs[j] = kk * df
    power[j] = re * re + im * im
  }
  return { freqs, power }
}

export function peakProminence(freqs: Float64Array, power: Float64Array): { prominenceDb: number; peakHz: number } {
  if (freqs.length === 0) return { prominenceDb: -30, peakHz: 0 }
  let peak = 0
  for (let i = 1; i < power.length; i++) if (power[i]! > power[peak]!) peak = i
  const peakHz = freqs[peak]!
  const rest: number[] = []
  let inPeakSum = 0
  let inPeakN = 0
  for (let i = 0; i < freqs.length; i++) {
    const f = freqs[i]!
    const inPeak = Math.abs(f - peakHz) <= PEAK_HALF_WIDTH_HZ
    const inHarm = Math.abs(f - 2 * peakHz) <= PEAK_HALF_WIDTH_HZ
    if (inPeak) {
      inPeakSum += power[i]!
      inPeakN++
    }
    if (!inPeak && !inHarm) rest.push(power[i]!)
  }
  if (rest.length === 0) return { prominenceDb: 30, peakHz }
  const floor = median(rest)
  if (floor <= 1e-18) return { prominenceDb: 30, peakHz }
  const prom = 10 * Math.log10(inPeakSum / inPeakN / floor)
  return { prominenceDb: clamp(prom, -30, 30), peakHz }
}

// ---- small numeric helpers ---------------------------------------------------

function median(values: number[]): number {
  if (values.length === 0) return 0
  const s = [...values].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}
function std(values: ArrayLike<number>): number {
  const n = values.length
  if (n === 0) return 0
  let m = 0
  for (let i = 0; i < n; i++) m += values[i]!
  m /= n
  let v = 0
  for (let i = 0; i < n; i++) v += (values[i]! - m) ** 2
  return Math.sqrt(v / n)
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}
/** Linear interpolation of (xs, ys) at each grid point; xs strictly increasing. */
function interp(grid: number[], xs: number[], ys: number[]): number[] {
  const out: number[] = new Array(grid.length)
  let j = 0
  for (let i = 0; i < grid.length; i++) {
    const g = grid[i]!
    while (j < xs.length - 2 && xs[j + 1]! < g) j++
    const x0 = xs[j]!
    const x1 = xs[j + 1]!
    const y0 = ys[j]!
    const y1 = ys[j + 1]!
    out[i] = x1 === x0 ? y0 : y0 + ((y1 - y0) * (g - x0)) / (x1 - x0)
  }
  return out
}
