package com.vaultlix.app;

import android.app.NotificationManager;
import android.Manifest;
import android.content.pm.PackageManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewParent;
import android.view.WindowInsets;
import android.webkit.JavascriptInterface;
import android.widget.FrameLayout;
import android.widget.TextView;

import com.getcapacitor.BridgeActivity;

import org.json.JSONObject;

import java.lang.ref.WeakReference;

public class MainActivity extends BridgeActivity {
    private static WeakReference<MainActivity> activeInstance = new WeakReference<>(null);
    private AudioManager audioManager;
    private int previousAudioMode = AudioManager.MODE_NORMAL;
    private boolean previousSpeakerphoneOn;
    private AudioDeviceInfo previousCommunicationDevice;
    private boolean audioRouteConfigured;
    private View appSwitcherPrivacyCover;
    private SecureMessageStore secureMessageStore;
    private NativeCallRoomStore nativeCallRoomStore;
    private NativeWebRtcCallEngine nativeCallEngine;
    private final NativeWebRtcCallEngine.Listener nativeCallListener = new NativeWebRtcCallEngine.Listener() {
        @Override public void onState(String state) { emitNativeCallAction("native" + capitalize(state)); }
        @Override public void onConnected() { emitNativeCallAction("nativeConnected"); }
        @Override public void onEnded(String reason) { emitNativeCallAction("ended"); }
    };
    private final Handler audioRouteHandler = new Handler(Looper.getMainLooper());
    private final Runnable enforceConnectedAudioRoute = () -> {
        if (!isFinishing() && !isDestroyed()) applyPreferredCallAudioRoute();
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        activeInstance = new WeakReference<>(this);
        secureMessageStore = new SecureMessageStore(this);
        nativeCallRoomStore = new NativeCallRoomStore(this);
        nativeCallEngine = NativeWebRtcCallEngine.get(this);
        nativeCallEngine.addListener(nativeCallListener);
        getBridge().getWebView().addJavascriptInterface(new AndroidCallBridge(), "VaultlixAndroid");
        openVaultlixInvite(getIntent());
    }

    @Override
    public void onPause() {
        showAppSwitcherPrivacyCover();
        super.onPause();
    }

    @Override
    public void onResume() {
        super.onResume();
        hideAppSwitcherPrivacyCover();
    }

    private void showAppSwitcherPrivacyCover() {
        if (appSwitcherPrivacyCover != null || isFinishing() || isDestroyed()) return;

        FrameLayout cover = new FrameLayout(this);
        cover.setBackgroundColor(Color.rgb(36, 27, 30));
        cover.setClickable(true);
        cover.setFocusable(true);
        cover.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);

        TextView wordmark = new TextView(this);
        wordmark.setText("Vaultlix");
        wordmark.setTextColor(Color.rgb(248, 241, 234));
        wordmark.setTextSize(30);
        wordmark.setGravity(Gravity.CENTER);
        wordmark.setLetterSpacing(0.12f);
        cover.addView(wordmark, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
        ));

        addContentView(cover, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
        ));
        cover.bringToFront();
        appSwitcherPrivacyCover = cover;
    }

    private void hideAppSwitcherPrivacyCover() {
        View cover = appSwitcherPrivacyCover;
        appSwitcherPrivacyCover = null;
        if (cover == null) return;
        ViewParent parent = cover.getParent();
        if (parent instanceof ViewGroup) ((ViewGroup) parent).removeView(cover);
    }

    @Override
    public void onDestroy() {
        audioRouteHandler.removeCallbacks(enforceConnectedAudioRoute);
        restoreAudioRoute();
        if (activeInstance.get() == this) activeInstance.clear();
        if (nativeCallEngine != null) nativeCallEngine.removeListener(nativeCallListener);
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
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        String[] pendingEnd = hasFocus ? NativeCallActions.consumePendingWebViewCallEnd(this) : null;
        if (pendingEnd != null) {
            clearUnderlyingCallState(pendingEnd[0], pendingEnd[1]);
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
                || !isAllowedVaultlixPath(uri.getPath())) {
            return;
        }

        getBridge().getWebView().loadUrl(uri.toString());
    }

    private boolean isAllowedVaultlixPath(String path) {
        if (path == null || path.equals("/") || path.startsWith("/join/")) return true;
        return path.matches("/[A-Za-z0-9][A-Za-z0-9._-]{2,30}[A-Za-z0-9]/?");
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
        public void emergencyReset() {
            runOnUiThread(() -> {
                VaultlixMessagingService.clearActiveCallNotifications(MainActivity.this);
                NotificationManager manager = getSystemService(NotificationManager.class);
                if (manager != null) manager.cancelAll();
                nativeCallEngine.end(false);
                nativeCallRoomStore.clear();
                restoreAudioRoute();
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
        public void callEnded(String historyText) {
            runOnUiThread(MainActivity.this::restoreAudioRoute);
        }

        @JavascriptInterface
        public boolean supportsNativeWebRtc() { return true; }

        @JavascriptInterface
        public boolean hasNativeAudioPermission() {
            return checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
        }

        @JavascriptInterface
        public void requestNativeAudioPermission() {
            runOnUiThread(() -> requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, 72));
        }

        @JavascriptInterface
        public boolean provisionCallRoom(String handle, String code, String token, String keyBase64) {
            return nativeCallRoomStore.save(handle, code, token, keyBase64);
        }

        @JavascriptInterface
        public void removeCallRoom(String handle, String code) {
            nativeCallRoomStore.remove(handle == null ? "" : handle, code == null ? "" : code);
        }

        @JavascriptInterface
        public boolean startOutgoingCall(String roomHandle, String caller) {
            configureCallAudioRoute();
            return nativeCallEngine.prepareOutgoing(roomHandle, caller);
        }

        @JavascriptInterface
        public boolean prepareIncomingCall(String roomHandle, String caller) {
            return nativeCallEngine.prepareIncomingHandle(roomHandle, caller);
        }

        @JavascriptInterface
        public void answerIncomingCall() {
            configureCallAudioRoute();
            nativeCallEngine.answer();
        }

        @JavascriptInterface
        public void endNativeCall() { nativeCallEngine.end(true); }

        @JavascriptInterface
        public void setNativeMuted(boolean muted) { nativeCallEngine.setMuted(muted); }

        @JavascriptInterface
        public boolean secureStoreMessage(String conversationId, String messageId, String plaintext, double createdAt) {
            return secureMessageStore.put(conversationId, messageId, plaintext, (long) createdAt);
        }

        @JavascriptInterface
        public boolean secureDeleteMessage(String conversationId, String messageId) {
            return secureMessageStore.delete(conversationId, messageId);
        }

        @JavascriptInterface
        public boolean secureClearConversation(String conversationId) {
            return secureMessageStore.clearConversation(conversationId);
        }
    }

    /**
     * The dedicated call activity owns a separate WebView and therefore a
     * separate JavaScript call state. When that surface ends a call locally,
     * signalling does not echo the sender's hang-up back to the original
     * foreground WebView. Explicitly clear that underlying call state so its
     * incoming overlay cannot reappear after the call activity finishes.
     */
    public static void notifyDedicatedCallEnded(String roomCode, String historyText) {
        MainActivity activity = activeInstance.get();
        if (activity == null || activity.isFinishing() || activity.isDestroyed()) return;
        // A locked-screen call surface may finish while MainActivity is
        // technically resumed but still hidden and unfocused behind the
        // keyguard. WebView can discard evaluateJavascript in that state, so
        // persist a one-shot marker and consume it only after window focus is
        // genuinely restored.
        NativeCallActions.markPendingWebViewCallEnd(activity, roomCode, historyText);
        if (!activity.hasWindowFocus()) return;
        String[] pendingEnd = NativeCallActions.consumePendingWebViewCallEnd(activity);
        if (pendingEnd != null) activity.clearUnderlyingCallState(pendingEnd[0], pendingEnd[1]);
    }

    private void clearUnderlyingCallState(String roomCode, String historyText) {
        String encodedCode = JSONObject.quote(roomCode == null ? "" : roomCode);
        String encodedHistory = JSONObject.quote(historyText == null ? "" : historyText);
        runOnUiThread(() -> getBridge().getWebView().evaluateJavascript(
                "window.vaultlixNativeCallEnded&&window.vaultlixNativeCallEnded(" + encodedCode + "," + encodedHistory + ");",
                null
        ));
    }

    private void emitNativeCallAction(String action) {
        String encoded = JSONObject.quote(action);
        String encodedCode = JSONObject.quote(nativeCallEngine == null ? "" : nativeCallEngine.currentRoomCode());
        runOnUiThread(() -> getBridge().getWebView().evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('vaultlix:call-action',{detail:{action:" + encoded + ",code:" + encodedCode + "}}));",
                null));
    }

    private static String capitalize(String value) {
        if (value == null || value.isEmpty()) return "";
        return Character.toUpperCase(value.charAt(0)) + value.substring(1);
    }
}
