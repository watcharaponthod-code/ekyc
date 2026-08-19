// android/app/src/main/kotlin/<your package>/EkycLivenessPlugin.kt
//
// Flutter bridge (MethodChannel), ~40 lines: launch the SDK activity, return
// the result JSON. Register in MainActivity.configureFlutterEngine:
//   flutterEngine.plugins.add(EkycLivenessPlugin())
package com.example.app // ← your package

import android.app.Activity
import android.content.Intent
import com.ekyc.liveness.EkycLiveness
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.embedding.engine.plugins.activity.ActivityAware
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugin.common.PluginRegistry

class EkycLivenessPlugin : FlutterPlugin, ActivityAware, PluginRegistry.ActivityResultListener {
    private var channel: MethodChannel? = null
    private var activity: Activity? = null
    private var pending: MethodChannel.Result? = null
    private val requestCode = 0xEC1

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        channel = MethodChannel(binding.binaryMessenger, "ekyc_liveness").also { ch ->
            ch.setMethodCallHandler { call, result ->
                if (call.method != "start") { result.notImplemented(); return@setMethodCallHandler }
                val act = activity ?: run { result.error("no_activity", "not attached", null); return@setMethodCallHandler }
                pending = result
                act.startActivityForResult(EkycLiveness.intentFromJson(act, call.arguments as? String), requestCode)
            }
        }
    }
    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) { channel?.setMethodCallHandler(null) }
    override fun onAttachedToActivity(binding: ActivityPluginBinding) { activity = binding.activity; binding.addActivityResultListener(this) }
    override fun onDetachedFromActivity() { activity = null }
    override fun onReattachedToActivityForConfigChanges(binding: ActivityPluginBinding) = onAttachedToActivity(binding)
    override fun onDetachedFromActivityForConfigChanges() = onDetachedFromActivity()

    override fun onActivityResult(code: Int, resultCode: Int, data: Intent?): Boolean {
        if (code != requestCode) return false
        pending?.success(EkycLiveness.resultFrom(data).toJson())
        pending = null
        return true
    }
}
