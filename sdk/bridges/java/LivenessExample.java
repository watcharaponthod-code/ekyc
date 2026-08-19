// Plain Java host (no Kotlin needed in your app).
package com.example.app;

import android.os.Bundle;
import androidx.activity.result.ActivityResultLauncher;
import androidx.appcompat.app.AppCompatActivity;
import com.ekyc.liveness.EkycLiveness;
import com.ekyc.liveness.LivenessConfig;
import com.ekyc.liveness.LivenessResult;

public class LivenessExample extends AppCompatActivity {
    private ActivityResultLauncher<LivenessConfig> liveness;

    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        liveness = registerForActivityResult(new EkycLiveness.Contract(), (LivenessResult result) -> {
            if (result.getPassed()) { /* verified: proceed */ }
            else { /* result.getReasons(), result.getSteps() */ }
        });
        // Defaults: random challenges like the server flow, Thai, flash phase on.
        liveness.launch(LivenessConfig.fromJson(null));
        // Or from JSON (same shape as every other bridge):
        // startActivityForResult(EkycLiveness.intentFromJson(this, "{\"locale\":\"en\",\"challenges\":[\"turnLeft\",\"openMouth\"]}"), 1);
    }
}
