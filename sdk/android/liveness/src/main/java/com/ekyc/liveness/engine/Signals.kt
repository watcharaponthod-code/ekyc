package com.ekyc.liveness.engine

import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.sqrt

/** A 2-D point (pixels). */
data class Pt(val x: Float, val y: Float)

/**
 * Mouth opening from ML Kit geometry — port of `mouth.ts`. With contours: the
 * vertical gap between the upper lip's bottom edge and the lower lip's top
 * edge, over the mouth width (~0 shut, 0.3–0.6 clearly open, independent of
 * distance). Without contours: nose-base → mouth-bottom over the mouth width,
 * remapped onto the same scale.
 */
object Mouth {
    fun openness(
        upperLipBottom: List<Pt>?, lowerLipTop: List<Pt>?, upperLipTop: List<Pt>?, lowerLipBottom: List<Pt>?,
        noseBase: Pt?, mouthBottom: Pt?, mouthLeft: Pt?, mouthRight: Pt?,
    ): Float {
        val upper = centroid(upperLipBottom)
        val lower = centroid(lowerLipTop)
        val width = mouthWidth(upperLipTop) ?: mouthWidth(lowerLipBottom)
        if (upper != null && lower != null && width != null && width > 1f) {
            return max(0f, (lower.y - upper.y) / width)
        }
        if (noseBase != null && mouthBottom != null && mouthLeft != null && mouthRight != null) {
            val w = hypot(mouthRight.x - mouthLeft.x, mouthRight.y - mouthLeft.y)
            if (w > 1f) {
                val ratio = (mouthBottom.y - noseBase.y) / w
                return max(0f, (ratio - 0.55f) * 1.3f)
            }
        }
        return 0f
    }

    private fun centroid(points: List<Pt>?): Pt? {
        if (points.isNullOrEmpty()) return null
        var x = 0f; var y = 0f
        for (p in points) { x += p.x; y += p.y }
        return Pt(x / points.size, y / points.size)
    }

    private fun mouthWidth(points: List<Pt>?): Float? {
        if (points == null || points.size < 2) return null
        var minX = Float.POSITIVE_INFINITY; var maxX = Float.NEGATIVE_INFINITY
        for (p in points) { if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x }
        return maxX - minX
    }
}

/**
 * Face continuity — port of `continuity.ts`: the lightest "same person all the
 * way through" signal. A swap shows up as the face disappearing for a moment
 * or its box jumping between consecutive frames. Advisory-first by design.
 */
class ContinuityTracker(
    private val maxGapMs: Long = 1500,
    private val maxJump: Float = 0.35f,
    private val jumpWindowMs: Long = 400,
) {
    data class Report(
        val maxGapMs: Long, val maxJump: Float, val gaps: Int, val jumps: Int,
        val frames: Int, val faceFrames: Int, val ok: Boolean,
    )

    private var lastFaceT: Long? = null
    private var lastCentre: Pt? = null
    private var gapStart: Long? = null
    private var maxGap = 0L
    private var maxJumpSeen = 0f
    private var gaps = 0
    private var jumps = 0
    private var frames = 0
    private var faceFrames = 0

    fun feed(s: FaceSignal) {
        frames++
        if (s.count == 0) {
            if (gapStart == null) gapStart = s.t
            return
        }
        faceFrames++
        gapStart?.let { start ->
            val gap = s.t - start
            if (gap > maxGap) maxGap = gap
            if (gap > maxGapMs) gaps++
            gapStart = null
        }
        val centre = Pt(s.box.x + s.box.w / 2, s.box.y + s.box.h / 2)
        val lc = lastCentre
        val lt = lastFaceT
        if (lc != null && lt != null && s.t - lt <= jumpWindowMs) {
            val jump = hypot(centre.x - lc.x, centre.y - lc.y) / sqrt(2f)
            if (jump > maxJumpSeen) maxJumpSeen = jump
            if (jump > maxJump) jumps++
        }
        lastCentre = centre
        lastFaceT = s.t
    }

    fun report(now: Long? = null): Report {
        var mg = maxGap
        var g = gaps
        val start = gapStart
        if (start != null && now != null) {
            val gap = now - start
            if (gap > mg) mg = gap
            if (gap > maxGapMs) g++
        }
        return Report(mg, maxJumpSeen, g, jumps, frames, faceFrames, ok = g == 0 && jumps == 0)
    }
}

/**
 * Screen-flash liveness — port of `flash.ts` / the server's `flash.py`. The
 * screen shows a random sequence of colours; a real 3-D face reflects them,
 * so the mean face colour tracks the sequence (per-channel Pearson). Catches
 * photos and screen replays; does not catch masks (movement challenges do).
 */
object Flash {
    /** name → RGB 0..1 */
    val PALETTE: Map<String, FloatArray> = linkedMapOf(
        "red" to floatArrayOf(1f, 0.15f, 0.15f),
        "green" to floatArrayOf(0.15f, 1f, 0.15f),
        "blue" to floatArrayOf(0.15f, 0.15f, 1f),
        "white" to floatArrayOf(1f, 1f, 1f),
    )
    const val MIN_SCORE = 0.5f
    const val MIN_FRAMES = 3

    fun pickSequence(random: kotlin.random.Random = kotlin.random.Random.Default): List<String> = PALETTE.keys.shuffled(random)

    fun argb(name: String): Int {
        val c = PALETTE[name] ?: PALETTE.getValue("white")
        return (0xFF shl 24) or ((c[0] * 255).toInt() shl 16) or ((c[1] * 255).toInt() shl 8) or (c[2] * 255).toInt()
    }

    /** 0..1: how well the observed face colours tracked the commanded ones. A constant face (photo) scores 0. */
    fun score(commanded: List<FloatArray>, observed: List<FloatArray>): Float {
        if (commanded.size < MIN_FRAMES || commanded.size != observed.size) return 0f
        val scores = ArrayList<Float>()
        for (ch in 0 until 3) {
            val c = FloatArray(commanded.size) { commanded[it][ch] }
            val o = FloatArray(observed.size) { observed[it][ch] }
            if (std(c) < 1e-3f) continue
            if (std(o) < 1e-6f) { scores.add(0f); continue }
            scores.add(max(0f, pearson(c, o)))
        }
        if (scores.isEmpty()) return 0f
        return scores.sum() / scores.size
    }

    private fun std(v: FloatArray): Float {
        val m = v.average().toFloat()
        return sqrt(v.sumOf { ((it - m) * (it - m)).toDouble() }.toFloat() / v.size)
    }

    private fun pearson(a: FloatArray, b: FloatArray): Float {
        val ma = a.average().toFloat(); val mb = b.average().toFloat()
        var num = 0f; var da = 0f; var db = 0f
        for (i in a.indices) {
            val x = a[i] - ma; val y = b[i] - mb
            num += x * y; da += x * x; db += y * y
        }
        if (da <= 1e-18f || db <= 1e-18f) return 0f
        return num / sqrt(da * db)
    }
}
