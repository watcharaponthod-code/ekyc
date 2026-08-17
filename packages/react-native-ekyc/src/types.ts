/**
 * Shared types for the eKYC module.
 *
 * Nothing in this file imports react-native — it is the vocabulary that the
 * pure logic (liveness, client) and the UI both speak.
 */

/** A rectangle normalised to the camera frame: every value is 0..1. */
export type Rect = { x: number; y: number; w: number; h: number }

/**
 * One camera frame, reduced to the only facts liveness cares about.
 *
 * This is the seam between the face-detection library and our logic. Swapping
 * MLKit for another detector means rewriting the adapter that produces this
 * type, and nothing else.
 */
export type FaceSignal = {
  /** How many faces the detector saw in this frame. */
  count: number
  /** Head rotation in degrees. Sign convention is device-dependent — see `TurnOptions.yawSign`. */
  yaw: number
  pitch: number
  roll: number
  /** 0 = closed, 1 = open. */
  leftEye: number
  rightEye: number
  /** 0 = neutral, 1 = smiling. */
  smile: number
  /** Bounds of the largest face, normalised to the frame. */
  box: Rect
  /** Timestamp in ms. The session derives all timing from this — it never calls Date.now(). */
  t: number
}

export type ChallengeName = 'center' | 'closeEyes' | 'turnLeft' | 'turnRight' | 'smile'

/**
 * How the user is positioned, independent of which challenge is active.
 *
 * Framing is checked *before* the challenge predicate so we never ask someone
 * to turn their head while they are out of frame. Note that framing
 * deliberately says nothing about head pose: during a turn challenge the head
 * is supposed to be rotated.
 */
export type Framing =
  | 'ok'
  | 'noFace'
  | 'multipleFaces'
  | 'tooFar'
  | 'tooClose'
  | 'offCentre'

export type LivenessPhase =
  | 'idle'
  | 'running'
  | 'uploading'
  | 'passed'
  | 'failed'

export type FailureReason =
  | 'timeout'
  | 'faceLost'
  | 'multipleFaces'
  | 'captureFailed'
  | 'cancelled'

/** The UI is a pure function of this value. */
export type LivenessState = {
  phase: LivenessPhase
  /** Index of the active challenge, 0-based. */
  stepIndex: number
  stepCount: number
  challenge: ChallengeName | null
  /** 0..1 — how much of the required hold has been accumulated. Drives the progress ring. */
  holdProgress: number
  framing: Framing
  reason?: FailureReason
}

export type SessionEvent =
  /** Take the photo now — the pose is being held. */
  | { type: 'capture'; challenge: ChallengeName; stepIndex: number }
  | { type: 'stepComplete'; challenge: ChallengeName; stepIndex: number }
  /** Every step captured; the evidence bundle is ready to upload. */
  | { type: 'complete' }
  | { type: 'failed'; reason: FailureReason }

export type SessionOptions = {
  /** How long the pose must be held before the step counts. */
  holdMs: number
  /** Fraction of the hold at which the photo is taken. Mid-hold, so the pose is certainly held. */
  captureAtProgress: number
  perStepTimeoutMs: number
  totalTimeoutMs: number
  /** How long the face may be absent (or duplicated) before the session fails. */
  faceLostGraceMs: number
  /** Face box width relative to frame width. */
  minFaceRatio: number
  maxFaceRatio: number
  /** Max distance of the face centre from the frame centre, in normalised units. */
  maxOffCentre: number
}

export const DEFAULT_SESSION_OPTIONS: SessionOptions = {
  holdMs: 700,
  captureAtProgress: 0.5,
  perStepTimeoutMs: 12_000,
  totalTimeoutMs: 60_000,
  // Measured on device: the first frames arrive ~1 s after the camera opens
  // and people take a moment to raise the phone to their face. 1.2 s failed
  // sessions before the user had done anything; the per-step timeout still
  // bounds the total wait.
  faceLostGraceMs: 4_000,
  minFaceRatio: 0.22,
  maxFaceRatio: 0.75,
  maxOffCentre: 0.18,
}

// ---------------------------------------------------------------------------
// Protocol types — mirror server/app/schemas.py
// ---------------------------------------------------------------------------

export type Purpose = 'enroll' | 'verify' | 'identify'

export type SessionPolicy = {
  holdMs: number
  perStepTimeoutMs: number
  totalTimeoutMs: number
}

export type CreatedSession = {
  sessionId: string
  nonce: string
  /** Server-issued order. The client must not reorder or substitute these. */
  challenges: ChallengeName[]
  expiresAt: string
  policy: SessionPolicy
}

export type StepObservation = {
  name: ChallengeName
  tStart: number
  tEnd: number
  /** Client-measured values. Diagnostics only — the server re-derives everything from pixels. */
  observed: {
    yaw: number
    pitch: number
    roll: number
    leftEye: number
    rightEye: number
    smile: number
  }
}

export type EvidenceManifest = {
  nonce: string
  startedAt: number
  finishedAt: number
  steps: StepObservation[]
  capture: {
    frameWidth: number
    frameHeight: number
    fps: number
    mirrored: boolean
  }
  attestation?: { type: 'playIntegrity' | 'appAttest' | 'none'; token?: string }
}

/** One captured still, ready to upload. */
export type EvidenceFrame = {
  /** `neutral` for the centre step, otherwise the challenge name. */
  key: string
  /** Local file path produced by `Photo.saveToTemporaryFileAsync()`. */
  uri: string
}

export type EvidenceBundle = {
  manifest: EvidenceManifest
  frames: EvidenceFrame[]
}

export type Decision = {
  decision: 'pass' | 'fail'
  reasons: string[]
  scores: Record<string, unknown>
  personId?: string
  match?: { ok: boolean; score: number }
}

export type Person = {
  id: string
  displayName: string | null
  templateCount: number
  createdAt: string
}

export type EKYCErrorCode =
  | 'CAMERA_PERMISSION'
  | 'NO_CAMERA'
  | 'NETWORK'
  | 'SERVER'
  | 'SESSION_EXPIRED'
  | 'CANCELLED'

export class EKYCError extends Error {
  constructor(
    readonly code: EKYCErrorCode,
    message: string,
    /** Whether showing the user a "try again" button makes sense. */
    readonly retriable: boolean = true,
    readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'EKYCError'
  }
}
