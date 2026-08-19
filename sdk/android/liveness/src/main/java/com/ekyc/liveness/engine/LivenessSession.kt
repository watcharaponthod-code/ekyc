package com.ekyc.liveness.engine

import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.min

/** Largest time step we trust between two frames; guards against a stalled camera. */
private const val MAX_FRAME_DELTA_MS = 250L

/**
 * Drives the user through the challenge list and decides when the evidence
 * moment is. A faithful port of `LivenessSession` in `@ekyc/react-native-ekyc`
 * (136 tests on that side pin the mechanism; `LivenessSessionTest` here pins
 * the same cases).
 *
 * Pure Kotlin: no Android, no clocks. All time comes from `signal.t`.
 *
 * Each step is a *hold*: the challenge predicate must stay true for `holdMs`;
 * mid-hold a [SessionEvent.Capture] fires. Multi-phase challenges then need
 * their return movement (one confirming frame). Between challenges the head
 * must come back to the centre, so "left then right" is two movements through
 * the middle rather than one held swing.
 */
class LivenessSession(
    private val challenges: List<Challenge>,
    private val options: SessionOptions = SessionOptions(),
    private val onEvent: (SessionEvent) -> Unit = {},
) {
    init { require(challenges.isNotEmpty()) { "LivenessSession needs at least one challenge" } }

    private var phase = Phase.IDLE
    private var stepIndex = 0
    private var framing = Framing.NO_FACE
    private var reason: FailureReason? = null
    private var startedAt = 0L
    private var stepStartedAt = 0L
    private var lastT = 0L
    private var heldMs = 0L
    private var capturedThisRun = false
    private var badFramingSince: Long? = null
    private var badFramingKind: Framing? = null
    /** The signal at the moment `center` completed — every later challenge is judged relative to it. */
    var baseline: FaceSignal? = null
        private set
    private val metrics = LinkedHashMap<String, StepMetric>()
    private var stepPhase = 0
    private var memo = ChallengeMemo()
    private var awaitingRecenter = false

    val state: LivenessState
        get() {
            val c = challenges.getOrNull(stepIndex)
            val hold = currentHold
            return LivenessState(
                phase = phase,
                stepIndex = stepIndex,
                stepCount = challenges.size,
                challenge = c?.name,
                holdProgress = if (hold > 0) min(1f, heldMs.toFloat() / hold) else 0f,
                framing = framing,
                stepPhase = stepPhase,
                phaseCount = c?.phaseCount ?: 1,
                awaitingRecenter = awaitingRecenter,
                reason = reason,
                stepMetrics = LinkedHashMap(metrics),
            )
        }

    fun start(now: Long): LivenessState {
        phase = Phase.RUNNING
        stepIndex = 0
        framing = Framing.NO_FACE
        reason = null
        startedAt = now
        stepStartedAt = now
        lastT = now
        resetHold()
        badFramingSince = null
        badFramingKind = null
        baseline = null
        metrics.clear()
        stepPhase = 0
        memo = ChallengeMemo()
        awaitingRecenter = false
        return state
    }

    private val currentHold: Long
        get() = challenges.getOrNull(stepIndex)?.holdMs ?: options.holdMs

    /** Feed one detector frame. Returns the new state. */
    fun update(signal: FaceSignal): LivenessState {
        if (phase != Phase.RUNNING) return state
        val delta = (signal.t - lastT).coerceIn(0, MAX_FRAME_DELTA_MS)
        lastT = signal.t

        if (signal.t - startedAt > options.totalTimeoutMs) return fail(FailureReason.TIMEOUT)
        if (signal.t - stepStartedAt > options.perStepTimeoutMs) return fail(FailureReason.TIMEOUT)

        framing = evaluateFraming(signal)
        if (framing == Framing.NO_FACE || framing == Framing.MULTIPLE_FACES) {
            val expired = trackBadFraming(framing, signal.t)
            resetHold()
            if (expired) return fail(if (framing == Framing.MULTIPLE_FACES) FailureReason.MULTIPLE_FACES else FailureReason.FACE_LOST)
            return state
        }
        badFramingSince = null
        badFramingKind = null
        if (framing != Framing.OK) {
            resetHold()
            return state
        }
        if (signal.t - stepStartedAt < options.minStepMs) return state

        val challenge = challenges[stepIndex]
        if (awaitingRecenter) {
            if (!isRecentered(signal)) return state
            awaitingRecenter = false
        }

        recordMetric(challenge, signal)
        val satisfied = challenge.isSatisfied(signal, baseline, stepPhase, memo)

        if (stepPhase == challenge.capturePhase) {
            if (!satisfied) {
                resetHold()
                return state
            }
            heldMs += delta
            val hold = currentHold
            val progress = if (hold > 0) heldMs.toFloat() / hold else 1f
            if (!capturedThisRun && progress >= options.captureAtProgress) {
                capturedThisRun = true
                onEvent(SessionEvent.Capture(challenge.name, stepIndex))
            }
            if (heldMs < hold) return state
            if (stepIndex == 0) baseline = signal
            phaseDone(challenge, signal)
            return state
        }
        // Event phase (eyes open again, mouth closed, back to distance): one
        // confirming frame moves on; earlier phases are never undone.
        if (satisfied) phaseDone(challenge, signal)
        return state
    }

    fun abort(reason: FailureReason): LivenessState {
        if (phase == Phase.COMPLETED || phase == Phase.FAILED) return state
        return fail(reason)
    }

    private fun phaseDone(challenge: Challenge, signal: FaceSignal) {
        if (stepPhase < challenge.phaseCount - 1) {
            stepPhase += 1
            heldMs = 0
            return
        }
        onEvent(SessionEvent.StepComplete(challenge.name, stepIndex))
        advance(signal.t)
    }

    private fun isRecentered(signal: FaceSignal): Boolean {
        val b = baseline ?: return true
        val tol = options.recenterMaxDeg
        return abs(signal.yaw - b.yaw) <= tol && abs(signal.pitch - b.pitch) <= tol
    }

    private fun advance(now: Long) {
        stepIndex += 1
        resetHold()
        stepPhase = 0
        memo = ChallengeMemo()
        stepStartedAt = now
        val next = challenges.getOrNull(stepIndex)
        awaitingRecenter = options.requireRecenter && stepIndex >= 2 && next != null && next.requiresRecenter && baseline != null
        if (stepIndex >= challenges.size) {
            phase = Phase.COMPLETED
            onEvent(SessionEvent.Complete)
        }
    }

    private fun fail(reason: FailureReason): LivenessState {
        phase = Phase.FAILED
        this.reason = reason
        resetHold()
        onEvent(SessionEvent.Failed(reason, stepIndex, challenges.getOrNull(stepIndex)?.name))
        return state
    }

    private fun recordMetric(challenge: Challenge, signal: FaceSignal) {
        val m = challenge.metric(signal, baseline, stepPhase, memo)
        val key = if (stepPhase == 0) "$stepIndex:${challenge.name.wire}" else "$stepIndex:${challenge.name.wire}#$stepPhase"
        val prev = metrics[key]
        val better = prev == null || (if (m.direction == Direction.ABOVE) m.value > prev.best else m.value < prev.best)
        if (better) {
            metrics[key] = StepMetric(challenge.name, stepPhase, m.value, m.needed, m.direction, signal.t)
        } else if (prev != null && prev.needed != m.needed) {
            metrics[key] = prev.copy(needed = m.needed)
        }
    }

    private fun resetHold() {
        heldMs = 0
        capturedThisRun = false
    }

    private fun trackBadFraming(kind: Framing, now: Long): Boolean {
        if (badFramingKind != kind) {
            badFramingKind = kind
            badFramingSince = now
            return false
        }
        val since = badFramingSince ?: run { badFramingSince = now; return false }
        return now - since > options.faceLostGraceMs
    }

    /** Position checks only — never pose (during a turn the head *should* be rotated). */
    private fun evaluateFraming(s: FaceSignal): Framing {
        if (s.count == 0) return Framing.NO_FACE
        if (s.count > 1) return Framing.MULTIPLE_FACES
        if (s.box.w < options.minFaceRatio) return Framing.TOO_FAR
        if (s.box.w > options.maxFaceRatio) return Framing.TOO_CLOSE
        val cx = s.box.x + s.box.w / 2
        val cy = s.box.y + s.box.h / 2
        if (hypot(cx - 0.5f, cy - 0.5f) > options.maxOffCentre) return Framing.OFF_CENTRE
        return Framing.OK
    }
}
