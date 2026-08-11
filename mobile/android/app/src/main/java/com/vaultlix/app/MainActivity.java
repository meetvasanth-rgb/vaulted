package com.vaultlix.app;

import android.app.NotificationManager;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.HapticFeedbackConstants;
import android.webkit.JavascriptInterface;

import com.getcapacitor.BridgeActivity;

import org.json.JSONObject;

import java.lang.ref.WeakReference;

public class MainActivity extends BridgeActivity {
    private static WeakReference<MainActivity> activeInstance = new WeakReference<>(null);

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        activeInstance = new WeakReference<>(this);
        getBridge().getWebView().addJavascriptInterface(new AndroidCallBridge(), "VaultlixAndroid");
        openVaultlixInvite(getIntent());
    }

    @Override
    public void onDestroy() {
        if (activeInstance.get() == this) activeInstance.clear();
        super.onDestroy();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        openVaultlixInvite(intent);
    }

    private void openVaultlixInvite(Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) return;

        int notificationId = intent.getIntExtra(VaultlixMessagingService.EXTRA_CALL_NOTIFICATION_ID, Integer.MIN_VALUE);
        if (notificationId != Integer.MIN_VALUE) {
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) manager.cancel(notificationId);
            intent.removeExtra(VaultlixMessagingService.EXTRA_CALL_NOTIFICATION_ID);
        }

        Uri uri = intent.getData();
        if (uri == null
                || !"https".equalsIgnoreCase(uri.getScheme())
                || !"vaultlix.com".equalsIgnoreCase(uri.getHost())
                || uri.getPath() == null
                || !(uri.getPath().equals("/") || uri.getPath().startsWith("/join/"))) {
            return;
        }

        getBridge().getWebView().loadUrl(uri.toString());
    }

    private final class AndroidCallBridge {
        @JavascriptInterface
        public void shareText(String text) {
            if (text == null || text.trim().isEmpty()) return;
            runOnUiThread(() -> {
                Intent sendIntent = new Intent(Intent.ACTION_SEND);
                sendIntent.setType("text/plain");
                sendIntent.putExtra(Intent.EXTRA_TEXT, text);
                startActivity(Intent.createChooser(sendIntent, "Share Vaultlix invite"));
            });
        }

        @JavascriptInterface
        public void clearCallNotifications() {
            runOnUiThread(() -> VaultlixMessagingService.clearActiveCallNotifications(MainActivity.this));
        }

        @JavascriptInterface
        public void connectedHaptic() {
            runOnUiThread(() -> getWindow().getDecorView().performHapticFeedback(
                    HapticFeedbackConstants.CONFIRM
            ));
        }
    }

    /**
     * The dedicated call activity owns a separate WebView and therefore a
     * separate JavaScript call state. When that surface ends a call locally,
     * signalling does not echo the sender's hang-up back to the original
     * foreground WebView. Explicitly clear that underlying call state so its
     * incoming overlay cannot reappear after the call activity finishes.
     */
    public static void notifyDedicatedCallEnded(String roomCode) {
        MainActivity activity = activeInstance.get();
        if (activity == null || activity.isFinishing() || activity.isDestroyed()) return;
        String encodedCode = JSONObject.quote(roomCode == null ? "" : roomCode);
        activity.runOnUiThread(() -> activity.getBridge().getWebView().evaluateJavascript(
                "window.vaultlixNativeCallEnded&&window.vaultlixNativeCallEnded(" + encodedCode + ");",
                null
        ));
    }
}
