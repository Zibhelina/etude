package study.etude.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Google Play Billing for Etude Sync (EtudeStorePlugin.kt), registered before the bridge starts.
        registerPlugin(EtudeStorePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
