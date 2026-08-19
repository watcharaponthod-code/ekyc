/**
 * On-device identity maths — pure TypeScript, no React Native, unit-tested.
 *
 * The local flow captures one still per challenge (neutral, turned left,
 * turned right, mouth open, nodding), embeds each with MobileFaceNet and asks
 * one question: **were these all the same person?** A photo swapped in for one
 * step, or a second person stepping in for the turns, shows up as a low
 * similarity between some pair of frames.
 */

import * as jpeg from 'jpeg-js'

/** MobileFaceNet input side, pixels. */
export const EMBEDDING_INPUT = 112
/** MobileFaceNet output size. */
export const EMBEDDING_DIM = 192

/**
 * Cosine similarity of two embeddings, -1..1. Inputs are normalised anyway,
 * so a raw model output and an L2-normalised one compare the same.
 */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length)
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < n; i++) {
    const x = a[i]!
    const y = b[i]!
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na <= 1e-12 || nb <= 1e-12) return 0
  return dot / Math.sqrt(na * nb)
}

export function l2normalize(v: ArrayLike<number>): Float32Array {
  let norm = 0
  for (let i = 0; i < v.length; i++) norm += v[i]! * v[i]!
  norm = Math.sqrt(norm)
  const out = new Float32Array(v.length)
  if (norm <= 1e-12) return out
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / norm
  return out
}

/**
 * RGBA pixels (as jpeg-js decodes them) → MobileFaceNet input tensor,
 * NHWC float32, `(x - 127.5) / 128` — the normalisation the weights were
 * trained with. The image must already be `EMBEDDING_INPUT` square.
 */
export function preprocessRgba(rgba: Uint8Array, width: number, height: number): Float32Array {
  if (width !== EMBEDDING_INPUT || height !== EMBEDDING_INPUT) {
    throw new Error(`expected a ${EMBEDDING_INPUT}x${EMBEDDING_INPUT} image, got ${width}x${height}`)
  }
  if (rgba.length < width * height * 4) {
    throw new Error(`pixel buffer too small: ${rgba.length} < ${width * height * 4}`)
  }
  const out = new Float32Array(width * height * 3)
  let o = 0
  for (let p = 0; p < width * height; p++) {
    const i = p * 4
    out[o++] = (rgba[i]! - 127.5) / 128
    out[o++] = (rgba[i + 1]! - 127.5) / 128
    out[o++] = (rgba[i + 2]! - 127.5) / 128
  }
  return out
}

/** Base64 → bytes. Uses the platform `atob` when present (RN ≥ 0.74, browsers), else a small decoder. */
export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/^data:[^,]*,/, '').replace(/\s+/g, '')
  const atobFn = (globalThis as { atob?: (s: string) => string }).atob
  if (typeof atobFn === 'function') {
    const bin = atobFn(clean)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  }
  const table = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const lookup = new Uint8Array(256)
  for (let i = 0; i < table.length; i++) lookup[table.charCodeAt(i)] = i
  const stripped = clean.replace(/=+$/, '')
  const out = new Uint8Array(Math.floor((stripped.length * 3) / 4))
  let buffer = 0
  let bits = 0
  let o = 0
  for (let i = 0; i < stripped.length; i++) {
    buffer = (buffer << 6) | lookup[stripped.charCodeAt(i)]!
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[o++] = (buffer >> bits) & 0xff
    }
  }
  return out.subarray(0, o)
}

export type DecodedImage = { width: number; height: number; rgba: Uint8Array }

/** Decode a JPEG (bytes or base64) into RGBA pixels. Pure JS — fine for 112 px crops. */
export function decodeJpeg(input: Uint8Array | string): DecodedImage {
  const bytes = typeof input === 'string' ? base64ToBytes(input) : input
  const decoded = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true })
  return { width: decoded.width, height: decoded.height, rgba: new Uint8Array(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength) }
}

/** One captured frame's embedding, keyed like the server flow (`neutral`, `turnLeft`, …). */
export type FrameEmbedding = { key: string; embedding: Float32Array }

export type ConsistencyReport = {
  /** Lowest similarity across the compared pairs — the number the verdict is made on. */
  min: number
  /** Which pair was the worst. */
  weakest: [string, string] | null
  /** Every compared pair, for the debug/result screen. */
  pairs: { a: string; b: string; similarity: number }[]
  /** Which pairs were compared. */
  topology: 'star' | 'all'
}

/**
 * Which pairs to compare.
 *
 * `star` (default): every frame against the neutral frame. That is the
 * comparison that carries the security — a photo swapped in for one step, or
 * a second person doing a turn, differs from the neutral face — and it avoids
 * judging the hardest pair of all, turned-left vs turned-right (40°+ apart),
 * which for an unaligned embedder scores low for the *same* person and adds
 * nothing a neutral comparison does not already catch. `all` is the old
 * every-pair rule, kept for measurement.
 */
export type Topology = 'star' | 'all'

/**
 * Similarity across the captured frames. Like the server's swap detector it
 * reports the *worst* compared pair, not the mean: one swapped frame must not
 * hide behind four good ones.
 */
export function consistency(frames: FrameEmbedding[], topology: Topology = 'star'): ConsistencyReport {
  const pairs: ConsistencyReport['pairs'] = []
  let min = 1
  let weakest: [string, string] | null = null
  const neutral = frames.find((f) => f.key === 'neutral')
  const compare = (a: FrameEmbedding, b: FrameEmbedding) => {
    const similarity = cosine(a.embedding, b.embedding)
    pairs.push({ a: a.key, b: b.key, similarity })
    if (similarity < min) {
      min = similarity
      weakest = [a.key, b.key]
    }
  }
  if (topology === 'star' && neutral) {
    for (const f of frames) if (f !== neutral) compare(neutral, f)
  } else {
    for (let i = 0; i < frames.length; i++) for (let j = i + 1; j < frames.length; j++) compare(frames[i]!, frames[j]!)
  }
  return { min: pairs.length === 0 ? 1 : min, weakest, pairs, topology: topology === 'star' && neutral ? 'star' : 'all' }
}

/**
 * Default thresholds, from MobileFaceNet (192-d) on an unaligned face-box crop
 * of LFW, 40 subjects, 600 genuine / 780 impostor pairs (2026-08-18):
 *
 *   genuine  median 0.59  p10 0.30      impostor median 0.21  p95 0.47  p99 0.56
 *
 * LFW pairs are years apart at wild angles; five frames from one session
 * seconds apart score far higher, so `consistencyMin` at 0.45 (LFW FAR 6.5 %)
 * is loose enough for a turned head and still catches a swapped photo or a
 * second person. `matchMin` for verifying against a *saved* template across
 * sessions is stricter (LFW FAR 1.4 %, FRR 44 % on LFW's harsh pairs — far
 * lower on two selfies). Both are knobs; both should be measured on your users.
 */
export const DEFAULT_CONSISTENCY_MIN = 0.45
export const DEFAULT_MATCH_MIN = 0.55

export type LocalVerdict = {
  passed: boolean
  reasons: string[]
  consistency: ConsistencyReport
  /** Similarity to the reference template, when one was supplied. */
  match?: { score: number; ok: boolean }
}

export function judge(
  frames: FrameEmbedding[],
  options: { consistencyMin?: number; reference?: ArrayLike<number> | null; matchMin?: number; topology?: Topology } = {},
): LocalVerdict {
  const consistencyMin = options.consistencyMin ?? DEFAULT_CONSISTENCY_MIN
  const matchMin = options.matchMin ?? DEFAULT_MATCH_MIN
  const report = consistency(frames, options.topology ?? 'star')
  const reasons: string[] = []
  if (frames.length === 0) reasons.push('NO_FRAMES')
  if (report.min < consistencyMin) reasons.push('IDENTITY_INCONSISTENT')

  let match: LocalVerdict['match']
  if (options.reference && frames.length > 0) {
    const neutral = frames.find((f) => f.key === 'neutral') ?? frames[0]!
    const score = cosine(neutral.embedding, options.reference)
    match = { score, ok: score >= matchMin }
    if (!match.ok) reasons.push('NO_MATCH')
  }
  return { passed: reasons.length === 0, reasons, consistency: report, ...(match ? { match } : {}) }
}

/** Serialise an embedding for storage (plain JSON array, ~2.5 KB for 192-d). */
export function embeddingToJson(embedding: ArrayLike<number>): string {
  return JSON.stringify(Array.from(embedding as ArrayLike<number>).map((v) => Math.round(v * 1e6) / 1e6))
}

export function embeddingFromJson(json: string): Float32Array {
  const parsed = JSON.parse(json) as unknown
  if (!Array.isArray(parsed) || parsed.some((v) => typeof v !== 'number')) {
    throw new Error('not an embedding')
  }
  return Float32Array.from(parsed as number[])
}

/** Mirror an RGBA buffer left↔right. Pure; tested. */
export function flipHorizontal(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(rgba.length)
  for (let y = 0; y < height; y++) {
    const row = y * width * 4
    for (let x = 0; x < width; x++) {
      const src = row + x * 4
      const dst = row + (width - 1 - x) * 4
      out[dst] = rgba[src]!
      out[dst + 1] = rgba[src + 1]!
      out[dst + 2] = rgba[src + 2]!
      out[dst + 3] = rgba[src + 3]!
    }
  }
  return out
}
