/**
 * Skin-patch colour sampling for on-device rPPG — pure helpers.
 *
 * One image op per burst frame: the face box is cropped and shrunk to a small
 * square (`FACE_THUMB` px) whose pixels we read in JS; the three patches
 * (forehead, left cheek, right cheek) are then averaged from that thumbnail
 * using box-relative rectangles. Averaging thousands of source pixels into a
 * 32×32 thumbnail is exactly the low-pass filter rPPG wants.
 */

import type { Rect } from '@ekyc/react-native-ekyc'

import type { Rgb } from './pulse'

/** Side of the face thumbnail read per frame. */
export const FACE_THUMB = 32

/** A rectangle relative to the face box (0..1 in both axes). */
export type RelRect = { x: number; y: number; w: number; h: number }

/**
 * Patch rectangles relative to an ML Kit face box. ML Kit's box runs from
 * roughly the eyebrows to the chin, so the "forehead" here is the strip
 * between the brows and the top edge; cheeks sit either side of the nose
 * below the eye line. Values chosen to stay on skin for most face shapes and
 * clear of eyes, nostrils and lips.
 */
export const DEFAULT_PATCHES: readonly RelRect[] = [
  { x: 0.3, y: 0.06, w: 0.4, h: 0.16 }, // forehead / brow strip
  { x: 0.12, y: 0.5, w: 0.22, h: 0.2 }, // subject's right cheek (image left)
  { x: 0.66, y: 0.5, w: 0.22, h: 0.2 }, // subject's left cheek (image right)
]

/** Mean RGB (0..1) of one relative rectangle inside an RGBA thumbnail. */
export function patchMean(rgba: Uint8Array, side: number, rect: RelRect): Rgb {
  const x0 = Math.max(0, Math.floor(rect.x * side))
  const y0 = Math.max(0, Math.floor(rect.y * side))
  const x1 = Math.min(side, Math.ceil((rect.x + rect.w) * side))
  const y1 = Math.min(side, Math.ceil((rect.y + rect.h) * side))
  let r = 0
  let g = 0
  let b = 0
  let n = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * side + x) * 4
      r += rgba[i]!
      g += rgba[i + 1]!
      b += rgba[i + 2]!
      n++
    }
  }
  if (n === 0) return [0, 0, 0]
  return [r / n / 255, g / n / 255, b / n / 255]
}

/** All patch means for one thumbnail. */
export function samplePatches(rgba: Uint8Array, side: number, patches: readonly RelRect[] = DEFAULT_PATCHES): Rgb[] {
  return patches.map((p) => patchMean(rgba, side, p))
}

/** Clamp a normalised face box to the frame and grow it slightly so a small head movement stays inside. */
export function stableFaceBox(box: Rect, margin = 0.05): Rect {
  const x = Math.max(0, box.x - box.w * margin)
  const y = Math.max(0, box.y - box.h * margin)
  const w = Math.min(1 - x, box.w * (1 + 2 * margin))
  const h = Math.min(1 - y, box.h * (1 + 2 * margin))
  return { x, y, w, h }
}
