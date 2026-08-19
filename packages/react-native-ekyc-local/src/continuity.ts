/**
 * Face continuity — the lightest "same person all the way through" signal
 * there is, and the only one the light local flow uses.
 *
 * Idea: a single cooperating person's face is on screen for the whole run,
 * moving smoothly. Swapping the person (or holding up a photo halfway) shows
 * up in the detector as the face **disappearing for a moment** or its box
 * **jumping** between two consecutive frames. We track both across the whole
 * session, from ML Kit's per-frame signal, with no image processing at all.
 *
 * What it proves: one continuous face did every movement. What it does not
 * prove: who that face is, or that it is not a screen. It is deliberately
 * advisory-first (`rule`), reported in every session log, so its thresholds
 * are set from real phones — a detector that drops the face for 300 ms at
 * 45° of yaw must not fail an honest user.
 */

import type { FaceSignal } from '@ekyc/react-native-ekyc'

export type ContinuityOptions = {
  /** Longest gap (ms) with no face that still counts as continuous. */
  maxGapMs: number
  /**
   * Largest move of the face-box centre between two consecutive frames with a
   * face, as a fraction of the frame diagonal. Turning the head moves the box
   * a little; a swap moves it a lot (or through a gap).
   */
  maxJump: number
  /** Ignore jumps across gaps longer than this — the gap rule already covers them. */
  jumpWindowMs: number
}

export const DEFAULT_CONTINUITY: ContinuityOptions = {
  maxGapMs: 1500,
  maxJump: 0.35,
  jumpWindowMs: 400,
}

export type ContinuityReport = {
  /** Longest run without a detected face, ms. */
  maxGapMs: number
  /** Largest consecutive-frame centre move (fraction of the diagonal). */
  maxJump: number
  /** How many gaps were longer than the threshold. */
  gaps: number
  /** How many jumps exceeded the threshold. */
  jumps: number
  /** Total frames seen and frames with a face. */
  frames: number
  faceFrames: number
  ok: boolean
}

/**
 * Feed every live frame; read the report at the end. Pure and tiny, so it can
 * be unit-tested with synthetic signals.
 */
export class ContinuityTracker {
  private lastFaceT: number | null = null
  private lastCentre: { x: number; y: number } | null = null
  private gapStart: number | null = null
  private maxGap = 0
  private maxJumpSeen = 0
  private gaps = 0
  private jumps = 0
  private frames = 0
  private faceFrames = 0

  constructor(private readonly options: ContinuityOptions = DEFAULT_CONTINUITY) {}

  feed(signal: FaceSignal): void {
    this.frames++
    if (signal.count === 0) {
      if (this.gapStart === null) this.gapStart = signal.t
      return
    }
    this.faceFrames++
    if (this.gapStart !== null) {
      const gap = signal.t - this.gapStart
      if (gap > this.maxGap) this.maxGap = gap
      if (gap > this.options.maxGapMs) this.gaps++
      this.gapStart = null
    }
    const centre = { x: signal.box.x + signal.box.w / 2, y: signal.box.y + signal.box.h / 2 }
    if (this.lastCentre && this.lastFaceT !== null && signal.t - this.lastFaceT <= this.options.jumpWindowMs) {
      const jump = Math.hypot(centre.x - this.lastCentre.x, centre.y - this.lastCentre.y) / Math.SQRT2
      if (jump > this.maxJumpSeen) this.maxJumpSeen = jump
      if (jump > this.options.maxJump) this.jumps++
    }
    this.lastCentre = centre
    this.lastFaceT = signal.t
  }

  /** Close an open gap at `now` (e.g. the session ended with no face) and report. */
  report(now?: number): ContinuityReport {
    let maxGap = this.maxGap
    let gaps = this.gaps
    if (this.gapStart !== null && now !== undefined) {
      const gap = now - this.gapStart
      if (gap > maxGap) maxGap = gap
      if (gap > this.options.maxGapMs) gaps++
    }
    return {
      maxGapMs: maxGap,
      maxJump: this.maxJumpSeen,
      gaps,
      jumps: this.jumps,
      frames: this.frames,
      faceFrames: this.faceFrames,
      ok: gaps === 0 && this.jumps === 0,
    }
  }
}
