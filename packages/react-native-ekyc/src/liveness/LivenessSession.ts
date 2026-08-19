import {
  DEFAULT_SESSION_OPTIONS,
  type FaceSignal,
  type FailureReason,
  type Framing,
  type LivenessState,
  type SessionEvent,
  type SessionOptions,
  type StepMetric,
} from '../types'
import type { Challenge } from './Challenge'

/** Largest time step we trust between two frames; guards against a stalled camera. */
const MAX_FRAME_DELTA_MS = 250

/**
 * Drives the user through the challenge list and decides when to take a photo.
 *
 * Pure TypeScript: no React, no react-native, no timers, no `Date.now()`. All
 * time comes from `signal.t`, so a test can replay a whole session in a loop
 * and assert on every transition.
 *
 * Each step is a *hold*: the challenge predicate must stay true for
 * `holdMs`. Halfway through the hold the session emits a `capture` event —
 * the pose is certainly being held at that moment, which is what makes a still
 * photo valid evidence despite shutter latency.
 */
export class LivenessSession {
  private readonly options: SessionOptions

  private phase: LivenessState['phase'] = 'idle'
  private stepIndex = 0
  private framing: Framing = 'noFace'
  private reason: FailureReason | undefined

  private startedAt = 0
  private stepStartedAt = 0
  private lastT = 0
  private heldMs = 0
  private capturedThisRun = false
  private badFramingSince: number | null = null
  private badFramingKind: Framing | null = null
  /** The signal at the moment `center` completed — every later challenge is judged relative to it. */
  private baseline: FaceSignal | null = null
  /** Best value each step reached, in the challenge's own unit — the tuning telemetry. */
  private metrics: Record<string, StepMetric> = {}

  constructor(
    private readonly challenges: Challenge[],
    options: Partial<SessionOptions> = {},
    private readonly onEvent: (event: SessionEvent) => void = () => {},
  ) {
    if (challenges.length === 0) throw new Error('LivenessSession needs at least one challenge')
    this.options = { ...DEFAULT_SESSION_OPTIONS, ...options }
  }

  get state(): LivenessState {
    const challenge = this.challenges[this.stepIndex]
    return {
      phase: this.phase,
      stepIndex: this.stepIndex,
      stepCount: this.challenges.length,
      challenge: challenge ? challenge.name : null,
      holdProgress: this.currentHold > 0 ? Math.min(1, this.heldMs / this.currentHold) : 0,
      framing: this.framing,
      stepMetrics: { ...this.metrics },
      ...(this.reason ? { reason: this.reason } : {}),
    }
  }

  /** The neutral-frame signal, once `center` has completed. */
  get neutralBaseline(): FaceSignal | null {
    return this.baseline
  }

  start(now: number): LivenessState {
    this.phase = 'running'
    this.stepIndex = 0
    this.framing = 'noFace'
    this.reason = undefined
    this.startedAt = now
    this.stepStartedAt = now
    this.lastT = now
    this.resetHold()
    this.badFramingSince = null
    this.badFramingKind = null
    this.baseline = null
    this.metrics = {}
    return this.state
  }

  /** Hold required by the current step: the challenge's own, else the session's. */
  private get currentHold(): number {
    return this.challenges[this.stepIndex]?.holdMs ?? this.options.holdMs
  }

  /** Feed one camera frame. Returns the state the UI should render. */
  feed(signal: FaceSignal): LivenessState {
    if (this.phase !== 'running') return this.state

    const delta = Math.min(MAX_FRAME_DELTA_MS, Math.max(0, signal.t - this.lastT))
    this.lastT = signal.t

    if (signal.t - this.startedAt > this.options.totalTimeoutMs) return this.fail('timeout')
    if (signal.t - this.stepStartedAt > this.options.perStepTimeoutMs) return this.fail('timeout')

    this.framing = this.evaluateFraming(signal)

    if (this.framing === 'noFace' || this.framing === 'multipleFaces') {
      const expired = this.trackBadFraming(this.framing, signal.t)
      this.resetHold()
      if (expired) return this.fail(this.framing === 'multipleFaces' ? 'multipleFaces' : 'faceLost')
      return this.state
    }

    this.badFramingSince = null
    this.badFramingKind = null

    if (this.framing !== 'ok') {
      this.resetHold()
      return this.state
    }

    // Too soon after the step began to count — see `SessionOptions.minStepMs`.
    if (signal.t - this.stepStartedAt < this.options.minStepMs) return this.state

    const challenge = this.challenges[this.stepIndex]!
    this.recordMetric(challenge, signal)
    if (!challenge.isSatisfied(signal, this.baseline)) {
      this.resetHold()
      return this.state
    }

    this.heldMs += delta

    const hold = this.currentHold
    const progress = hold > 0 ? this.heldMs / hold : 1
    if (!this.capturedThisRun && progress >= this.options.captureAtProgress) {
      this.capturedThisRun = true
      this.onEvent({ type: 'capture', challenge: challenge.name, stepIndex: this.stepIndex })
    }

    if (this.heldMs >= hold) {
      // The centre step's last confirming frame becomes the baseline every
      // later challenge is measured against.
      if (this.stepIndex === 0) this.baseline = signal
      this.onEvent({ type: 'stepComplete', challenge: challenge.name, stepIndex: this.stepIndex })
      this.advance(signal.t)
    }

    return this.state
  }

  /** All steps captured; evidence is being uploaded. */
  notifyUploading(): LivenessState {
    if (this.phase === 'failed') return this.state
    this.phase = 'uploading'
    return this.state
  }

  /** The server has spoken. */
  notifyResult(passed: boolean, reason: FailureReason = 'cancelled'): LivenessState {
    this.phase = passed ? 'passed' : 'failed'
    this.reason = passed ? undefined : reason
    return this.state
  }

  abort(reason: FailureReason): LivenessState {
    if (this.phase === 'passed' || this.phase === 'failed') return this.state
    return this.fail(reason)
  }

  // -------------------------------------------------------------------------

  private advance(now: number): void {
    this.stepIndex += 1
    this.resetHold()
    this.stepStartedAt = now
    if (this.stepIndex >= this.challenges.length) {
      this.phase = 'uploading'
      this.onEvent({ type: 'complete' })
    }
  }

  private fail(reason: FailureReason): LivenessState {
    this.phase = 'failed'
    this.reason = reason
    this.resetHold()
    const challenge = this.challenges[this.stepIndex]
    this.onEvent({
      type: 'failed',
      reason,
      stepIndex: this.stepIndex,
      challenge: challenge ? challenge.name : null,
      stepMetrics: { ...this.metrics },
    })
    return this.state
  }

  /** Keep the best value this step has reached (max for 'above', min for 'below'). */
  private recordMetric(challenge: Challenge, signal: FaceSignal): void {
    const m = challenge.metric(signal, this.baseline)
    if (!m) return
    const key = `${this.stepIndex}:${challenge.name}`
    const prev = this.metrics[key]
    const better = !prev || (m.direction === 'above' ? m.value > prev.best : m.value < prev.best)
    if (better) {
      this.metrics[key] = { challenge: challenge.name, best: m.value, needed: m.needed, direction: m.direction, t: signal.t }
    } else if (prev) {
      // keep `needed` fresh (it can move once the baseline lands)
      prev.needed = m.needed
    }
  }

  private resetHold(): void {
    this.heldMs = 0
    this.capturedThisRun = false
  }

  /** Returns true once the bad framing has lasted longer than the grace period. */
  private trackBadFraming(kind: Framing, now: number): boolean {
    if (this.badFramingKind !== kind) {
      this.badFramingKind = kind
      this.badFramingSince = now
      return false
    }
    if (this.badFramingSince === null) {
      this.badFramingSince = now
      return false
    }
    return now - this.badFramingSince > this.options.faceLostGraceMs
  }

  /**
   * Position checks only — never pose. During a turn the head *should* be
   * rotated, so pose belongs to the challenge predicate, not here.
   */
  private evaluateFraming(signal: FaceSignal): Framing {
    if (signal.count === 0) return 'noFace'
    if (signal.count > 1) return 'multipleFaces'

    const { minFaceRatio, maxFaceRatio, maxOffCentre } = this.options
    if (signal.box.w < minFaceRatio) return 'tooFar'
    if (signal.box.w > maxFaceRatio) return 'tooClose'

    const cx = signal.box.x + signal.box.w / 2
    const cy = signal.box.y + signal.box.h / 2
    const offset = Math.hypot(cx - 0.5, cy - 0.5)
    if (offset > maxOffCentre) return 'offCentre'

    return 'ok'
  }
}
