package com.vaultlix.app;

import android.app.NotificationManager;
import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.getcapacitor.BridgeActivity;

import java.lang.ref.WeakReference;

/**
 * A keyguard-safe host for an active Vaultlix call. The web client enters a
 * restricted call-only mode: no vault list, messages, or attachments are ever
 * rendered above the lock screen. The existing encrypted signalling and WebRTC
 * implementation remain the single call engine.
 */
public class LockedCallActivity extends BridgeActivity {
    private WebView webView;
    private View loadingView;
    private String roomCode;
    private AudioManager audioManager;
    private int previousAudioMode = AudioManager.MODE_NORMAL;
    private boolean previousSpeakerphoneOn;
    private AudioDeviceInfo previousCommunicationDevice;
    private boolean audioRouteConfigured;
    private static WeakReference<LockedCallActivity> activeActivity = new WeakReference<>(null);

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        setShowWhenLocked(true);
        setTurnScreenOn(true);
        getWindow().setBackgroundDrawable(new ColorDrawable(Color.rgb(39, 29, 37)));
        getWindow().getDecorView().setBackgroundColor(Color.rgb(39, 29, 37));
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        super.onCreate(savedInstanceState);
        activeActivity = new WeakReference<>(this);
        configureCallAudioRoute();

        webView = getBridge().getWebView();
        webView.setAlpha(0f);
        webView.setBackgroundColor(0xff271d25);
        webView.addJavascriptInterface(new LockedCallBridge(), "VaultlixLockedCall");
        installLoadingView();

        String rawInvite = getIntent().getStringExtra(IncomingCallActivity.EXTRA_INVITE_URI);
        Uri invite = rawInvite == null ? null : Uri.parse(rawInvite);
        if (!isTrustedInvite(invite)) {
            finish();
            return;
        }
        roomCode = invite.getQueryParameter("room");

        Uri callUri = invite.buildUpon()
                .appendQueryParameter("nativeCallMode", "locked")
                .build();
        webView.loadUrl(callUri.toString());
    }

    @Override
    public void onDestroy() {
        restoreAudioRoute();
        if (activeActivity.get() == this) activeActivity.clear();
        super.onDestroy();
    }

    /**
     * WebRTC inside an Android WebView commonly starts on the media output,
     * which is the loudspeaker. Treat this screen as a voice call instead:
     * preserve an already-selected Bluetooth route, otherwise use the phone's
     * earpiece. The previous process audio state is restored when the dedicated
     * call activity closes.
     */
    @SuppressWarnings("deprecation")
    private void configureCallAudioRoute() {
        audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        if (audioManager == null) return;

        previousAudioMode = audioManager.getMode();
        previousSpeakerphoneOn = audioManager.isSpeakerphoneOn();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            previousCommunicationDevice = audioManager.getCommunicationDevice();
        }

        audioManager.setMode(AudioManager.MODE_IN_COMMUNICATION);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            AudioDeviceInfo current = audioManager.getCommunicationDevice();
            if (!isBluetoothDevice(current)) {
                AudioDeviceInfo earpiece = findCommunicationDevice(AudioDeviceInfo.TYPE_BUILTIN_EARPIECE);
                if (earpiece != null) audioManager.setCommunicationDevice(earpiece);
            }
        } else {
            audioManager.setSpeakerphoneOn(false);
        }
        audioRouteConfigured = true;
    }

    private AudioDeviceInfo findCommunicationDevice(int type) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || audioManager == null) return null;
        for (AudioDeviceInfo device : audioManager.getAvailableCommunicationDevices()) {
            if (device.getType() == type) return device;
        }
        return null;
    }

    private boolean isBluetoothDevice(AudioDeviceInfo device) {
        if (device == null) return false;
        int type = device.getType();
        return type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO
                || type == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP
                || (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                    && type == AudioDeviceInfo.TYPE_BLE_HEADSET);
    }

    @SuppressWarnings("deprecation")
    private void restoreAudioRoute() {
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

    public static void finishActiveCall() {
        LockedCallActivity activity = activeActivity.get();
        if (activity == null) return;
        activity.runOnUiThread(() -> {
            activity.clearNativeCallState();
            activity.finish();
        });
    }

    private void installLoadingView() {
        FrameLayout content = findViewById(android.R.id.content);
        LinearLayout loading = new LinearLayout(this);
        loading.setOrientation(LinearLayout.VERTICAL);
        loading.setGravity(Gravity.CENTER);
        loading.setBackgroundColor(Color.rgb(39, 29, 37));

        TextView brand = new TextView(this);
        brand.setText("Vaultlix");
        brand.setTextColor(Color.WHITE);
        brand.setTextSize(30);
        brand.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        brand.setGravity(Gravity.CENTER);
        loading.addView(brand);

        TextView status = new TextView(this);
        status.setText("Connecting securely…");
        status.setTextColor(Color.rgb(200, 117, 136));
        status.setTextSize(15);
        status.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams statusParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
        );
        statusParams.topMargin = Math.round(14 * getResources().getDisplayMetrics().density);
        loading.addView(status, statusParams);

        content.addView(loading, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
        ));
        loadingView = loading;
    }

    private boolean isTrustedInvite(Uri uri) {
        if (uri == null
                || !"https".equalsIgnoreCase(uri.getScheme())
                || !"vaultlix.com".equalsIgnoreCase(uri.getHost())) return false;
        String path = uri.getPath();
        return path != null && (path.equals("/") || path.startsWith("/join/"));
    }

    @Override
    public void onBackPressed() {
        // Do not reveal navigation or the chat surface above keyguard.
    }

    private final class LockedCallBridge {
        @JavascriptInterface
        public void clearCallNotifications() {
            runOnUiThread(() -> clearNativeCallState());
        }

        @JavascriptInterface
        public void connectedHaptic() {
            runOnUiThread(() -> getWindow().getDecorView().performHapticFeedback(
                    HapticFeedbackConstants.CONFIRM
            ));
        }

        @JavascriptInterface
        public void callReady() {
            runOnUiThread(() -> webView.animate().alpha(1f).setDuration(160)
                    .withEndAction(() -> {
                        if (loadingView != null) {
                            ((FrameLayout) loadingView.getParent()).removeView(loadingView);
                            loadingView = null;
                        }
                    }).start());
        }

        @JavascriptInterface
        public void callEnded() {
            runOnUiThread(() -> {
                clearNativeCallState();
                MainActivity.notifyDedicatedCallEnded(roomCode);
                finish();
            });
        }
    }

    private void clearNativeCallState() {
        VaultlixMessagingService.clearActiveCallNotifications(this);
        NotificationManager manager = getSystemService(NotificationManager.class);
        int id = getIntent().getIntExtra(
                VaultlixMessagingService.EXTRA_CALL_NOTIFICATION_ID,
                Integer.MIN_VALUE
        );
        if (manager != null && id != Integer.MIN_VALUE) manager.cancel(id);
    }
}
