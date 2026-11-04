package study.etude.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Google Play Billing for Etude Sync (EtudeStorePlugin.kt), registered before the bridge starts.
        registerPlugin(EtudeStorePlugin.class);
        // Sign in with ChatGPT: native HTTP to OpenAI, Keystore-backed credentials, the 127.0.0.1
        // listener and the Custom Tab (EtudeAuthPlugin.kt).
        registerPlugin(EtudeAuthPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
