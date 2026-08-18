/**
 * Design tokens and capture-frame geometry.
 *
 * The numbers are not arbitrary — they come from measuring what shipped
 * identity SDKs actually do (see docs/ui-research.md):
 *
 * - **Oval aspect 1.42.** Persona ships 1.46, Sumsub 1.443, FaceTec 1.47–1.70,
 *   Veriff 1.50, Onfido 1.24. 1.42 sits inside that band and flatters a face
 *   without cropping foreheads on tall devices.
 * - **Near-opaque scrim.** Every decompiled native SDK uses an opaque or
 *   near-opaque backdrop (Persona `#0B051D`, Sumsub `?colorBackground`, AWS
 *   white). Translucency lets background clutter compete with the instruction
 *   text. 0.90 keeps a hint of motion outside the oval so the preview still
 *   reads as live.
 * - **No brand colour on the capture screen.** WeChat's capture accent is
 *   `#5065FF`, nowhere near its `#07C160` brand. This screen's palette is
 *   governed by contrast against live video, not by a brand kit.
 */

export type EKYCTheme = {
  colors: {
    background: string
    scrim: string
    surface: string
    accent: string
    accentSoft: string
    success: string
    danger: string
    text: string
    textDim: string
    ovalIdle: string
    /** Text/icon colour on top of `accent`. Defaults to near-black (right for the default light-blue accent). */
    onAccent?: string
  }
  radii: { pill: number; card: number }
  spacing: (steps: number) => number
  typography: {
    instruction: { fontSize: number; lineHeight: number; fontWeight: '600' }
    title: { fontSize: number; lineHeight: number; fontWeight: '700' }
    body: { fontSize: number; lineHeight: number }
    caption: { fontSize: number; lineHeight: number }
  }
  frame: {
    /** Oval width as a fraction of the screen width. */
    widthRatio: number
    /** Oval height / oval width. */
    aspect: number
    /** Vertical offset from centre, as a fraction of screen height. Negative = up. */
    offsetRatio: number
    strokeWidth: number
    ringWidth: number
    ringGap: number
  }
  motion: {
    /** Instruction cross-fade. Persona uses 500 ms for the same transition. */
    instructionMs: number
    /** Hold-ring follow time. Short enough to feel physically attached to the pose. */
    ringMs: number
    /** Spring for the oval's step-complete pulse. Sumsub's spring is 0.75 / 200. */
    spring: { damping: number; stiffness: number; mass: number }
  }
}

export const defaultTheme: EKYCTheme = {
  colors: {
    background: '#070A12',
    scrim: 'rgba(7, 10, 18, 0.90)',
    surface: '#121826',
    accent: '#6C8CFF',
    accentSoft: 'rgba(108, 140, 255, 0.22)',
    success: '#4ADE80',
    danger: '#FB7185',
    text: '#FFFFFF',
    textDim: 'rgba(255, 255, 255, 0.62)',
    ovalIdle: 'rgba(255, 255, 255, 0.34)',
  },
  radii: { pill: 999, card: 20 },
  spacing: (steps: number) => steps * 8,
  typography: {
    instruction: { fontSize: 20, lineHeight: 28, fontWeight: '600' },
    title: { fontSize: 24, lineHeight: 32, fontWeight: '700' },
    body: { fontSize: 15, lineHeight: 22 },
    caption: { fontSize: 13, lineHeight: 18 },
  },
  frame: {
    widthRatio: 0.74,
    aspect: 1.42,
    offsetRatio: -0.05,
    strokeWidth: 3,
    ringWidth: 5,
    ringGap: 14,
  },
  motion: {
    instructionMs: 220,
    ringMs: 120,
    spring: { damping: 15, stiffness: 200, mass: 1 },
  },
}

export type FrameGeometry = {
  cx: number
  cy: number
  rx: number
  ry: number
  ringRx: number
  ringRy: number
}

/** Where the oval sits, given the screen. Pure — trivially testable. */
export function frameGeometry(
  width: number,
  height: number,
  frame: EKYCTheme['frame'] = defaultTheme.frame,
): FrameGeometry {
  const ovalWidth = width * frame.widthRatio
  const rx = ovalWidth / 2
  const ry = (ovalWidth * frame.aspect) / 2
  return {
    cx: width / 2,
    cy: height / 2 + height * frame.offsetRatio,
    rx,
    ry,
    ringRx: rx + frame.ringGap,
    ringRy: ry + frame.ringGap,
  }
}

/** Ramanujan's ellipse-perimeter approximation — accurate to ~1e-5 here. */
export function ellipsePerimeter(rx: number, ry: number): number {
  const h = ((rx - ry) * (rx - ry)) / ((rx + ry) * (rx + ry))
  return Math.PI * (rx + ry) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)))
}

/**
 * Dash pattern for the hold ring: four corner brackets that seal into a
 * closed ring as the hold completes.
 *
 * The shape is Regula's — at progress 0 you see four short arcs, at 1 an
 * unbroken ring — expressed as a dash array so it works on an ellipse, where
 * per-quadrant SVG arc maths would be painful.
 */
export function holdRingDash(perimeter: number, progress: number): [number, number] {
  const quadrant = perimeter / 4
  const clamped = Math.max(0, Math.min(1, progress))
  const filled = quadrant * (0.42 + 0.58 * clamped)
  return [filled, Math.max(0, quadrant - filled)]
}
