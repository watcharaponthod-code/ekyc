/**
 * Webcam → MediaPipe FaceLandmarker → the module's `FaceSignal`. Web only.
 *
 * This is the same shape ML Kit produces on the phone, so the real
 * `LivenessSession`, the same challenge thresholds and the same `yawSign` run
 * unchanged in a browser — which is what lets a head turn in front of the
 * laptop be tested for real, not simulated.
 *
 * Also exposes the 478 landmarks so the preview can draw the mesh.
 */

import { useEffect, useRef, useState } from 'react'
import type { FaceSignal } from '@ekyc/react-native-ekyc/src/types'

// Served by Expo from apps/example/public on web.
const ASSETS = '/mediapipe'

export type MeshPoint = { x: number; y: number }

export type WebcamFace = {
  /** Latest signal, or null before the first frame. */
  signal: FaceSignal | null
  /** Normalised 0..1 landmarks of the largest face, for drawing. */
  mesh: MeshPoint[]
  /** Pairs of landmark indices to connect — MediaPipe's tesselation. */
  connections: Array<[number, number]>
  video: HTMLVideoElement | null
  status: 'loading' | 'running' | 'error'
  error?: string
}

// Same eye-aspect-ratio indices the server uses (mediapipe_landmarks.py).
const RIGHT_EYE = [33, 160, 158, 133, 153, 144]
const LEFT_EYE = [362, 385, 387, 263, 373, 380]

function ear(points: MeshPoint[], idx: number[]): number {
  const [p1, p2, p3, p4, p5, p6] = idx.map((i) => points[i]!)
  const d = (a: MeshPoint, b: MeshPoint) => Math.hypot(a.x - b.x, a.y - b.y)
  const horizontal = d(p1!, p4!)
  return horizontal <= 1e-6 ? 0 : (d(p2!, p6!) + d(p3!, p5!)) / (2 * horizontal)
}

/** Yaw/pitch/roll in degrees from MediaPipe's 4x4 facial transformation matrix (column-major). */
function poseFromMatrix(m: ArrayLike<number>): { yaw: number; pitch: number; roll: number } {
  // column-major: m[col*4 + row]
  const r = (row: number, col: number) => m[col * 4 + row]!
  const sy = Math.hypot(r(0, 0), r(1, 0))
  const deg = (v: number) => (v * 180) / Math.PI
  if (sy > 1e-6) {
    return {
      pitch: deg(Math.atan2(r(2, 1), r(2, 2))),
      yaw: deg(Math.atan2(-r(2, 0), sy)),
      roll: deg(Math.atan2(r(1, 0), r(0, 0))),
    }
  }
  return { pitch: deg(Math.atan2(-r(1, 2), r(1, 1))), yaw: deg(Math.atan2(-r(2, 0), sy)), roll: 0 }
}

/** ML Kit reports eye *open* probability; EAR ~0.30 open, ~0.10 closed. Map one to the other. */
function openProbability(earValue: number): number {
  return Math.max(0, Math.min(1, (earValue - 0.1) / 0.2))
}

export function useWebcamFace(enabled: boolean): WebcamFace {
  const [state, setState] = useState<WebcamFace>({
    signal: null,
    mesh: [],
    connections: [],
    video: null,
    status: 'loading',
  })
  const videoRef = useRef<HTMLVideoElement | null>(null)

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return
    let cancelled = false
    let raf = 0
    let stream: MediaStream | null = null

    const run = async () => {
      try {
        const vision = await import('@mediapipe/tasks-vision')
        const fileset = await vision.FilesetResolver.forVisionTasks(ASSETS)
        const landmarker = await vision.FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: `${ASSETS}/face_landmarker.task`, delegate: 'GPU' },
          runningMode: 'VIDEO',
          numFaces: 3,
          outputFaceBlendshapes: true,
          outputFacialTransformationMatrixes: true,
        })
        const connections = vision.FaceLandmarker.FACE_LANDMARKS_TESSELATION.map(
          (c) => [c.start, c.end] as [number, number],
        )

        const video = document.createElement('video')
        video.playsInline = true
        video.muted = true
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        })
        video.srcObject = stream
        await video.play()
        videoRef.current = video
        if (cancelled) return
        setState((s) => ({ ...s, video, connections, status: 'running' }))

        let lastTs = -1
        const tick = () => {
          if (cancelled) return
          const now = performance.now()
          if (video.readyState >= 2 && now > lastTs) {
            lastTs = now
            const result = landmarker.detectForVideo(video, now)
            const faces = result.faceLandmarks ?? []
            if (faces.length === 0) {
              setState((s) => ({
                ...s,
                mesh: [],
                signal: {
                  count: 0, yaw: 0, pitch: 0, roll: 0, leftEye: 1, rightEye: 1, smile: 0, mouthOpen: 0,
                  box: { x: 0, y: 0, w: 0, h: 0 }, t: Date.now(),
                },
              }))
            } else {
              // largest face by bbox width
              let best = 0
              let bestW = -1
              faces.forEach((f, i) => {
                const xs = f.map((p) => p.x)
                const w = Math.max(...xs) - Math.min(...xs)
                if (w > bestW) { bestW = w; best = i }
              })
              const pts = faces[best]!.map((p) => ({ x: p.x, y: p.y }))
              const xs = pts.map((p) => p.x)
              const ys = pts.map((p) => p.y)
              const box = {
                x: Math.min(...xs), y: Math.min(...ys),
                w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys),
              }
              const matrix = result.facialTransformationMatrixes?.[best]?.data
              const pose = matrix ? poseFromMatrix(matrix) : { yaw: 0, pitch: 0, roll: 0 }
              const shapes = result.faceBlendshapes?.[best]?.categories ?? []
              const bs = (name: string) => shapes.find((c) => c.categoryName === name)?.score ?? 0
              const smile = (bs('mouthSmileLeft') + bs('mouthSmileRight')) / 2
              // jawOpen is what the server measures too, so the preview matches it 1:1.
              const mouthOpen = bs('jawOpen')

              setState((s) => ({
                ...s,
                mesh: pts,
                signal: {
                  count: faces.length,
                  // MediaPipe yaw is positive when the head turns to the
                  // subject's LEFT (their left, i.e. screen-right in a
                  // mirrored preview). ML Kit on Android is the opposite sign
                  // for the same motion, and the module's yawSign default was
                  // calibrated for ML Kit — so flip here to match.
                  yaw: -pose.yaw,
                  pitch: pose.pitch,
                  roll: pose.roll,
                  leftEye: openProbability(ear(pts, LEFT_EYE)),
                  rightEye: openProbability(ear(pts, RIGHT_EYE)),
                  smile,
                  mouthOpen,
                  box,
                  t: Date.now(),
                },
              }))
            }
          }
          raf = requestAnimationFrame(tick)
        }
        raf = requestAnimationFrame(tick)
      } catch (error) {
        if (!cancelled) setState((s) => ({ ...s, status: 'error', error: String(error) }))
      }
    }
    void run()

    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      stream?.getTracks().forEach((t) => t.stop())
      videoRef.current = null
    }
  }, [enabled])

  return state
}
