package com.ekyc.liveness.engine

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.sign

enum class ChallengeName(val wire: String) {
    CENTER("center"),
    CLOSE_EYES("closeEyes"),
    TURN_LEFT("turnLeft"),
    TURN_RIGHT("turnRight"),
    SMILE("smile"),
    OPEN_MOUTH("openMouth"),
    NOD("nod"),
    MOVE_CLOSER("moveCloser"),
    MOVE_FARTHER("moveFarther");

    companion object {
        fun fromWire(s: String): ChallengeName = values().firstOrNull { it.wire == s }
            ?: throw IllegalArgumentException("unknown challenge: $s")
    }
}

enum class Direction { ABOVE, BELOW }

data class ChallengeMetric(val value: Float, val needed: Float, val direction: Direction)

/** Scratch memory for multi-phase challenges (a nod remembers which way it went). */
class ChallengeMemo {
    var nodSign: Int = 0
}

/**
 * Thresholds, and where they come from — a 1:1 port of `CHALLENGE_DEFAULTS`
 * in `@ekyc/react-native-ekyc` (see that file for the device measurements
 * behind every number). Every value is a *change from the person's own
 * neutral frame*.
 */
data class ChallengeTuning(
    val centerMaxYaw: Float = 12f,
    val centerMaxPitch: Float = 12f,
    /** Server rule 22° from neutral + 3° margin. Real turns measured 27–63°. */
    val turnMinYawDelta: Float = 25f,
    /** ML Kit: positive yaw = a turn to the user's own left (calibrated on device). */
    val yawSign: Int = -1,
    val nodMinPitchDelta: Float = 8f,
    val nodReturnFraction: Float = 0.4f,
    /** Mouth contour-gap rise over the neutral frame. Real opens measured 0.28–0.39 over ~0.04 shut. */
    val mouthOpenMinDelta: Float = 0.18f,
    val mouthOpenMinAbsolute: Float = 0.3f,
    val mouthCloseFraction: Float = 0.5f,
    val eyesClosedMaxOpen: Float = 0.5f,
    val eyesReopenMinOpen: Float = 0.7f,
    val smileMin: Float = 0.7f,
    val smileRelaxFraction: Float = 0.5f,
    val moveCloserMinGrow: Float = 0.25f,
    val moveFartherMinShrink: Float = 0.2f,
    val moveReturnBand: Float = 0.1f,
)

/**
 * One step of the flow. Predicates are judged against the neutral baseline;
 * multi-phase challenges need a movement *and its return* (eyes shut → open,
 * mouth open → closed, closer → back), so no single held pose or still photo
 * completes them.
 */
abstract class Challenge(protected val tuning: ChallengeTuning) {
    abstract val name: ChallengeName
    /** Hold required in the evidence phase; null = session default. 0 = event (one frame). */
    open val holdMs: Long? = null
    open val phaseCount: Int = 1
    /** Which phase the evidence frame is taken in (default: the last). */
    open val capturePhase: Int get() = phaseCount - 1
    /** Whether the head must come back to the centre before this step counts. */
    open val requiresRecenter: Boolean = true

    abstract fun isSatisfied(signal: FaceSignal, baseline: FaceSignal?, phase: Int, memo: ChallengeMemo): Boolean
    abstract fun metric(signal: FaceSignal, baseline: FaceSignal?, phase: Int, memo: ChallengeMemo): ChallengeMetric
}

class CenterChallenge(t: ChallengeTuning) : Challenge(t) {
    override val name = ChallengeName.CENTER
    override val requiresRecenter = false
    override fun isSatisfied(signal: FaceSignal, baseline: FaceSignal?, phase: Int, memo: ChallengeMemo) =
        abs(signal.yaw) <= tuning.centerMaxYaw && abs(signal.pitch) <= tuning.centerMaxPitch
    override fun metric(signal: FaceSignal, baseline: FaceSignal?, phase: Int, memo: ChallengeMemo) =
        ChallengeMetric(max(abs(signal.yaw), abs(signal.pitch)), tuning.centerMaxYaw, Direction.BELOW)
}

class CloseEyesChallenge(t: ChallengeTuning) : Challenge(t) {
    override val name = ChallengeName.CLOSE_EYES
    override val holdMs: Long = 0
    override val phaseCount = 2
    override val capturePhase = 0
    private fun open(s: FaceSignal) = (s.leftEye + s.rightEye) / 2f
    override fun isSatisfied(signal: FaceSignal, baseline: FaceSignal?, phase: Int, memo: ChallengeMemo) =
        if (phase == 0) open(signal) <= tuning.eyesClosedMaxOpen else open(signal) >= tuning.eyesReopenMinOpen
    override fun metric(signal: FaceSignal, baseline: FaceSignal?, phase: Int, memo: ChallengeMemo) =
        if (phase == 0) ChallengeMetric(open(signal), tuning.eyesClosedMaxOpen, Direction.BELOW)
        else ChallengeMetric(open(signal), tuning.eyesReopenMinOpen, Direction.ABOVE)
}

private fun turnDelta(signal: FaceSignal, baseline: FaceSignal?, sign: Int, left: Boolean): Float {
    val delta = signal.yaw - (baseline?.yaw ?: 0f)
    return if (left) -delta * sign else delta * sign
}

class TurnChallenge(t: ChallengeTuning, private val left: Boolean) : Challenge(t) {
    override val name = if (left) ChallengeName.TURN_LEFT else ChallengeName.TURN_RIGHT
    override fun isSatisfied(signal: FaceSignal, baseline: FaceSignal?, phase: Int, memo: ChallengeMemo) =
        turnDelta(signal, baseline, tuning.yawSign, left) >= tuning.turnMinYawDelta
    override fun metric(signal: FaceSignal, baseline: FaceSignal?, phase: Int, memo: ChallengeMemo) =
        ChallengeMetric(turnDelta(signal, baseline, tuning.yawSign, left), tuning.turnMinYawDelta, Direction.ABOVE)
}

class SmileChallenge(t: ChallengeTuning) : Challenge(t) {
    override val name = ChallengeName.SMILE
    override val phaseCount = 2
    override val capturePhase = 0
    override fun isSatisfied(signal: FaceSignal, baseline: FaceSignal?, phase: Int, memo: ChallengeMemo) =
        if (phase == 0) signal.smile >= tuning.smileMin else signal.smile <= tuning.smileMin * tuning.smileRelaxFraction
    override fun metric(signal: FaceSignal, baseline: FaceSignal?, phase: Int, memo: ChallengeMemo) =
        if (phase == 0) ChallengeMetric(signal.smile, tuning.smileMin, Direction.ABOVE)
        else ChallengeMetric(signal.smile, tuning.smileMin * tuning.smileRelaxFraction, Direction.BELOW)
}

/** The rigid-mask counter-measure: open (held) → closed again. */
class OpenMouthChallenge(t: ChallengeTuning) : Challenge(t) {
    override val name = ChallengeName.OPEN_MOUTH
    override val phaseCount = 2
    override val capturePhase = 0
    private fun needed(b: FaceSignal?) = if (b != null) b.mouthOpen + tuning.mouthOpenMinDelta else tuning.mouthOpenMinAbsolute
    private fun closedBelow(b: FaceSignal?) = (b?.mouthOpen ?: 0f) + tuning.mouthOpenMinDelta * tuning.mouthCloseFraction
    override fun isSatisfied(signal: FaceSignal, baseline: FaceSignal?, phase: Int, memo: ChallengeMemo) =
        if (phase == 0) signal.mouthOpen >= needed(baseline) else signal.mouthOpen <= closedBelow(baseline)
    override fun metric(signal: FaceSignal, baseline: FaceSignal?, phase: Int, memo: ChallengeMemo) =
        if (phase == 0) ChallengeMetric(signal.mouthOpen, needed(baseline), Direction.ABOVE)
        else ChallengeMetric(signal.mouthOpen, closedBelow(baseline), Direction.BELOW)
}

/** Nod: away from the resting pitch (either direction), then back near it. */
class NodChallenge(t: ChallengeTuning) : Challenge(t) {
    override val name = ChallengeName.NOD
    override val phaseCount = 2
    override val holdMs: Long = 0
    override fun isSatisfied(signal: FaceSignal, baseline: FaceSignal?, phase: Int, memo: ChallengeMemo): Boolean {
        val delta = signal.pitch - (baseline?.pitch ?: 0f)
        if (phase == 0) {
            if (abs(delta) < tuning.nodMinPitchDelta) return false
            memo.nodSign = sign(delta).toInt()
            return true
        }
        if (memo.nodSign == 0) return false
        return abs(delta) <= tuning.nodMinPitchDelta * tuning.nodReturnFraction
    }
    override fun metric(signal: FaceSignal, baseline: FaceSignal?, phase: Int, memo: ChallengeMemo): ChallengeMetric {
        val delta = abs(signal.pitch - (baseline?.pitch ?: 0f))
        return if (phase == 0) ChallengeMetric(delta, tuning.nodMinPitchDelta, Direction.ABOVE)
        else ChallengeMetric(delta, tuning.nodMinPitchDelta * tuning.nodReturnFraction, Direction.BELOW)
    }
}

private fun widthRatio(signal: FaceSignal, baseline: FaceSignal?): Float {
    val base = baseline?.box?.w ?: 0f
    return if (base > 1e-6f) signal.box.w / base else 1f
}

/** Move closer / farther: the face grows / shrinks by a fraction, then comes back. */
class MoveChallenge(t: ChallengeTuning, private val closer: Boolean) : Challenge(t) {
    override val name = if (closer) ChallengeName.MOVE_CLOSER else ChallengeName.MOVE_FARTHER
    override val phaseCount = 2
    override val capturePhase = 0
    override fun isSatisfied(signal: FaceSignal, baseline: FaceSignal?, phase: Int, memo: ChallengeMemo): Boolean {
        val r = widthRatio(signal, baseline)
        if (phase != 0) return abs(r - 1f) <= tuning.moveReturnBand
        return if (closer) r >= 1f + tuning.moveCloserMinGrow else r <= 1f - tuning.moveFartherMinShrink
    }
    override fun metric(signal: FaceSignal, baseline: FaceSignal?, phase: Int, memo: ChallengeMemo): ChallengeMetric {
        val r = widthRatio(signal, baseline)
        if (phase != 0) return ChallengeMetric(abs(r - 1f), tuning.moveReturnBand, Direction.BELOW)
        return if (closer) ChallengeMetric(r, 1f + tuning.moveCloserMinGrow, Direction.ABOVE)
        else ChallengeMetric(r, 1f - tuning.moveFartherMinShrink, Direction.BELOW)
    }
}

object Challenges {
    /** `center` is always first (framing gate + the neutral baseline), and stripped from [names] if present. */
    fun build(names: List<ChallengeName>, tuning: ChallengeTuning = ChallengeTuning()): List<Challenge> =
        listOf<Challenge>(CenterChallenge(tuning)) + names.filter { it != ChallengeName.CENTER }.map { create(it, tuning) }

    fun create(name: ChallengeName, tuning: ChallengeTuning): Challenge = when (name) {
        ChallengeName.CENTER -> CenterChallenge(tuning)
        ChallengeName.CLOSE_EYES -> CloseEyesChallenge(tuning)
        ChallengeName.TURN_LEFT -> TurnChallenge(tuning, left = true)
        ChallengeName.TURN_RIGHT -> TurnChallenge(tuning, left = false)
        ChallengeName.SMILE -> SmileChallenge(tuning)
        ChallengeName.OPEN_MOUTH -> OpenMouthChallenge(tuning)
        ChallengeName.NOD -> NodChallenge(tuning)
        ChallengeName.MOVE_CLOSER -> MoveChallenge(tuning, closer = true)
        ChallengeName.MOVE_FARTHER -> MoveChallenge(tuning, closer = false)
    }

    /** The pool the local flow draws from (every entry is a movement relative to the neutral frame). */
    val LOCAL_POOL = listOf(
        ChallengeName.CLOSE_EYES, ChallengeName.TURN_LEFT, ChallengeName.TURN_RIGHT,
        ChallengeName.OPEN_MOUTH, ChallengeName.MOVE_CLOSER, ChallengeName.MOVE_FARTHER,
    )

    /**
     * Same policy as the server's full tier: `openMouth` always (the challenge
     * a rigid mask cannot answer), the other slots random from the pool, the
     * whole list shuffled so a recording only replays by luck.
     */
    fun pickLocal(count: Int = 4, random: kotlin.random.Random = kotlin.random.Random.Default): List<ChallengeName> {
        val n = count.coerceIn(1, LOCAL_POOL.size)
        val rest = LOCAL_POOL.filter { it != ChallengeName.OPEN_MOUTH }.shuffled(random).take(n - 1)
        return (listOf(ChallengeName.OPEN_MOUTH) + rest).shuffled(random)
    }
}
