/**
 * Native stand-in for the web-only webcam hook.
 *
 * Metro resolves `useWebcamFace.web.ts` on web and this file elsewhere, so
 * `@mediapipe/tasks-vision` — a browser-only package whose bundle uses dynamic
 * `import()` that Hermes cannot compile — never enters the Android/iOS bundle.
 * The phone has its own camera path (EKYCCamera); this exists only so the
 * shared UIPreview module still type-checks and loads there.
 */

import type { FaceSignal } from '@ekyc/react-native-ekyc/src/types'

export type MeshPoint = { x: number; y: number }

export type WebcamFace = {
  signal: FaceSignal | null
  mesh: MeshPoint[]
  connections: Array<[number, number]>
  video: null
  status: 'loading' | 'running' | 'error'
  error?: string
}

export function useWebcamFace(_enabled: boolean): WebcamFace {
  return { signal: null, mesh: [], connections: [], video: null, status: 'error', error: 'web only' }
}
