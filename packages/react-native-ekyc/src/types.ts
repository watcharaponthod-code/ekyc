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
  /**
   * Mouth opening, 0 = shut. From ML Kit contours it is the lip gap over the
   * mouth width (~0 shut, 0.3+ clearly open); from landmarks alone a coarser
   * proxy. Only used to pick the capture moment — the server re-measures.
   */
  mouthOpen: number
  /** Bounds of the largest face, normalised to the frame. */
  box: Rect
  /** Timestamp in ms. The session derives all timing from this — it never calls Date.now(). */
  t: number
}

export type ChallengeName = 'center' | 'closeEyes' | 'turnLeft' | 'turnRight' | 'smile' | 'openMouth' | 'nod'

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

/**
 * The best value a step reached, in that challenge's own unit (degrees of
 * turn from neutral, mouth-gap rise, mean eye-open probability...), against
 * what it needed. Keyed `"<stepIndex>:<challenge>"` in `LivenessState`.
 * This is the tuning telemetry: a timeout that says "reached 14 of 25" is
 * actionable; "timed out" is not.
 */
export type StepMetric = {
  challenge: ChallengeName
  best: number
  needed: number
  direction: 'above' | 'below'
  /** Timestamp of the best frame. */
  t: number
}

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
  /** Best-so-far per step (see `StepMetric`). */
  stepMetrics: Record<string, StepMetric>
  reason?: FailureReason
}

export type SessionEvent =
  /** Take the photo now — the pose is being held. */
  | { type: 'capture'; challenge: ChallengeName; stepIndex: number }
  | { type: 'stepComplete'; challenge: ChallengeName; stepIndex: number }
  /** Every step captured; the evidence bundle is ready to upload. */
  | { type: 'complete' }
  | {
      type: 'failed'
      reason: FailureReason
      /** Which step it died on and how close each step got — for the log. */
      stepIndex: number
      challenge: ChallengeName | null
      stepMetrics: Record<string, StepMetric>
    }

export type SessionOptions = {
  /** How long the pose must be held before the step counts (a challenge may override it). */
  holdMs: number
  /** Fraction of the hold at which the photo is taken. 0 = the first confirming frame. */
  captureAtProgress: number
  /**
   * A step cannot complete sooner than this after it starts. Mirrors the
   * server's `step_duration_min_ms`, which rejects faster steps as implausible;
   * without it a pre-emptive turn or a stray blink in the first frames would
   * pass on the phone and fail on the server.
   */
  minStepMs: number
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
  // Fast by default. Stills come from the preview surface (no shutter lag), so
  // the pose only has to be seen for a couple of frames.
  // Tuned on device in both directions: 700 ms read as a slow, posed
  // performance; 120 ms (the fastest the detector can confirm) read as "too
  // quick to trust". 400 ms is a deliberate turn — the ring visibly fills —
  // and gives the head time to reach a clear angle. Blink ignores this: it
  // completes on one frame (see CloseEyesChallenge).
  holdMs: 400,
  // Capture mid-hold, not at the first confirming frame: the phone confirms a
  // turn at 18° while the server wants 22° from neutral, and half-way through
  // the hold the head is well past both. Snapshot capture has no shutter lag,
  // so mid-hold is still mid-hold in the frame.
  captureAtProgress: 0.5,
  minStepMs: 250,
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
  /**
   * The server's own pose thresholds, so the phone confirms a pose only once
   * the server would accept it (see `tuningFromPolicy`). Absent on servers
   * that predate them; the module then falls back to `CHALLENGE_DEFAULTS`.
   */
  turnYawMinDeg?: number
  neutralYawMaxDeg?: number
}

export type CreatedSession = {
  sessionId: string
  nonce: string
  /** Server-issued order. The client must not reorder or substitute these. */
  challenges: ChallengeName[]
  /** Active-flash colour names to show in order (empty/absent when off). */
  flash?: string[]
  /** rPPG burst: capture `frames` stills of the still face over ~`durationMs`. */
  pulse?: { frames: number; durationMs: number } | null
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
    mouthOpen?: number
  }
}

/** Device-integrity evidence. Produced by the host app's attestation provider. */
export type Attestation = { type: 'playIntegrity' | 'appAttest' | 'none'; token?: string }

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
  attestation?: Attestation
  /** Device timestamps (ms) of `pulse_0..pulse_{n-1}`, in key order. */
  pulse?: { times: number[] }
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
