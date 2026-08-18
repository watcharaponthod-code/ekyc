/**
 * MobileFaceNet on the phone, through `react-native-fast-tflite`.
 *
 * Model: `assets/mobile_face_net.tflite` — 5.2 MB, input `[1,112,112,3]`
 * float32 normalised `(x-127.5)/128`, output `[1,192]` already L2-normalised
 * (verified with the LiteRT interpreter, 2026-08-18). It is the MobileFaceNet
 * from the widely used Android face-recognition demos, i.e. the "small
 * DeepFace that runs on a phone".
 *
 * Crop pipeline, all on-device: snapshot JPEG → `expo-image-manipulator`
 * (square crop around the ML Kit face box with margin, level the eyes using
 * ML Kit's roll, centre-crop, resize 112) → base64 → `jpeg-js` decode →
 * float32 tensor → TFLite. Roughly 30–60 ms per face on a mid-range phone.
 */

import * as ImageManipulator from 'expo-image-manipulator'
import { loadTensorflowModel, type TensorflowModel } from 'react-native-fast-tflite'

import type { Rect } from '@ekyc/react-native-ekyc'

import { EMBEDDING_DIM, EMBEDDING_INPUT, decodeJpeg, l2normalize, preprocessRgba } from './identity'

/** How much of the ML Kit box to grow the crop by on each side. ArcFace-style
 * crops want the face tight but with brow and chin in; ML Kit boxes are already
 * roughly that, so a modest margin. */
const CROP_MARGIN = 0.15

export type FaceCrop = {
  /** Local file URI or path of the snapshot. */
  uri: string
  /** ML Kit box for the face, normalised 0..1 to the snapshot's own frame. */
  box: Rect
  /** ML Kit roll in degrees; the crop is rotated by -roll to level the eyes. */
  roll?: number
  /** Whether the snapshot is a mirror of the preview (front camera). Only affects
   * nothing here — embeddings of a mirrored face compare fine with each other —
   * but recorded for completeness. */
  mirrored?: boolean
}

export class FaceEmbedder {
  private model: TensorflowModel | null = null
  private loading: Promise<TensorflowModel> | null = null

  constructor(private readonly source: number | { url: string } = require('../assets/mobile_face_net.tflite')) {}

  /** Load the TFLite model once. Safe to call early (e.g. on the intro screen) to hide the latency. */
  async load(): Promise<TensorflowModel> {
    if (this.model) return this.model
    if (!this.loading) {
      this.loading = loadTensorflowModel(this.source, []).then((m) => {
        this.model = m
        return m
      })
    }
    return this.loading
  }

  get inputShape(): number[] | null {
    return this.model?.inputs[0]?.shape ?? null
  }

  /** Embed the face in a snapshot. Throws on a bad crop; callers decide what that means. */
  async embed(crop: FaceCrop): Promise<Float32Array> {
    const model = await this.load()
    const tensor = await this.prepare(crop)
    const outputs = await model.run([tensor.buffer as ArrayBuffer])
    const raw = new Float32Array(outputs[0]!)
    if (raw.length !== EMBEDDING_DIM) {
      // A different MobileFaceNet export could be 128- or 512-d; still fine,
      // just normalise whatever came out.
      return l2normalize(raw)
    }
    return l2normalize(raw)
  }

  /** The 112x112 RGB float tensor for a crop — separated so it can be inspected in debug builds. */
  async prepare(crop: FaceCrop): Promise<Float32Array> {
    const decoded = await cropFace(crop)
    return preprocessRgba(decoded.rgba, decoded.width, decoded.height)
  }
}

/**
 * Crop + align + resize with expo-image-manipulator, decode with jpeg-js.
 *
 * Steps: read the snapshot size (via a no-op manipulate), pick a square around
 * the box grown by `CROP_MARGIN`, clamp to the frame; rotate that square by
 * -roll (image-manipulator rotates around the centre, and a square crop taken
 * *before* rotating keeps the face centred); centre-crop back to remove the
 * rotation corners; resize to 112; JPEG q92 → base64 → RGBA.
 */
export async function cropFace(crop: FaceCrop): Promise<{ width: number; height: number; rgba: Uint8Array }> {
  const probe = await ImageManipulator.manipulateAsync(crop.uri, [], { base64: false })
  const W = probe.width
  const H = probe.height
  const bx = crop.box.x * W
  const by = crop.box.y * H
  const bw = crop.box.w * W
  const bh = crop.box.h * H
  const side = Math.max(bw, bh) * (1 + 2 * CROP_MARGIN)
  const cx = bx + bw / 2
  const cy = by + bh / 2
  // First square: generous, so a rotation does not pull in black corners.
  const outer = side * Math.SQRT2
  const ox = clamp(cx - outer / 2, 0, Math.max(0, W - 1))
  const oy = clamp(cy - outer / 2, 0, Math.max(0, H - 1))
  const ow = Math.max(8, Math.min(outer, W - ox))
  const oh = Math.max(8, Math.min(outer, H - oy))
  const actions: ImageManipulator.Action[] = [{ crop: { originX: Math.round(ox), originY: Math.round(oy), width: Math.round(ow), height: Math.round(oh) } }]
  const roll = crop.roll ?? 0
  if (Math.abs(roll) > 1) actions.push({ rotate: -roll })
  // After rotating, the face is at the centre of the (possibly enlarged) canvas: centre-crop `side`.
  const first = await ImageManipulator.manipulateAsync(crop.uri, actions, { compress: 1, format: ImageManipulator.SaveFormat.JPEG })
  const innerSide = Math.min(side, first.width, first.height)
  const ix = Math.max(0, Math.round((first.width - innerSide) / 2))
  const iy = Math.max(0, Math.round((first.height - innerSide) / 2))
  const final = await ImageManipulator.manipulateAsync(
    first.uri,
    [
      { crop: { originX: ix, originY: iy, width: Math.round(innerSide), height: Math.round(innerSide) } },
      { resize: { width: EMBEDDING_INPUT, height: EMBEDDING_INPUT } },
    ],
    { compress: 0.92, format: ImageManipulator.SaveFormat.JPEG, base64: true },
  )
  if (!final.base64) throw new Error('image manipulator returned no base64')
  const decoded = decodeJpeg(final.base64)
  if (decoded.width !== EMBEDDING_INPUT || decoded.height !== EMBEDDING_INPUT) {
    throw new Error(`crop came back ${decoded.width}x${decoded.height}`)
  }
  return decoded
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}
