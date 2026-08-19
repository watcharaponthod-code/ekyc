/**
 * Client-side copy of the server's sharpness gate, so a motion-blurred
 * neutral frame is retaken on the phone instead of failing the whole round
 * ten seconds later with QUALITY_SHARPNESS.
 *
 * Same measurement as `server/app/ml/geometry.sharpness`: crop the face box,
 * resize to 160×160, grey, variance of the 3×3 Laplacian. The crop and resize
 * run natively (expo-image-manipulator); only the 25 600-pixel Laplacian runs
 * in JS. The threshold comes from the session policy (`sharpnessMin`), with a
 * margin for the JPEG re-encode the manipulator adds.
 */

import * as ImageManipulator from 'expo-image-manipulator'
import * as jpeg from 'jpeg-js'

import { asFileUri } from '../client/EKYCClient'
import type { Rect } from '../types'

/** Must match `_QUALITY_CROP` on the server. */
export const SHARPNESS_CROP = 160

/** Factor over the server threshold that a client-measured frame must clear. */
export const SHARPNESS_MARGIN = 1.25

function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/^data:[^,]*,/, '').replace(/\s+/g, '')
  const atobFn = (globalThis as { atob?: (s: string) => string }).atob
  if (!atobFn) throw new Error('atob unavailable')
  const bin = atobFn(clean)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * Variance of the 3×3 Laplacian (0 1 0 / 1 −4 1 / 0 1 0) over a grey image,
 * interior pixels only (cv2 replicates the border; the difference is ~1 %).
 */
export function laplacianVariance(gray: Float32Array | number[], width: number, height: number): number {
  if (width < 3 || height < 3) return 0
  let sum = 0
  let sumSq = 0
  let n = 0
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x
      const v = (gray[i - width] as number) + (gray[i + width] as number) + (gray[i - 1] as number) + (gray[i + 1] as number) - 4 * (gray[i] as number)
      sum += v
      sumSq += v * v
      n++
    }
  }
  if (n === 0) return 0
  const mean = sum / n
  return sumSq / n - mean * mean
}

/** RGBA pixel buffer → grey (cv2 weights). */
export function toGray(rgba: Uint8Array, count: number): Float32Array {
  const gray = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    gray[i] = 0.299 * rgba[i * 4]! + 0.587 * rgba[i * 4 + 1]! + 0.114 * rgba[i * 4 + 2]!
  }
  return gray
}

/**
 * Sharpness of the face inside `box` (normalised) of the JPEG at `pathOrUri`.
 * Throws with the real message on any failure so the caller can log it and
 * fall through (the server still measures; this is only an early retake).
 */
export async function faceSharpness(pathOrUri: string, box: Rect): Promise<number> {
  const uri = asFileUri(pathOrUri)
  const probe = await ImageManipulator.manipulateAsync(uri, [], { base64: false })
  const W = probe.width
  const H = probe.height
  const x = Math.min(Math.max(0, Math.round(box.x * W)), Math.max(0, W - 2))
  const y = Math.min(Math.max(0, Math.round(box.y * H)), Math.max(0, H - 2))
  const w = Math.max(2, Math.min(Math.round(box.w * W), W - x))
  const h = Math.max(2, Math.min(Math.round(box.h * H), H - y))
  const out = await ImageManipulator.manipulateAsync(
    uri,
    [{ crop: { originX: x, originY: y, width: w, height: h } }, { resize: { width: SHARPNESS_CROP, height: SHARPNESS_CROP } }],
    { compress: 1, format: ImageManipulator.SaveFormat.JPEG, base64: true },
  )
  if (!out.base64) throw new Error('no base64 from image manipulator')
  const decoded = jpeg.decode(base64ToBytes(out.base64), { useTArray: true, formatAsRGBA: true })
  const n = decoded.width * decoded.height
  return laplacianVariance(toGray(decoded.data as Uint8Array, n), decoded.width, decoded.height)
}
