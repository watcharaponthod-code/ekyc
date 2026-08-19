package com.ekyc.liveness.ui

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.view.View
import kotlin.math.min

/**
 * Light scrim with an oval window over the camera preview, a progress ring
 * around the oval (the hold), and step dots underneath. Pure drawing, no
 * layout XML, so the library ships without resources a host must merge.
 */
internal class OverlayView(context: Context) : View(context) {
    var progress = 0f
        set(v) { field = v.coerceIn(0f, 1f); invalidate() }
    var steps = 0
        set(v) { field = v; invalidate() }
    var stepIndex = 0
        set(v) { field = v; invalidate() }
    var ringColor = ACCENT
        set(v) { field = v; invalidate() }

    private val scrim = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(225, 255, 255, 255) }
    private val ringBg = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = dp(5f); color = Color.argb(60, 31, 58, 95) }
    private val ring = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = dp(5f); strokeCap = Paint.Cap.ROUND }
    private val dotOn = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = ACCENT }
    private val dotOff = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(70, 31, 58, 95) }
    private val path = Path()
    private val oval = RectF()

    /** The oval in view coordinates — the host activity places the text around it. */
    fun ovalRect(out: RectF) { out.set(oval) }

    override fun onDraw(canvas: Canvas) {
        val w = width.toFloat(); val h = height.toFloat()
        val ow = min(w * 0.78f, h * 0.52f)
        val oh = ow * 1.3f
        val cx = w / 2f; val cy = h * 0.46f
        oval.set(cx - ow / 2, cy - oh / 2, cx + ow / 2, cy + oh / 2)

        path.reset()
        path.addRect(0f, 0f, w, h, Path.Direction.CW)
        path.addOval(oval, Path.Direction.CCW)
        path.fillType = Path.FillType.EVEN_ODD
        canvas.drawPath(path, scrim)

        val ringRect = RectF(oval).apply { inset(-dp(6f), -dp(6f)) }
        canvas.drawOval(ringRect, ringBg)
        if (progress > 0f) {
            ring.color = ringColor
            canvas.drawArc(ringRect, -90f, 360f * progress, false, ring)
        }

        if (steps > 0) {
            val r = dp(4.5f); val gap = dp(14f)
            val total = steps * gap
            var x = cx - total / 2 + gap / 2
            val y = oval.bottom + dp(28f)
            for (i in 0 until steps) {
                canvas.drawCircle(x, y, r, if (i < stepIndex) dotOn else dotOff)
                x += gap
            }
        }
    }

    private fun dp(v: Float) = v * resources.displayMetrics.density

    companion object {
        val ACCENT = Color.rgb(31, 58, 95)
        val SUCCESS = Color.rgb(22, 140, 80)
    }
}
