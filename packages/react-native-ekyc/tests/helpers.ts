import type { FaceSignal } from '../src/types'

/** A well-framed, straight-on, eyes-open face. Override anything you care about. */
export function signal(overrides: Partial<FaceSignal> = {}): FaceSignal {
  return {
    count: 1,
    yaw: 0,
    pitch: 0,
    roll: 0,
    leftEye: 0.95,
    rightEye: 0.95,
    smile: 0.05,
    mouthOpen: 0.02,
    box: { x: 0.3, y: 0.3, w: 0.4, h: 0.4 },
    t: 0,
    ...overrides,
  }
}

/**
 * Feed a session a run of identical frames at a fixed frame rate.
 * Returns the timestamp after the last frame so callers can keep the clock going.
 */
export function feedFor(
  session: { feed(s: FaceSignal): unknown },
  base: Partial<FaceSignal>,
  durationMs: number,
  startT: number,
  stepMs = 33,
): number {
  let t = startT
  const end = startT + durationMs
  while (t < end) {
    t += stepMs
    session.feed(signal({ ...base, t }))
  }
  return t
}
