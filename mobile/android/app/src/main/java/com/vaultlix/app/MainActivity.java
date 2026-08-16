package com.vaultlix.app;

import android.app.NotificationManager;
import android.app.KeyguardManager;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.HapticFeedbackConstants;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;

import com.getcapacitor.BridgeActivity;

import org.json.JSONObject;

import java.lang.ref.WeakReference;

public class MainActivity extends BridgeActivity {
    private static final int QUICK_LOCK_AUTH_REQUEST = 7319;
    private static WeakReference<MainActivity> activeInstance = new WeakReference<>(null);
    private AudioManager audioManager;
    private int previousAudioMode = AudioManager.MODE_NORMAL;
    private boolean previousSpeakerphoneOn;
    private AudioDeviceInfo previousCommunicationDevice;
    private boolean audioRouteConfigured;
    private final Handler audioRouteHandler = new Handler(Looper.getMainLooper());
    private final Runnable enforceConnectedAudioRoute = () -> {
        if (!isFinishing() && !isDestroyed()) applyPreferredCallAudioRoute();
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        activeInstance = new WeakReference<>(this);
        getBridge().getWebView().addJavascriptInterface(new AndroidCallBridge(), "VaultlixAndroid");
        openVaultlixInvite(getIntent());
    }

    @Override
    public void onDestroy() {
        audioRouteHandler.removeCallbacks(enforceConnectedAudioRoute);
        restoreAudioRoute();
        if (activeInstance.get() == this) activeInstance.clear();
        super.onDestroy();
    }

    @SuppressWarnings("deprecation")
    private void configureCallAudioRoute() {
        if (audioRouteConfigured) return;
        audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        if (audioManager == null) return;

        previousAudioMode = audioManager.getMode();
        previousSpeakerphoneOn = audioManager.isSpeakerphoneOn();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            previousCommunicationDevice = audioManager.getCommunicationDevice();
        }
        audioManager.setMode(AudioManager.MODE_IN_COMMUNICATION);
        applyPreferredCallAudioRoute();
        audioRouteConfigured = true;
    }

    @SuppressWarnings("deprecation")
    private void applyPreferredCallAudioRoute() {
        if (audioManager == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            AudioDeviceInfo current = audioManager.getCommunicationDevice();
            if (!isBluetoothDevice(current)) {
                for (AudioDeviceInfo device : audioManager.getAvailableCommunicationDevices()) {
                    if (device.getType() == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE) {
                        audioManager.setCommunicationDevice(device);
                        break;
                    }
                }
            }
        } else {
            audioManager.setSpeakerphoneOn(false);
        }
    }

    @SuppressWarnings("deprecation")
    private boolean setSpeakerEnabled(boolean enabled) {
        configureCallAudioRoute();
        if (audioManager == null) return false;
        // A user-selected route must win over the delayed OEM/WebRTC
        // earpiece enforcement scheduled when the call first connects.
        audioRouteHandler.removeCallbacks(enforceConnectedAudioRoute);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            if (enabled) {
                for (AudioDeviceInfo device : audioManager.getAvailableCommunicationDevices()) {
                    if (device.getType() == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) {
                        return audioManager.setCommunicationDevice(device);
                    }
                }
                return false;
            }
            applyPreferredCallAudioRoute();
            AudioDeviceInfo current = audioManager.getCommunicationDevice();
            return current == null || current.getType() != AudioDeviceInfo.TYPE_BUILTIN_SPEAKER;
        }
        audioManager.setSpeakerphoneOn(enabled);
        return audioManager.isSpeakerphoneOn() == enabled;
    }

    @SuppressWarnings("deprecation")
    private boolean isSpeakerEnabled() {
        if (audioManager == null) return false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            AudioDeviceInfo current = audioManager.getCommunicationDevice();
            return current != null && current.getType() == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER;
        }
        return audioManager.isSpeakerphoneOn();
    }

    private boolean isBluetoothDevice(AudioDeviceInfo device) {
        if (device == null) return false;
        int type = device.getType();
        return type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO
                || type == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP
                || (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                    && type == AudioDeviceInfo.TYPE_BLE_HEADSET);
    }

    private void enforceAudioRouteAfterWebRtcConnects() {
        configureCallAudioRoute();
        audioRouteHandler.removeCallbacks(enforceConnectedAudioRoute);
        enforceConnectedAudioRoute.run();
        audioRouteHandler.postDelayed(enforceConnectedAudioRoute, 300);
        audioRouteHandler.postDelayed(enforceConnectedAudioRoute, 1_000);
    }

    @SuppressWarnings("deprecation")
    private void restoreAudioRoute() {
        audioRouteHandler.removeCallbacks(enforceConnectedAudioRoute);
        if (!audioRouteConfigured || audioManager == null) return;
        audioRouteConfigured = false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            if (previousCommunicationDevice != null) {
                audioManager.setCommunicationDevice(previousCommunicationDevice);
            } else {
                audioManager.clearCommunicationDevice();
            }
        } else {
            audioManager.setSpeakerphoneOn(previousSpeakerphoneOn);
        }
        audioManager.setMode(previousAudioMode);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        openVaultlixInvite(intent);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != QUICK_LOCK_AUTH_REQUEST) return;
        boolean success = resultCode == Activity.RESULT_OK;
        if (success) getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
        emitQuickLockAuth(success, success ? null : "Vaultlix remains locked.");
    }

    private void emitQuickLockAuth(boolean success, String error) {
        JSONObject detail = new JSONObject();
        try {
            detail.put("success", success);
            if (error != null) detail.put("error", error);
        } catch (Exception ignored) {}
        String script = "window.dispatchEvent(new CustomEvent('vaultlix:quick-lock-auth',{detail:"
                + detail + "}));";
        getBridge().getWebView().evaluateJavascript(script, null);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus && NativeCallActions.consumePendingWebViewCallEnd(this)) {
            clearUnderlyingCallState(null);
        }
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
        public double statusBarInsetCssPx() {
            WindowInsets insets = getWindow().getDecorView().getRootWindowInsets();
            if (insets == null) return 0;
            int insetPx;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                insetPx = insets.getInsets(WindowInsets.Type.statusBars()
                        | WindowInsets.Type.displayCutout()).top;
            } else {
                insetPx = insets.getStableInsetTop();
            }
            return insetPx / getResources().getDisplayMetrics().density;
        }

        @JavascriptInterface
        public double navigationBarInsetCssPx() {
            WindowInsets insets = getWindow().getDecorView().getRootWindowInsets();
            if (insets == null) return 0;
            int insetPx;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                insetPx = insets.getInsets(WindowInsets.Type.navigationBars()).bottom;
            } else {
                insetPx = insets.getStableInsetBottom();
            }
            return insetPx / getResources().getDisplayMetrics().density;
        }

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
        public void activateQuickLock() {
            runOnUiThread(() -> {
                getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
                VaultlixMessagingService.clearActiveCallNotifications(MainActivity.this);
                NotificationManager manager = getSystemService(NotificationManager.class);
                if (manager != null) manager.cancelAll();
            });
        }

        @JavascriptInterface
        public void emergencyReset() {
            runOnUiThread(() -> {
                VaultlixMessagingService.clearActiveCallNotifications(MainActivity.this);
                NotificationManager manager = getSystemService(NotificationManager.class);
                if (manager != null) manager.cancelAll();
                restoreAudioRoute();
            });
        }

        @JavascriptInterface
        public void authenticateQuickLock() {
            runOnUiThread(() -> {
                KeyguardManager keyguard = (KeyguardManager) getSystemService(Context.KEYGUARD_SERVICE);
                if (keyguard == null || !keyguard.isDeviceSecure()) {
                    emitQuickLockAuth(false, "Set up fingerprint, face unlock, or a device PIN to unlock Vaultlix.");
                    return;
                }
                Intent intent = keyguard.createConfirmDeviceCredentialIntent(
                        "Unlock Vaultlix", "Authenticate to return to your private session");
                if (intent == null) {
                    emitQuickLockAuth(false, "Device authentication is unavailable.");
                    return;
                }
                startActivityForResult(intent, QUICK_LOCK_AUTH_REQUEST);
            });
        }

        @JavascriptInterface
        public void connectedHaptic() {
            runOnUiThread(() -> {
                enforceAudioRouteAfterWebRtcConnects();
                getWindow().getDecorView().performHapticFeedback(HapticFeedbackConstants.CONFIRM);
            });
        }

        @JavascriptInterface
        public boolean isNativeSpeakerAvailable() {
            return true;
        }

        @JavascriptInterface
        public boolean isSpeakerEnabled() {
            return MainActivity.this.isSpeakerEnabled();
        }

        @JavascriptInterface
        public boolean setSpeakerEnabled(boolean enabled) {
            return MainActivity.this.setSpeakerEnabled(enabled);
        }

        @JavascriptInterface
        public void callEnded() {
            runOnUiThread(MainActivity.this::restoreAudioRoute);
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
        // A locked-screen call surface may finish while MainActivity is
        // technically resumed but still hidden and unfocused behind the
        // keyguard. WebView can discard evaluateJavascript in that state, so
        // persist a one-shot marker and consume it only after window focus is
        // genuinely restored.
        NativeCallActions.markPendingWebViewCallEnd(activity);
        if (!activity.hasWindowFocus()) return;
        NativeCallActions.consumePendingWebViewCallEnd(activity);
        activity.clearUnderlyingCallState(roomCode);
    }

    private void clearUnderlyingCallState(String roomCode) {
        String encodedCode = JSONObject.quote(roomCode == null ? "" : roomCode);
        runOnUiThread(() -> getBridge().getWebView().evaluateJavascript(
                "window.vaultlixNativeCallEnded&&window.vaultlixNativeCallEnded(" + encodedCode + ");",
                null
        ));
    }
}
