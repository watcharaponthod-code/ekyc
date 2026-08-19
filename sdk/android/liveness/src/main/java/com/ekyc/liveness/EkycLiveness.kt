package com.ekyc.liveness

import android.app.Activity
import android.content.Context
import android.content.Intent
import androidx.activity.result.contract.ActivityResultContract
import com.ekyc.liveness.engine.ChallengeName
import com.ekyc.liveness.engine.ChallengeTuning
import com.ekyc.liveness.engine.Challenges
import com.ekyc.liveness.engine.SessionOptions
import com.ekyc.liveness.ui.LivenessActivity
import org.json.JSONArray
import org.json.JSONObject

/**
 * What to ask the user. Everything is optional: the default is the same
 * policy as the server flow — `openMouth` always plus three random movements,
 * shuffled — with a screen-flash phase at the end.
 *
 * Plain data + JSON in/out, so any host (Kotlin, Java, Flutter, React Native,
 * Capacitor, Unity…) can drive it by passing one string.
 */
data class LivenessConfig(
    /** Challenge names (`turnLeft`, `turnRight`, `openMouth`, `closeEyes`, `moveCloser`, `moveFarther`, `nod`, `smile`). Empty = random like the server. */
    val challenges: List<String> = emptyList(),
    /** How many random challenges when [challenges] is empty. */
    val challengeCount: Int = 4,
    /** `th` or `en`. */
    val locale: String = "th",
    /** Screen-flash phase after the steps (4 random colours). */
    val flash: Boolean = true,
    /** `off`, `advisory` (reported only) or `enforce` (fails the run). */
    val flashRule: String = "advisory",
    /** Face-continuity rule: `off`, `advisory` or `enforce`. */
    val continuityRule: String = "advisory",
    /** Hold per evidence step, ms. */
    val holdMs: Long = 400,
    val perStepTimeoutMs: Long = 12_000,
    val totalTimeoutMs: Long = 60_000,
    /** Show the one-screen intro before the camera. */
    val showIntro: Boolean = true,
    /** Show the ✓ / ! verdict screen before returning (false = return straight to the host). */
    val showResult: Boolean = true,
    /** Title shown on the intro / camera screen (null = default copy). */
    val title: String? = null,
    /** Thresholds. Null = the device-calibrated defaults (see [ChallengeTuning]). */
    val tuning: ChallengeTuning? = null,
) {
    fun toJson(): String = JSONObject().apply {
        put("challenges", JSONArray(challenges))
        put("challengeCount", challengeCount)
        put("locale", locale)
        put("flash", flash)
        put("flashRule", flashRule)
        put("continuityRule", continuityRule)
        put("holdMs", holdMs)
        put("perStepTimeoutMs", perStepTimeoutMs)
        put("totalTimeoutMs", totalTimeoutMs)
        put("showIntro", showIntro)
        put("showResult", showResult)
        put("title", title ?: JSONObject.NULL)
        tuning?.let { t ->
            put("tuning", JSONObject().apply {
                put("turnMinYawDelta", t.turnMinYawDelta); put("yawSign", t.yawSign)
                put("mouthOpenMinDelta", t.mouthOpenMinDelta); put("eyesClosedMaxOpen", t.eyesClosedMaxOpen)
                put("moveCloserMinGrow", t.moveCloserMinGrow); put("moveFartherMinShrink", t.moveFartherMinShrink)
                put("nodMinPitchDelta", t.nodMinPitchDelta); put("centerMaxYaw", t.centerMaxYaw)
            })
        }
    }.toString()

    internal fun challengeNames(): List<ChallengeName> =
        if (challenges.isEmpty()) Challenges.pickLocal(challengeCount) else challenges.map { ChallengeName.fromWire(it) }

    internal fun sessionOptions() = SessionOptions(holdMs = holdMs, perStepTimeoutMs = perStepTimeoutMs, totalTimeoutMs = totalTimeoutMs)

    companion object {
        @JvmStatic
        fun fromJson(json: String?): LivenessConfig {
            if (json.isNullOrBlank()) return LivenessConfig()
            val o = JSONObject(json)
            val d = LivenessConfig()
            val names = o.optJSONArray("challenges")?.let { a -> List(a.length()) { a.getString(it) } } ?: d.challenges
            val tuning = o.optJSONObject("tuning")?.let { t ->
                val base = ChallengeTuning()
                base.copy(
                    turnMinYawDelta = t.optDouble("turnMinYawDelta", base.turnMinYawDelta.toDouble()).toFloat(),
                    yawSign = t.optInt("yawSign", base.yawSign),
                    mouthOpenMinDelta = t.optDouble("mouthOpenMinDelta", base.mouthOpenMinDelta.toDouble()).toFloat(),
                    eyesClosedMaxOpen = t.optDouble("eyesClosedMaxOpen", base.eyesClosedMaxOpen.toDouble()).toFloat(),
                    moveCloserMinGrow = t.optDouble("moveCloserMinGrow", base.moveCloserMinGrow.toDouble()).toFloat(),
                    moveFartherMinShrink = t.optDouble("moveFartherMinShrink", base.moveFartherMinShrink.toDouble()).toFloat(),
                    nodMinPitchDelta = t.optDouble("nodMinPitchDelta", base.nodMinPitchDelta.toDouble()).toFloat(),
                    centerMaxYaw = t.optDouble("centerMaxYaw", base.centerMaxYaw.toDouble()).toFloat(),
                )
            }
            return LivenessConfig(
                challenges = names,
                challengeCount = o.optInt("challengeCount", d.challengeCount),
                locale = o.optString("locale", d.locale),
                flash = o.optBoolean("flash", d.flash),
                flashRule = o.optString("flashRule", d.flashRule),
                continuityRule = o.optString("continuityRule", d.continuityRule),
                holdMs = o.optLong("holdMs", d.holdMs),
                perStepTimeoutMs = o.optLong("perStepTimeoutMs", d.perStepTimeoutMs),
                totalTimeoutMs = o.optLong("totalTimeoutMs", d.totalTimeoutMs),
                showIntro = o.optBoolean("showIntro", d.showIntro),
                showResult = o.optBoolean("showResult", d.showResult),
                title = if (o.isNull("title")) null else o.optString("title"),
                tuning = tuning,
            )
        }
    }
}

/** One step's telemetry: how far the user got vs what was needed (the tuning data). */
data class StepResult(val challenge: String, val phase: Int, val best: Float, val needed: Float, val direction: String, val reached: Boolean)

/**
 * The verdict. [passed] is the answer; everything else is the evidence behind
 * it, so a host can log, display, or ship it to its own backend.
 */
data class LivenessResult(
    val passed: Boolean,
    /** Empty when passed; otherwise `LOCAL_timeout`, `LOCAL_faceLost`, `LOCAL_multipleFaces`, `LOCAL_cancelled`, `FLASH_SPOOF`, `FACE_DISCONTINUITY`, `CAMERA_PERMISSION`. */
    val reasons: List<String>,
    val challenges: List<String>,
    val steps: List<StepResult>,
    val durationMs: Long,
    /** 0..1 (null when the flash phase was off or could not be measured). */
    val flashScore: Float?,
    val flashOk: Boolean?,
    val continuityOk: Boolean?,
    val continuityMaxGapMs: Long?,
    val continuityMaxJump: Float?,
    /** Per-line session log (numbers only, no images). */
    val log: List<String>,
) {
    fun toJson(): String = JSONObject().apply {
        put("passed", passed)
        put("reasons", JSONArray(reasons))
        put("challenges", JSONArray(challenges))
        put("steps", JSONArray().apply {
            steps.forEach { s ->
                put(JSONObject().apply {
                    put("challenge", s.challenge); put("phase", s.phase); put("best", s.best.toDouble())
                    put("needed", s.needed.toDouble()); put("direction", s.direction); put("reached", s.reached)
                })
            }
        })
        put("durationMs", durationMs)
        put("flashScore", flashScore?.toDouble() ?: JSONObject.NULL)
        put("flashOk", flashOk ?: JSONObject.NULL)
        put("continuityOk", continuityOk ?: JSONObject.NULL)
        put("continuityMaxGapMs", continuityMaxGapMs ?: JSONObject.NULL)
        put("continuityMaxJump", continuityMaxJump?.toDouble() ?: JSONObject.NULL)
        put("log", JSONArray(log))
    }.toString()

    companion object {
        @JvmStatic
        fun fromJson(json: String): LivenessResult {
            val o = JSONObject(json)
            fun strings(key: String) = o.optJSONArray(key)?.let { a -> List(a.length()) { a.getString(it) } } ?: emptyList()
            val steps = o.optJSONArray("steps")?.let { a ->
                List(a.length()) {
                    val s = a.getJSONObject(it)
                    StepResult(s.getString("challenge"), s.getInt("phase"), s.getDouble("best").toFloat(), s.getDouble("needed").toFloat(), s.getString("direction"), s.getBoolean("reached"))
                }
            } ?: emptyList()
            return LivenessResult(
                passed = o.getBoolean("passed"),
                reasons = strings("reasons"),
                challenges = strings("challenges"),
                steps = steps,
                durationMs = o.optLong("durationMs"),
                flashScore = if (o.isNull("flashScore")) null else o.getDouble("flashScore").toFloat(),
                flashOk = if (o.isNull("flashOk")) null else o.getBoolean("flashOk"),
                continuityOk = if (o.isNull("continuityOk")) null else o.getBoolean("continuityOk"),
                continuityMaxGapMs = if (o.isNull("continuityMaxGapMs")) null else o.getLong("continuityMaxGapMs"),
                continuityMaxJump = if (o.isNull("continuityMaxJump")) null else o.getDouble("continuityMaxJump").toFloat(),
                log = strings("log"),
            )
        }

        /** The result when the user backed out before anything happened. */
        fun cancelled() = LivenessResult(false, listOf("LOCAL_cancelled"), emptyList(), emptyList(), 0, null, null, null, null, null, emptyList())
    }
}

/**
 * Entry point. Three ways in, all returning the same [LivenessResult]:
 *
 * 1. Jetpack `ActivityResultContract` (Kotlin / Java / Compose):
 *    `val launcher = registerForActivityResult(EkycLiveness.Contract()) { result -> … }`
 *    `launcher.launch(LivenessConfig())`
 * 2. Raw intent (any framework's host activity):
 *    `startActivityForResult(EkycLiveness.intent(context, config), REQ)` then
 *    `EkycLiveness.resultFrom(data)` in `onActivityResult`.
 * 3. JSON strings for bridges (Flutter MethodChannel, RN native module,
 *    Capacitor): `EkycLiveness.intentFromJson(context, json)` and
 *    `resultFrom(data).toJson()`.
 *
 * Everything runs on the phone (ML Kit face detection, bundled model). No
 * network permission is needed or used.
 */
object EkycLiveness {
    const val EXTRA_CONFIG = "com.ekyc.liveness.CONFIG"
    const val EXTRA_RESULT = "com.ekyc.liveness.RESULT"

    @JvmStatic
    fun intent(context: Context, config: LivenessConfig = LivenessConfig()): Intent =
        Intent(context, LivenessActivity::class.java).putExtra(EXTRA_CONFIG, config.toJson())

    @JvmStatic
    fun intentFromJson(context: Context, configJson: String?): Intent = intent(context, LivenessConfig.fromJson(configJson))

    /** Parse the activity result. A missing payload (back press) is a cancelled run. */
    @JvmStatic
    fun resultFrom(data: Intent?): LivenessResult {
        val json = data?.getStringExtra(EXTRA_RESULT) ?: return LivenessResult.cancelled()
        return LivenessResult.fromJson(json)
    }

    class Contract : ActivityResultContract<LivenessConfig, LivenessResult>() {
        override fun createIntent(context: Context, input: LivenessConfig): Intent = intent(context, input)
        override fun parseResult(resultCode: Int, intent: Intent?): LivenessResult =
            if (resultCode == Activity.RESULT_OK) resultFrom(intent) else LivenessResult.cancelled()
    }
}
