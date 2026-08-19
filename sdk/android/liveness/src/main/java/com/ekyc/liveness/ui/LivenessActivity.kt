package com.ekyc.liveness.ui

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import com.ekyc.liveness.EkycLiveness
import com.ekyc.liveness.LivenessConfig
import com.ekyc.liveness.LivenessResult
import com.ekyc.liveness.StepResult
import com.ekyc.liveness.engine.Challenge
import com.ekyc.liveness.engine.ChallengeName
import com.ekyc.liveness.engine.ChallengeTuning
import com.ekyc.liveness.engine.Challenges
import com.ekyc.liveness.engine.ContinuityTracker
import com.ekyc.liveness.engine.Direction
import com.ekyc.liveness.engine.FaceSignal
import com.ekyc.liveness.engine.FailureReason
import com.ekyc.liveness.engine.Flash
import com.ekyc.liveness.engine.Framing
import com.ekyc.liveness.engine.LivenessSession
import com.ekyc.liveness.engine.Mouth
import com.ekyc.liveness.engine.Phase
import com.ekyc.liveness.engine.Pt
import com.ekyc.liveness.engine.Rect
import com.ekyc.liveness.engine.SessionEvent
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.face.Face
import com.google.mlkit.vision.face.FaceContour
import com.google.mlkit.vision.face.FaceDetection
import com.google.mlkit.vision.face.FaceDetector
import com.google.mlkit.vision.face.FaceDetectorOptions
import com.google.mlkit.vision.face.FaceLandmark
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import kotlin.math.max
import kotlin.math.min

/**
 * The whole local flow in one activity: intro → camera + ML Kit → challenges
 * → screen flash → verdict. Returns a [LivenessResult] JSON in
 * [EkycLiveness.EXTRA_RESULT]. Nothing is stored; no image leaves the
 * process.
 */
class LivenessActivity : AppCompatActivity() {

    private lateinit var config: LivenessConfig
    private lateinit var copy: Copy
    private lateinit var root: FrameLayout
    private lateinit var previewView: PreviewView
    private lateinit var overlay: OverlayView
    private lateinit var instruction: TextView
    private lateinit var hint: TextView
    private lateinit var flashView: View

    private var detector: FaceDetector? = null
    private var executor: ExecutorService? = null
    private var session: LivenessSession? = null
    private var challengeList: List<Challenge> = emptyList()
    private val continuity = ContinuityTracker()
    private val log = ArrayList<String>()
    private var startedAt = 0L
    private var finished = false
    private var busy = false
    private val main = Handler(Looper.getMainLooper())

    // Flash phase
    private var flashSequence: List<String> = emptyList()
    private val flashObserved = ArrayList<FloatArray>()
    @Volatile private var flashSampleWanted = false

    private val permission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) startCamera() else finishWith(result(passed = false, reasons = listOf("CAMERA_PERMISSION")))
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        config = LivenessConfig.fromJson(intent.getStringExtra(EkycLiveness.EXTRA_CONFIG))
        copy = Copy(config.locale)
        root = FrameLayout(this).apply { setBackgroundColor(Color.WHITE) }
        setContentView(root)
        if (config.showIntro) showIntro() else begin()
    }

    // ---- intro ---------------------------------------------------------------

    private fun showIntro() {
        root.removeAllViews()
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(dp(28), dp(64), dp(28), dp(28))
        }
        col.addView(text(config.title ?: copy.introTitle, 26f, bold = true, color = OverlayView.ACCENT))
        col.addView(text(copy.introBody, 16f, color = Color.DKGRAY).apply { setPadding(0, dp(8), 0, dp(20)) })
        copy.introSteps.forEachIndexed { i, s ->
            col.addView(text("${i + 1}.  $s", 16f, color = Color.rgb(40, 40, 40)).apply { gravity = Gravity.START; setPadding(0, dp(6), 0, dp(6)) })
        }
        col.addView(text(copy.introPrivacy, 13f, color = Color.GRAY).apply { setPadding(0, dp(20), 0, dp(24)) })
        col.addView(Button(this).apply {
            text = copy.start
            setTextColor(Color.WHITE)
            setBackgroundColor(OverlayView.ACCENT)
            setOnClickListener { begin() }
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(52)))
        root.addView(col, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    }

    // ---- capture screen ------------------------------------------------------

    private fun begin() {
        root.removeAllViews()
        previewView = PreviewView(this).apply { implementationMode = PreviewView.ImplementationMode.COMPATIBLE; scaleType = PreviewView.ScaleType.FILL_CENTER }
        overlay = OverlayView(this)
        instruction = text("", 22f, bold = true, color = OverlayView.ACCENT).apply {
            setBackgroundColor(Color.argb(235, 255, 255, 255))
            setPadding(dp(20), dp(18), dp(20), dp(18))
        }
        hint = text("", 14f, color = Color.DKGRAY)
        flashView = View(this).apply { visibility = View.GONE }
        root.addView(previewView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        root.addView(overlay, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        root.addView(instruction, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP).apply { topMargin = dp(48); leftMargin = dp(16); rightMargin = dp(16) })
        root.addView(hint, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM).apply { bottomMargin = dp(40); leftMargin = dp(24); rightMargin = dp(24) })
        root.addView(flashView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

        val names = config.challengeNames()
        challengeList = Challenges.build(names, config.tuning ?: ChallengeTuning())
        overlay.steps = challengeList.size
        session = LivenessSession(challengeList, config.sessionOptions()) { onEvent(it) }
        startedAt = SystemClock.elapsedRealtime()
        logLine("session challenges=${names.joinToString(",") { it.wire }} flash=${config.flash}")
        instruction.text = copy.framing(Framing.NO_FACE)

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) startCamera()
        else permission.launch(Manifest.permission.CAMERA)
    }

    private fun startCamera() {
        val options = FaceDetectorOptions.Builder()
            .setPerformanceMode(FaceDetectorOptions.PERFORMANCE_MODE_FAST)
            .setClassificationMode(FaceDetectorOptions.CLASSIFICATION_MODE_ALL)
            .setLandmarkMode(FaceDetectorOptions.LANDMARK_MODE_ALL)
            .setContourMode(FaceDetectorOptions.CONTOUR_MODE_ALL)
            .setMinFaceSize(0.15f)
            .build()
        detector = FaceDetection.getClient(options)
        executor = Executors.newSingleThreadExecutor()

        val providerFuture = ProcessCameraProvider.getInstance(this)
        providerFuture.addListener({
            val provider = providerFuture.get()
            val preview = Preview.Builder().build().also { it.surfaceProvider = previewView.surfaceProvider }
            val analysis = ImageAnalysis.Builder()
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build()
            analysis.setAnalyzer(executor!!) { proxy -> analyse(proxy) }
            try {
                provider.unbindAll()
                provider.bindToLifecycle(this, CameraSelector.DEFAULT_FRONT_CAMERA, preview, analysis)
            } catch (e: Exception) {
                logLine("camera bind failed: ${e.message}")
                finishWith(result(passed = false, reasons = listOf("LOCAL_captureFailed")))
            }
        }, ContextCompat.getMainExecutor(this))
    }

    @SuppressLint("UnsafeOptInUsageError")
    private fun analyse(proxy: ImageProxy) {
        val media = proxy.image
        val det = detector
        if (media == null || det == null || finished) { proxy.close(); return }
        if (busy) { proxy.close(); return }
        busy = true
        val rotation = proxy.imageInfo.rotationDegrees
        val upW = if (rotation % 180 == 0) proxy.width else proxy.height
        val upH = if (rotation % 180 == 0) proxy.height else proxy.width
        val image = InputImage.fromMediaImage(media, rotation)
        val t = SystemClock.elapsedRealtime()
        det.process(image)
            .addOnSuccessListener { faces ->
                val signal = toSignal(faces, upW, upH, t)
                // Flash sampling: read the mean face colour off this very frame.
                if (flashSampleWanted && signal.count > 0) {
                    flashSampleWanted = false
                    val rgb = meanFaceColour(proxy, rotation, signal.box)
                    if (rgb != null) { flashObserved.add(rgb); logLine("flash sample ${flashObserved.size} rgb=${rgb.joinToString(",") { "%.3f".format(it) }}") }
                    else flashObserved.add(floatArrayOf(0f, 0f, 0f))
                    main.post { nextFlash() }
                }
                main.post { onSignal(signal) }
            }
            .addOnFailureListener { e -> logLine("detector error: ${e.message}") }
            .addOnCompleteListener { busy = false; proxy.close() }
    }

    /** ML Kit face list → the engine's per-frame signal (largest face, normalised to the upright frame). */
    private fun toSignal(faces: List<Face>, w: Int, h: Int, t: Long): FaceSignal {
        if (faces.isEmpty()) return FaceSignal.empty(t)
        val face = faces.maxByOrNull { it.boundingBox.width() }!!
        val b = face.boundingBox
        val box = Rect(b.left.toFloat() / w, b.top.toFloat() / h, b.width().toFloat() / w, b.height().toFloat() / h)
        fun pts(type: Int): List<Pt>? = face.getContour(type)?.points?.map { Pt(it.x, it.y) }
        fun lm(type: Int): Pt? = face.getLandmark(type)?.position?.let { Pt(it.x, it.y) }
        val mouth = Mouth.openness(
            pts(FaceContour.UPPER_LIP_BOTTOM), pts(FaceContour.LOWER_LIP_TOP), pts(FaceContour.UPPER_LIP_TOP), pts(FaceContour.LOWER_LIP_BOTTOM),
            lm(FaceLandmark.NOSE_BASE), lm(FaceLandmark.MOUTH_BOTTOM), lm(FaceLandmark.MOUTH_LEFT), lm(FaceLandmark.MOUTH_RIGHT),
        )
        return FaceSignal(
            count = faces.size,
            yaw = face.headEulerAngleY, pitch = face.headEulerAngleX, roll = face.headEulerAngleZ,
            leftEye = face.leftEyeOpenProbability ?: 1f, rightEye = face.rightEyeOpenProbability ?: 1f,
            smile = face.smilingProbability ?: 0f, mouthOpen = mouth, box = box, t = t,
        )
    }

    private var sessionStarted = false

    private fun onSignal(signal: FaceSignal) {
        val s = session ?: return
        if (finished) return
        // The clock starts at the first camera frame, not at the permission
        // dialog: the step timeouts are about the user, not the camera.
        if (!sessionStarted) {
            sessionStarted = true
            startedAt = signal.t
            s.start(signal.t)
            logLine("first frame")
        }
        continuity.feed(signal)
        if (s.state.phase != Phase.RUNNING) return
        s.update(signal)
        render()
    }

    private fun onEvent(e: SessionEvent) {
        when (e) {
            is SessionEvent.Capture -> logLine("evidence moment ${e.challenge.wire}")
            is SessionEvent.StepComplete -> {
                val m = session?.state?.stepMetrics?.get("${e.stepIndex}:${e.challenge.wire}")
                logLine("step ${e.challenge.wire} best=${"%.2f".format(m?.best ?: 0f)} needed=${"%.2f".format(m?.needed ?: 0f)}")
                vibrate(20)
            }
            is SessionEvent.Failed -> {
                logLine("failed ${e.reason} at ${e.challenge?.wire}")
                finishWith(result(passed = false, reasons = listOf("LOCAL_" + reasonWire(e.reason))))
            }
            SessionEvent.Complete -> {
                logLine("steps complete in ${SystemClock.elapsedRealtime() - startedAt} ms")
                if (config.flash) startFlash() else finishWith(verdict())
            }
        }
    }

    private fun render() {
        val st = session?.state ?: return
        val holding = st.holdProgress > 0.05f
        overlay.progress = st.holdProgress
        overlay.stepIndex = st.stepIndex
        val c = st.challenge
        instruction.text = when {
            st.framing != Framing.OK -> copy.framing(st.framing)
            c == null -> ""
            st.awaitingRecenter -> copy.recenter
            st.stepPhase > 0 -> copy.phase2(c)
            holding -> copy.holdOn
            else -> copy.challenge(c)
        }
        hint.text = if (st.framing == Framing.OK && c != null && c != ChallengeName.CENTER) "${st.stepIndex}/${st.stepCount - 1}" else ""
    }

    // ---- flash phase ---------------------------------------------------------

    private var flashIndex = -1

    private fun startFlash() {
        flashSequence = Flash.pickSequence()
        flashObserved.clear()
        flashIndex = -1
        instruction.text = copy.flashHold
        overlay.progress = 0f
        flashView.visibility = View.VISIBLE
        logLine("flash sequence ${flashSequence.joinToString(",")}")
        nextFlash()
    }

    private fun nextFlash() {
        flashIndex += 1
        if (flashIndex >= flashSequence.size) {
            flashView.visibility = View.GONE
            finishWith(verdict())
            return
        }
        flashView.setBackgroundColor(Flash.argb(flashSequence[flashIndex]))
        flashView.alpha = 0.92f
        val idx = flashIndex
        // Let the screen and the camera's auto-exposure settle, then sample the next frame.
        main.postDelayed({ if (flashIndex == idx && !finished) flashSampleWanted = true }, 380)
        // A face-less stretch must not hang the phase: give up on this colour after 2.5 s.
        main.postDelayed({
            if (flashIndex == idx && flashSampleWanted && !finished) {
                flashSampleWanted = false
                flashObserved.add(floatArrayOf(0f, 0f, 0f))
                logLine("flash sample ${flashObserved.size} missed (no face)")
                nextFlash()
            }
        }, 2_500)
    }

    /** Mean RGB (0..1) over the face box, read from the YUV planes. Null on an unexpected format. */
    private fun meanFaceColour(proxy: ImageProxy, rotation: Int, box: Rect): FloatArray? {
        return try {
            val bw = proxy.width; val bh = proxy.height
            val upW = if (rotation % 180 == 0) bw else bh
            val upH = if (rotation % 180 == 0) bh else bw
            // Box corners in the upright frame → buffer coordinates.
            val xs = listOf(box.x * upW, (box.x + box.w) * upW)
            val ys = listOf(box.y * upH, (box.y + box.h) * upH)
            var minX = Int.MAX_VALUE; var maxX = 0; var minY = Int.MAX_VALUE; var maxY = 0
            for (xr in xs) for (yr in ys) {
                val (x, y) = when (rotation) {
                    90 -> Pair(yr, bh - 1 - xr)
                    180 -> Pair(bw - 1 - xr, bh - 1 - yr)
                    270 -> Pair(bw - 1 - yr, xr)
                    else -> Pair(xr, yr)
                }
                minX = min(minX, x.toInt()); maxX = max(maxX, x.toInt()); minY = min(minY, y.toInt()); maxY = max(maxY, y.toInt())
            }
            minX = minX.coerceIn(0, bw - 1); maxX = maxX.coerceIn(0, bw - 1); minY = minY.coerceIn(0, bh - 1); maxY = maxY.coerceIn(0, bh - 1)
            if (maxX - minX < 4 || maxY - minY < 4) return null
            val yPlane = proxy.planes[0]; val uPlane = proxy.planes[1]; val vPlane = proxy.planes[2]
            val yBuf = yPlane.buffer; val uBuf = uPlane.buffer; val vBuf = vPlane.buffer
            var r = 0.0; var g = 0.0; var b = 0.0; var n = 0
            val step = max(2, (maxX - minX) / 40)
            var y = minY
            while (y <= maxY) {
                var x = minX
                while (x <= maxX) {
                    val yv = (yBuf.get(y * yPlane.rowStride + x * yPlane.pixelStride).toInt() and 0xFF).toFloat()
                    val uvIndexU = (y / 2) * uPlane.rowStride + (x / 2) * uPlane.pixelStride
                    val uvIndexV = (y / 2) * vPlane.rowStride + (x / 2) * vPlane.pixelStride
                    val u = (uBuf.get(uvIndexU).toInt() and 0xFF) - 128f
                    val v = (vBuf.get(uvIndexV).toInt() and 0xFF) - 128f
                    r += (yv + 1.402f * v).coerceIn(0f, 255f)
                    g += (yv - 0.344f * u - 0.714f * v).coerceIn(0f, 255f)
                    b += (yv + 1.772f * u).coerceIn(0f, 255f)
                    n++
                    x += step
                }
                y += step
            }
            if (n == 0) null else floatArrayOf((r / n / 255).toFloat(), (g / n / 255).toFloat(), (b / n / 255).toFloat())
        } catch (e: Exception) {
            logLine("flash colour failed: ${e.message}")
            null
        }
    }

    // ---- verdict -------------------------------------------------------------

    private fun verdict(): LivenessResult {
        val reasons = ArrayList<String>()
        val cont = continuity.report(SystemClock.elapsedRealtime())
        var flashScore: Float? = null
        var flashOk: Boolean? = null
        if (config.flash && flashSequence.isNotEmpty()) {
            val commanded = flashSequence.map { Flash.PALETTE.getValue(it) }
            flashScore = Flash.score(commanded, flashObserved)
            flashOk = flashScore >= Flash.MIN_SCORE
            logLine("flash score ${"%.3f".format(flashScore)} ok=$flashOk (rule ${config.flashRule})")
            if (!flashOk && config.flashRule == "enforce") reasons.add("FLASH_SPOOF")
        }
        logLine("continuity ok=${cont.ok} maxGap=${cont.maxGapMs}ms maxJump=${"%.2f".format(cont.maxJump)} frames=${cont.faceFrames}/${cont.frames} (rule ${config.continuityRule})")
        if (!cont.ok && config.continuityRule == "enforce") reasons.add("FACE_DISCONTINUITY")
        val passed = reasons.isEmpty()
        return result(passed, reasons, flashScore, flashOk, cont)
    }

    private fun result(
        passed: Boolean, reasons: List<String>,
        flashScore: Float? = null, flashOk: Boolean? = null, cont: ContinuityTracker.Report? = null,
    ): LivenessResult {
        val st = session?.state
        val steps = st?.stepMetrics?.values?.map { m ->
            StepResult(m.challenge.wire, m.phase, m.best, m.needed, if (m.direction == Direction.ABOVE) "above" else "below",
                reached = if (m.direction == Direction.ABOVE) m.best >= m.needed else m.best <= m.needed)
        } ?: emptyList()
        return LivenessResult(
            passed = passed, reasons = reasons,
            challenges = challengeList.map { it.name.wire },
            steps = steps,
            durationMs = if (startedAt > 0) SystemClock.elapsedRealtime() - startedAt else 0,
            flashScore = flashScore, flashOk = flashOk,
            continuityOk = cont?.ok, continuityMaxGapMs = cont?.maxGapMs, continuityMaxJump = cont?.maxJump,
            log = ArrayList(log),
        )
    }

    private fun finishWith(result: LivenessResult) {
        if (finished) return
        finished = true
        logLine("result passed=${result.passed} reasons=${result.reasons}")
        if (config.showResult) showResultScreen(result) else deliver(result)
    }

    private fun showResultScreen(result: LivenessResult) {
        root.removeAllViews()
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(dp(28), dp(28), dp(28), dp(28))
        }
        val colour = if (result.passed) OverlayView.SUCCESS else Color.rgb(180, 40, 40)
        col.addView(text(if (result.passed) "✓" else "!", 64f, bold = true, color = colour))
        col.addView(text(if (result.passed) copy.successTitle else copy.failTitle, 24f, bold = true, color = colour).apply { setPadding(0, dp(8), 0, dp(6)) })
        col.addView(text(if (result.passed) copy.successBody else result.reasons.joinToString("\n") { copy.reason(it) }, 16f, color = Color.DKGRAY).apply { setPadding(0, 0, 0, dp(24)) })
        col.addView(Button(this).apply {
            text = copy.done
            setTextColor(Color.WHITE)
            setBackgroundColor(OverlayView.ACCENT)
            setOnClickListener { deliver(result) }
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(52)))
        root.addView(col, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    }

    private fun deliver(result: LivenessResult) {
        setResult(RESULT_OK, Intent().putExtra(EkycLiveness.EXTRA_RESULT, result.toJson()))
        finish()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (!finished) {
            finished = true
            setResult(RESULT_CANCELED)
        }
        @Suppress("DEPRECATION")
        super.onBackPressed()
    }

    override fun onDestroy() {
        super.onDestroy()
        executor?.shutdown()
        detector?.close()
    }

    // ---- helpers -------------------------------------------------------------

    private fun reasonWire(r: FailureReason) = when (r) {
        FailureReason.TIMEOUT -> "timeout"
        FailureReason.FACE_LOST -> "faceLost"
        FailureReason.MULTIPLE_FACES -> "multipleFaces"
        FailureReason.CANCELLED -> "cancelled"
    }

    private fun logLine(s: String) {
        val line = "${SystemClock.elapsedRealtime() - startedAt} $s"
        synchronized(log) { log.add(line) }
    }

    private fun vibrate(ms: Long) {
        try {
            val v = getSystemService(VIBRATOR_SERVICE) as? android.os.Vibrator ?: return
            if (android.os.Build.VERSION.SDK_INT >= 26) v.vibrate(android.os.VibrationEffect.createOneShot(ms, android.os.VibrationEffect.DEFAULT_AMPLITUDE))
            else @Suppress("DEPRECATION") v.vibrate(ms)
        } catch (_: Exception) {}
    }

    private fun text(s: String, sp: Float, bold: Boolean = false, color: Int = Color.BLACK): TextView = TextView(this).apply {
        text = s
        setTextSize(TypedValue.COMPLEX_UNIT_SP, sp)
        setTextColor(color)
        gravity = Gravity.CENTER
        if (bold) setTypeface(typeface, Typeface.BOLD)
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()
}
