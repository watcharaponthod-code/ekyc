/**
 * Mouth opening from ML Kit geometry — pure, react-native-free, unit-tested.
 *
 * The phone uses this only to pick the moment for the `openMouth` snapshot;
 * the server re-measures `jawOpen` from MediaPipe blendshapes on that frame.
 */

export type Pt = { x: number; y: number }

/** The subset of ML Kit's `Face` this needs, kept structural so tests need no native types. */
export type MouthGeometry = {
  contours?: {
    UPPER_LIP_TOP?: Pt[]
    UPPER_LIP_BOTTOM?: Pt[]
    LOWER_LIP_TOP?: Pt[]
    LOWER_LIP_BOTTOM?: Pt[]
  }
  landmarks?: {
    NOSE_BASE?: Pt
    MOUTH_BOTTOM?: Pt
    MOUTH_LEFT?: Pt
    MOUTH_RIGHT?: Pt
  }
}


function centroid(points: Pt[] | undefined): Pt | null {
  if (!points || points.length === 0) return null
  let x = 0
  let y = 0
  for (const p of points) {
    x += p.x
    y += p.y
  }
  return { x: x / points.length, y: y / points.length }
}

/**
 * Mouth opening from ML Kit, 0 = shut.
 *
 * With contours: the vertical gap between the upper lip's bottom edge and the
 * lower lip's top edge, over the mouth width — ~0 with the lips together,
 * 0.3–0.6 for a clearly open mouth, independent of distance to the camera.
 * Without contours (landmarks only): the nose-base → mouth-bottom distance
 * over the mouth width, which is ~0.55 shut and rises past ~0.85 open — a
 * coarser proxy, remapped onto the same 0..1-ish scale so one threshold
 * serves both. The server never sees this number; it re-measures `jawOpen`.
 */
export function mouthOpenness(face: MouthGeometry): number {
  const c = face.contours
  const upper = centroid(c?.UPPER_LIP_BOTTOM)
  const lower = centroid(c?.LOWER_LIP_TOP)
  const lipsWidth = mouthWidth(c?.UPPER_LIP_TOP) ?? mouthWidth(c?.LOWER_LIP_BOTTOM)
  if (upper && lower && lipsWidth && lipsWidth > 1) {
    return Math.max(0, (lower.y - upper.y) / lipsWidth)
  }
  const l = face.landmarks
  if (l?.NOSE_BASE && l.MOUTH_BOTTOM && l.MOUTH_LEFT && l.MOUTH_RIGHT) {
    const width = Math.hypot(l.MOUTH_RIGHT.x - l.MOUTH_LEFT.x, l.MOUTH_RIGHT.y - l.MOUTH_LEFT.y)
    if (width > 1) {
      const ratio = (l.MOUTH_BOTTOM.y - l.NOSE_BASE.y) / width
      // shut ~0.55, wide open ~1.0 → 0 .. ~0.6 on the contour scale
      return Math.max(0, (ratio - 0.55) * 1.3)
    }
  }
  return 0
}

function mouthWidth(points: Pt[] | undefined): number | null {
  if (!points || points.length < 2) return null
  let minX = Infinity
  let maxX = -Infinity
  for (const p of points) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
  }
  return maxX - minX
}

