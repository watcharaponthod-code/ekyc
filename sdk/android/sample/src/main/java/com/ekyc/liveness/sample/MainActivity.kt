package com.ekyc.liveness.sample

import android.graphics.Color
import android.os.Bundle
import android.util.TypedValue
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.ekyc.liveness.EkycLiveness
import com.ekyc.liveness.LivenessConfig
import com.ekyc.liveness.LivenessResult

/**
 * The smallest possible host: one button, one result. This is exactly what a
 * Flutter / React Native / Capacitor bridge does under the hood — launch the
 * contract, read the JSON.
 */
class MainActivity : AppCompatActivity() {
    private lateinit var output: TextView
    private var runs = 0
    private var passes = 0

    private val liveness = registerForActivityResult(EkycLiveness.Contract()) { result: LivenessResult ->
        runs++
        if (result.passed) passes++
        val steps = result.steps.joinToString("\n") { s ->
            "  ${s.challenge}${if (s.phase > 0) "#${s.phase}" else ""}: ${"%.2f".format(s.best)} ${if (s.direction == "above") "≥" else "≤"} ${"%.2f".format(s.needed)} ${if (s.reached) "✓" else "✗"}"
        }
        output.text = buildString {
            append("ผ่าน $passes / $runs\n\n")
            append(if (result.passed) "✓ ผ่าน" else "✗ ไม่ผ่าน ${result.reasons}")
            append("\n${result.durationMs} ms · ท่า: ${result.challenges.joinToString(", ")}\n")
            result.flashScore?.let { append("flash ${"%.2f".format(it)} (${if (result.flashOk == true) "ok" else "low"})\n") }
            result.continuityOk?.let { append("continuity ${if (it) "ok" else "broken"} gap ${result.continuityMaxGapMs} ms jump ${"%.2f".format(result.continuityMaxJump ?: 0f)}\n") }
            append("\n$steps\n\n")
            append(result.log.joinToString("\n"))
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(48, 96, 48, 48); setBackgroundColor(Color.WHITE) }
        col.addView(TextView(this).apply { text = "eKYC Liveness SDK — ตัวอย่าง"; setTextSize(TypedValue.COMPLEX_UNIT_SP, 22f); setTextColor(Color.rgb(31, 58, 95)) })
        col.addView(TextView(this).apply { text = "Local 100 % · ML Kit บนเครื่อง · ไม่มีเซิร์ฟเวอร์"; setTextColor(Color.DKGRAY) })
        col.addView(Button(this).apply {
            text = "เริ่มสแกน (สุ่มท่าแบบเซิร์ฟเวอร์)"
            setOnClickListener { liveness.launch(LivenessConfig()) }
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = 32 })
        col.addView(Button(this).apply {
            text = "เริ่มสแกน (หันซ้าย · อ้าปาก · ขยับเข้า, EN)"
            setOnClickListener { liveness.launch(LivenessConfig(challenges = listOf("turnLeft", "openMouth", "moveCloser"), locale = "en")) }
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        output = TextView(this).apply { setTextColor(Color.BLACK); setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f); gravity = Gravity.START; setPadding(0, 32, 0, 0) }
        col.addView(ScrollView(this).apply { addView(output) }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        setContentView(col)
    }
}
