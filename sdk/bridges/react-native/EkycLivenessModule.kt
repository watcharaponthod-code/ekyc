// android/app/src/main/java/<your package>/EkycLivenessModule.kt
//
// React Native bridge (bare RN or Expo dev client). Add EkycLivenessPackage()
// to getPackages() in MainApplication. The pure-JS alternative for RN/Expo is
// `@ekyc/react-native-ekyc-local` in this repo — use this module only when you
// want the native SDK screens.
package com.example.app // ← your package

import android.app.Activity
import android.content.Intent
import com.ekyc.liveness.EkycLiveness
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.uimanager.ViewManager

class EkycLivenessModule(ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx), ActivityEventListener {
    private var pending: Promise? = null
    private val requestCode = 0xEC1
    init { ctx.addActivityEventListener(this) }
    override fun getName() = "EkycLiveness"

    @ReactMethod
    fun start(configJson: String?, promise: Promise) {
        val act = currentActivity ?: run { promise.reject("no_activity", "no current activity"); return }
        pending = promise
        act.startActivityForResult(EkycLiveness.intentFromJson(act, configJson), requestCode)
    }

    override fun onActivityResult(activity: Activity, code: Int, resultCode: Int, data: Intent?) {
        if (code != requestCode) return
        pending?.resolve(EkycLiveness.resultFrom(data).toJson())
        pending = null
    }

    override fun onNewIntent(intent: Intent) {}
}

class EkycLivenessPackage : ReactPackage {
    override fun createNativeModules(ctx: ReactApplicationContext): List<NativeModule> = listOf(EkycLivenessModule(ctx))
    override fun createViewManagers(ctx: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}
