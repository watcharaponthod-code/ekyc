// Capacitor / Ionic plugin (Android). Register in MainActivity.onCreate
// before super.onCreate: registerPlugin(EkycLivenessPlugin::class.java)
// JS:
//   import { registerPlugin } from '@capacitor/core'
//   const EkycLiveness = registerPlugin<{ start(o: { config?: string }): Promise<{ passed: boolean; resultJson: string }> }>('EkycLiveness')
//   const r = await EkycLiveness.start({ config: JSON.stringify({ locale: 'th' }) })
package com.example.app // ← your package

import androidx.activity.result.ActivityResult
import com.ekyc.liveness.EkycLiveness
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin

@CapacitorPlugin(name = "EkycLiveness")
class EkycLivenessPlugin : Plugin() {
    @PluginMethod
    fun start(call: PluginCall) {
        val intent = EkycLiveness.intentFromJson(context, call.getString("config"))
        startActivityForResult(call, intent, "onLiveness")
    }

    @ActivityCallback
    private fun onLiveness(call: PluginCall?, result: ActivityResult) {
        val r = EkycLiveness.resultFrom(result.data)
        call?.resolve(JSObject().put("resultJson", r.toJson()).put("passed", r.passed))
    }
}
