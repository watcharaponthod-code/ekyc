package com.ekyc.liveness.engine

/** Bounds of the largest face, normalised to the (upright) frame: 0..1. */
data class Rect(val x: Float, val y: Float, val w: Float, val h: Float)

/**
 * One detector frame, the only input the engine ever sees. A pure port of
 * `FaceSignal` in `@ekyc/react-native-ekyc`: the engine derives all timing
 * from [t] and never reads a clock, so tests replay whole sessions.
 */
data class FaceSignal(
    /** How many faces the detector saw in this frame. */
    val count: Int,
    /** Head rotation in degrees (ML Kit Euler Y / X / Z). */
    val yaw: Float,
    val pitch: Float,
    val roll: Float,
    /** 0 = closed, 1 = open. */
    val leftEye: Float,
    val rightEye: Float,
    /** 0 = neutral, 1 = smiling. */
    val smile: Float,
    /** Lip gap over mouth width from contours (~0 shut, 0.3+ clearly open). */
    val mouthOpen: Float,
    val box: Rect,
    /** Timestamp in ms. */
    val t: Long,
) {
    companion object {
        /** A frame with no face at all. */
        fun empty(t: Long) = FaceSignal(0, 0f, 0f, 0f, 1f, 1f, 0f, 0f, Rect(0f, 0f, 0f, 0f), t)
    }
}

enum class Framing { OK, NO_FACE, MULTIPLE_FACES, TOO_FAR, TOO_CLOSE, OFF_CENTRE }

enum class Phase { IDLE, RUNNING, COMPLETED, FAILED }

enum class FailureReason { TIMEOUT, FACE_LOST, MULTIPLE_FACES, CANCELLED }

/** Best value a step reached, in the challenge's own unit — the tuning telemetry. */
data class StepMetric(
    val challenge: ChallengeName,
    val phase: Int,
    val best: Float,
    val needed: Float,
    val direction: Direction,
    val t: Long,
)

data class LivenessState(
    val phase: Phase,
    val stepIndex: Int,
    val stepCount: Int,
    val challenge: ChallengeName?,
    val holdProgress: Float,
    val framing: Framing,
    val stepPhase: Int,
    val phaseCount: Int,
    val awaitingRecenter: Boolean,
    val reason: FailureReason?,
    val stepMetrics: Map<String, StepMetric>,
)

sealed class SessionEvent {
    data class Capture(val challenge: ChallengeName, val stepIndex: Int) : SessionEvent()
    data class StepComplete(val challenge: ChallengeName, val stepIndex: Int) : SessionEvent()
    data class Failed(val reason: FailureReason, val stepIndex: Int, val challenge: ChallengeName?) : SessionEvent()
    object Complete : SessionEvent()
}

/**
 * Session knobs. Defaults are the ones tuned on real devices for the React
 * Native edition (`DEFAULT_SESSION_OPTIONS`), kept identical so both editions
 * behave the same.
 */
data class SessionOptions(
    val holdMs: Long = 400,
    val captureAtProgress: Float = 0.5f,
    val minStepMs: Long = 250,
    val perStepTimeoutMs: Long = 12_000,
    val totalTimeoutMs: Long = 60_000,
    val faceLostGraceMs: Long = 4_000,
    val minFaceRatio: Float = 0.22f,
    val maxFaceRatio: Float = 0.75f,
    val maxOffCentre: Float = 0.18f,
    val requireRecenter: Boolean = true,
    val recenterMaxDeg: Float = 12f,
)
