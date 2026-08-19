/**
 * Mean face colour of a snapshot — the one image operation the light flow
 * performs, and only during the flash phase (four frames).
 *
 * `expo-image-manipulator` crops the live ML Kit box out of the JPEG and
 * shrinks it to a 16×16 thumbnail (that *is* the averaging), `jpeg-js`
 * decodes it, and we average the pixels. Every failure is thrown to the
 * caller with the real message so it lands in the session log — the flash
 * check is advisory precisely because this path has not yet been proven on
 * every phone.
 */

import * as ImageManipulator from 'expo-image-manipulator'
import * as jpeg from 'jpeg-js'

import { asFileUri, type Rect } from '@ekyc/react-native-ekyc'

import type { Rgb } from './flash'

const THUMB = 16

function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/^data:[^,]*,/, '').replace(/\s+/g, '')
  const atobFn = (globalThis as { atob?: (s: string) => string }).atob
  const bin = atobFn ? atobFn(clean) : ''
  if (!atobFn) throw new Error('atob unavailable')
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Mean RGB (0..1) over `box` (normalised) of the image at `pathOrUri`. */
export async function meanFaceColour(pathOrUri: string, box: Rect): Promise<Rgb> {
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
    [{ crop: { originX: x, originY: y, width: w, height: h } }, { resize: { width: THUMB, height: THUMB } }],
    { compress: 1, format: ImageManipulator.SaveFormat.JPEG, base64: true },
  )
  if (!out.base64) throw new Error('no base64 from image manipulator')
  const decoded = jpeg.decode(base64ToBytes(out.base64), { useTArray: true, formatAsRGBA: true })
  const px = decoded.data
  let r = 0
  let g = 0
  let b = 0
  const n = decoded.width * decoded.height
  for (let i = 0; i < n; i++) {
    r += px[i * 4]!
    g += px[i * 4 + 1]!
    b += px[i * 4 + 2]!
  }
  return [r / n / 255, g / n / 255, b / n / 255]
}
