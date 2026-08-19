import type { FaceSignal } from '@ekyc/react-native-ekyc'

/** A well-framed, straight-on face. Override anything you care about. */
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
    box: { x: 0.3, y: 0.3, w: 0.4, h: 0.5 },
    t: 0,
    ...overrides,
  }
}
