package com.vaultlix.app;

import android.app.NotificationManager;
import android.hardware.biometrics.BiometricPrompt;
import android.Manifest;
import android.content.pm.PackageManager;
import android.content.pm.ActivityInfo;
import android.content.ClipData;
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
import android.os.CancellationSignal;
import android.provider.Settings;
import android.util.Base64;
import android.view.Gravity;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewParent;
import android.view.WindowInsets;
import android.view.inputmethod.InputMethodManager;
import android.webkit.JavascriptInterface;
import android.widget.FrameLayout;
import android.widget.TextView;

import com.getcapacitor.BridgeActivity;
import androidx.core.content.FileProvider;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.effect.Presentation;
import androidx.media3.transformer.Composition;
import androidx.media3.transformer.DefaultEncoderFactory;
import androidx.media3.transformer.EditedMediaItem;
import androidx.media3.transformer.Effects;
import androidx.media3.transformer.ExportException;
import androidx.media3.transformer.ExportResult;
import androidx.media3.transformer.Transformer;
import androidx.media3.transformer.VideoEncoderSettings;

import org.json.JSONObject;

import java.lang.ref.WeakReference;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.Collections;

public class MainActivity extends BridgeActivity {
    private static final int SAVE_MEDIA_REQUEST = 4107;
    // A share to WhatsApp (and most other apps) often uses Android's Direct
    // Share: control returns to Vaultlix (onResume) almost immediately, while
    // the receiving app reads the granted file asynchronously in the
    // background, sometimes seconds later. Deleting the file the moment we
    // resume raced that read and showed WhatsApp's own "Couldn't send" error.
    // Anything newer than this survives one purge pass; it is swept up on the
    // next one, or by the guaranteed delayed purge scheduled after each share.
    private static final long SHARED_MEDIA_GRACE_MS = 25_000L;
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
    private volatile Uri preparedNumberCardUri;
    private volatile File pendingSaveMediaFile;
    private final ExecutorService mediaCacheCleanupExecutor = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "vaultlix-media-cache-cleanup");
        thread.setDaemon(true);
        return thread;
    });
    private final ExecutorService mediaCompressionExecutor = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "vaultlix-media-compression");
        thread.setDaemon(true);
        return thread;
    });
    private final AtomicBoolean mediaCacheCleanupScheduled = new AtomicBoolean(false);
    private final Handler mediaCacheCleanupHandler = new Handler(Looper.getMainLooper());
    private final NativeWebRtcCallEngine.Listener nativeCallListener = new NativeWebRtcCallEngine.Listener() {
        @Override public void onState(String state) { emitNativeCallAction("native" + capitalize(state)); }
        @Override public void onConnected() { emitNativeCallAction("nativeConnected"); }
        @Override public void onEnded(String reason) {
            // NativeCallActivity owns the authoritative duration/outcome and
            // forwards exactly one history row when it closes. Mirroring the
            // engine's same callback through the hidden main WebView created
            // a second row, often one second apart from the first.
            if (NativeCallActivity.isRunning()) return;
            if ("declined".equals(reason)) emitNativeCallAction("nativeDeclined");
            else if ("cancelled".equals(reason)) emitNativeCallAction("nativeCancelled");
            else if ("unanswered".equals(reason)) emitNativeCallAction("missed");
            else if ("busy".equals(reason)) emitNativeCallAction("nativeBusy");
            else emitNativeCallAction("ended");
        }
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
        // A friend's invitation that came through the Play Store install.
        InstallInvite.checkOnce(getApplicationContext());
        scheduleDecryptedMediaCacheCleanup();
        openVaultlixInvite(getIntent());
    }

    // True while the app's own screen is in front. Incoming calls still use
    // the native engine in this state; the flag is retained for notification
    // presentation and lifecycle decisions outside media ownership.
    private static volatile boolean appInForeground;

    public static boolean isAppInForeground() {
        return appInForeground;
    }

    @Override
    public void onPause() {
        showAppSwitcherPrivacyCover();
        super.onPause();
        appInForeground = false;
    }

    @Override
    public void onResume() {
        super.onResume();
        hideAppSwitcherPrivacyCover();
        appInForeground = true;
        // Share/open targets have finished reading their granted content URI
        // by the time Vaultlix resumes. Remove the decrypted staging copies;
        // a recipient app's explicit saved copy is outside our sandbox and
        // intentionally remains under that user's control.
        scheduleDecryptedMediaCacheCleanup();
    }

    private void scheduleDecryptedMediaCacheCleanup() {
        if (!mediaCacheCleanupScheduled.compareAndSet(false, true)) return;
        try {
            mediaCacheCleanupExecutor.execute(() -> {
                try {
                    purgeDecryptedMediaCacheNow();
                } finally {
                    mediaCacheCleanupScheduled.set(false);
                }
            });
        } catch (RejectedExecutionException ignored) {
            mediaCacheCleanupScheduled.set(false);
        }
    }

    private void purgeDecryptedMediaCacheNow() {
        // shared-media and open-media are handed to another app by URI, which can
        // still be reading them after Vaultlix resumes (see SHARED_MEDIA_GRACE_MS
        // above); age-gate those two. saved-media is only ever read by the system
        // "save as" picker itself, synchronously, before we regain the foreground,
        // and media-compression is never exposed outside Vaultlix — both purge
        // immediately, as before.
        long now = System.currentTimeMillis();
        purgeDirectory(new File(getCacheDir(), "shared-media"), now - SHARED_MEDIA_GRACE_MS);
        purgeDirectory(new File(getCacheDir(), "open-media"), now - SHARED_MEDIA_GRACE_MS);
        purgeDirectory(new File(getCacheDir(), "saved-media"), Long.MAX_VALUE);
        purgeDirectory(new File(getCacheDir(), "media-compression"), Long.MAX_VALUE);
    }

    // Deletes every file in `directory` last modified at or before `cutoffMs`
    // (Long.MAX_VALUE purges unconditionally, matching the previous behaviour).
    private void purgeDirectory(File directory, long cutoffMs) {
        File[] files = directory.listFiles();
        if (files == null) return;
        for (File file : files) {
            if (file == null || file.equals(pendingSaveMediaFile)) continue;
            if (file.lastModified() > cutoffMs) continue;
            file.delete();
        }
    }

    // Runs once, SHARED_MEDIA_GRACE_MS after a share/open, regardless of whether
    // Vaultlix ever regains the foreground in between — the app-resume purge
    // above is not a reliable backstop by itself, since the person sharing may
    // not switch back to Vaultlix again for a long time, if ever.
    private void scheduleGuaranteedMediaCacheCleanup() {
        mediaCacheCleanupHandler.postDelayed(this::scheduleDecryptedMediaCacheCleanup, SHARED_MEDIA_GRACE_MS + 2_000L);
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

    private void emitDeviceAuthentication(boolean ok, boolean available) {
        String script = "window.dispatchEvent(new CustomEvent('vaultlix:device-auth-result',{detail:{ok:"
                + ok + ",available:" + available + "}}));";
        getBridge().getWebView().evaluateJavascript(script, null);
    }

    private void emitDeviceAuthenticationPending() {
        String script = "window.dispatchEvent(new CustomEvent('vaultlix:device-auth-result',{detail:{pending:true,available:true}}));";
        getBridge().getWebView().evaluateJavascript(script, null);
    }

    @Override
    public void onDestroy() {
        audioRouteHandler.removeCallbacks(enforceConnectedAudioRoute);
        mediaCacheCleanupExecutor.shutdownNow();
        mediaCompressionExecutor.shutdownNow();
        restoreAudioRoute();
        if (activeInstance.get() == this) activeInstance.clear();
        if (nativeCallEngine != null) nativeCallEngine.removeListener(nativeCallListener);
        super.onDestroy();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != SAVE_MEDIA_REQUEST) return;
        File source = pendingSaveMediaFile;
        pendingSaveMediaFile = null;
        if (source == null) return;
        try {
            Uri destination = resultCode == RESULT_OK && data != null ? data.getData() : null;
            if (destination != null) {
                try (FileInputStream input = new FileInputStream(source);
                     OutputStream output = getContentResolver().openOutputStream(destination, "w")) {
                    if (output == null) throw new IllegalStateException("No document output stream");
                    byte[] buffer = new byte[16 * 1024];
                    int count;
                    while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
                }
            }
        } catch (Exception ignored) {
        } finally {
            // The chosen document is a copy; decrypted temporary material
            // must not remain in the app cache after the picker closes.
            source.delete();
        }
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
                    if (hasBluetoothPermission() && isBluetoothCallDevice(device)) {
                        audioManager.setCommunicationDevice(device);
                        return;
                    }
                }
                for (AudioDeviceInfo device : audioManager.getAvailableCommunicationDevices()) {
                    if (device.getType() == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE) {
                        audioManager.setCommunicationDevice(device);
                        return;
                    }
                }
            }
        } else {
            audioManager.setSpeakerphoneOn(false);
            if (isBluetoothAudioAvailable()) {
                audioManager.startBluetoothSco();
                audioManager.setBluetoothScoOn(true);
            }
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == 73 && grantResults.length > 0
                && grantResults[0] == PackageManager.PERMISSION_GRANTED
                && audioRouteConfigured) {
            applyPreferredCallAudioRoute();
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

    // ── Phone / Bluetooth / speaker selection for the in-call screen ────────

    /** A Bluetooth headset that can carry a call (SCO, or LE Audio on 12+). */
    private boolean isBluetoothCallDevice(AudioDeviceInfo device) {
        if (device == null) return false;
        int type = device.getType();
        return type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO
                || (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                    && type == AudioDeviceInfo.TYPE_BLE_HEADSET);
    }

    /**
     * Android 12+ will not use a Bluetooth headset for a call unless
     * BLUETOOTH_CONNECT is granted at runtime. It is declared in the manifest
     * but was never requested, so Bluetooth could never be selected.
     */
    private boolean hasBluetoothPermission() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.S
                || checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED;
    }

    private void requestBluetoothPermission() {
        if (hasBluetoothPermission()) return;
        requestPermissions(new String[] { Manifest.permission.BLUETOOTH_CONNECT }, 73);
    }

    private AudioManager ensureAudioManager() {
        if (audioManager == null) audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        return audioManager;
    }

    /** True when a Bluetooth headset can actually be used for the call right now. */
    private boolean isBluetoothAudioAvailable() {
        AudioManager manager = ensureAudioManager();
        if (manager == null || !hasBluetoothPermission()) return false;
        AudioDeviceInfo[] candidates;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            java.util.List<AudioDeviceInfo> communication = manager.getAvailableCommunicationDevices();
            candidates = communication.toArray(new AudioDeviceInfo[0]);
        } else {
            candidates = manager.getDevices(AudioManager.GET_DEVICES_OUTPUTS);
        }
        for (AudioDeviceInfo device : candidates) {
            if (isBluetoothCallDevice(device)) return true;
        }
        return false;
    }

    /** "speaker", "bluetooth" or "phone": where call audio is going right now. */
    @SuppressWarnings("deprecation")
    private String currentAudioRouteName() {
        AudioManager manager = ensureAudioManager();
        if (manager == null) return "phone";
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            AudioDeviceInfo current = manager.getCommunicationDevice();
            if (current != null && current.getType() == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) return "speaker";
            return isBluetoothDevice(current) ? "bluetooth" : "phone";
        }
        if (manager.isSpeakerphoneOn()) return "speaker";
        return manager.isBluetoothScoOn() ? "bluetooth" : "phone";
    }

    private String audioRouteStateJson() {
        try {
            JSONObject state = new JSONObject();
            state.put("route", currentAudioRouteName());
            state.put("bluetoothAvailable", isBluetoothAudioAvailable());
            state.put("bluetoothPermission", hasBluetoothPermission());
            return state.toString();
        } catch (Exception unexpected) {
            return "{}";
        }
    }

    /** Explicitly choose "phone" (earpiece), "bluetooth" or "speaker" for the call. */
    @SuppressWarnings("deprecation")
    private boolean setCallAudioRoute(String route) {
        if (!"phone".equals(route) && !"speaker".equals(route) && !"bluetooth".equals(route)) return false;
        configureCallAudioRoute();
        if (audioManager == null) return false;
        // A user-selected route must win over the delayed OEM/WebRTC
        // earpiece enforcement scheduled when the call first connects.
        audioRouteHandler.removeCallbacks(enforceConnectedAudioRoute);
        if ("bluetooth".equals(route) && !hasBluetoothPermission()) {
            runOnUiThread(this::requestBluetoothPermission);
            return false;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            for (AudioDeviceInfo device : audioManager.getAvailableCommunicationDevices()) {
                boolean wanted = "speaker".equals(route) ? device.getType() == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
                        : "phone".equals(route) ? device.getType() == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
                        : isBluetoothCallDevice(device);
                if (wanted) return audioManager.setCommunicationDevice(device);
            }
            return false;
        }
        if ("bluetooth".equals(route)) {
            audioManager.setSpeakerphoneOn(false);
            audioManager.startBluetoothSco();
            audioManager.setBluetoothScoOn(true);
            return true;
        }
        audioManager.stopBluetoothSco();
        audioManager.setBluetoothScoOn(false);
        audioManager.setSpeakerphoneOn("speaker".equals(route));
        return true;
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
            // Release a Bluetooth headset if setCallAudioRoute("bluetooth") held it open.
            audioManager.stopBluetoothSco();
            audioManager.setBluetoothScoOn(false);
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
            if (pendingEnd[1] != null && !pendingEnd[1].isEmpty()) {
                // Window focus arrives before the remote page has necessarily
                // restored its encrypted rooms. A single delayed delivery
                // avoids losing the history row without replaying it twice.
                new Handler(Looper.getMainLooper()).postDelayed(
                        () -> clearUnderlyingCallState(pendingEnd[0], pendingEnd[1]),
                        5_000
                );
            } else {
                clearUnderlyingCallState(pendingEnd[0], pendingEnd[1]);
            }
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
        if (uri == null) return;
        if ("vaultlix".equalsIgnoreCase(uri.getScheme()) && "connect".equalsIgnoreCase(uri.getHost())
                && uri.getPath() != null && uri.getPath().matches("/[2-9][0-9]{5,9}/?")) {
            uri = Uri.parse("https://vaultlix.com" + uri.getPath() + "?ref=qr");
        } else if ("vaultlix".equalsIgnoreCase(uri.getScheme()) && "recover".equalsIgnoreCase(uri.getHost())
                && uri.getPath() != null && uri.getPath().matches("/[2-9][0-9]{5,9}/?")
                && uri.getFragment() != null && uri.getFragment().matches("k=[A-Za-z0-9_-]{43}")) {
            String privateNumber = uri.getPath().replace("/", "");
            uri = Uri.parse("https://vaultlix.com/?recover=" + privateNumber + "#" + uri.getFragment());
        }
        if (!"https".equalsIgnoreCase(uri.getScheme())
                || !"vaultlix.com".equalsIgnoreCase(uri.getHost())
                || uri.getPath() == null || !isAllowedVaultlixPath(uri.getPath())) {
            return;
        }

        getBridge().getWebView().loadUrl(uri.toString());
    }

    private boolean isAllowedVaultlixPath(String path) {
        if (path == null || path.equals("/") || path.startsWith("/join/")) return true;
        return path.matches("/[A-Za-z0-9][A-Za-z0-9._-]{2,30}[A-Za-z0-9]/?");
    }

    private final class AndroidCallBridge {
        // The six-character invite code carried through the Play Store install, or "".
        @JavascriptInterface
        public String pendingInstallInvite() { return InstallInvite.pendingCode(MainActivity.this); }

        // Whether Google Play has answered yet (the answer can take a moment on first launch).
        @JavascriptInterface
        public boolean installInviteChecked() { return InstallInvite.checked(MainActivity.this); }

        @JavascriptInterface
        public void clearInstallInvite() { InstallInvite.clear(MainActivity.this); }

        @JavascriptInterface
        public void screenImage(String requestId, String base64) {
            if (requestId == null || requestId.length() > 80) return;
            runOnUiThread(() -> {
                String url = getBridge().getWebView().getUrl();
                if (url == null || !url.startsWith("https://vaultlix.com/")) return;
                LocalImageSafety.get(MainActivity.this).check(base64, status -> runOnUiThread(() -> {
                    if (isFinishing() || isDestroyed()) return;
                    String current = getBridge().getWebView().getUrl();
                    if (current == null || !current.startsWith("https://vaultlix.com/")) return;
                    String script = "window.dispatchEvent(new CustomEvent('vaultlix:image-safety-result',{detail:{requestId:"
                            + JSONObject.quote(requestId) + ",status:" + JSONObject.quote(status) + "}}));";
                    getBridge().getWebView().evaluateJavascript(script, null);
                }));
            });
        }

        // A source video is streamed here from the web side in bounded
        // chunks (see beginVideoCompression/appendVideoCompressionChunk)
        // rather than arriving as one base64 data: URL — that used to mean a
        // 100MB video became a ~133MB JS string AND a ~133MB decoded byte
        // array held for the whole compression, a real source of the
        // WebView memory spikes/freezes this chunked handoff exists to
        // avoid. Every access to this map, and to the FileOutputStream it
        // holds, happens only on mediaCompressionExecutor (a single-thread
        // executor) — that serialization is what makes a plain HashMap safe
        // here despite being touched from both the JS bridge thread-hop and
        // the export callback.
        private final java.util.Map<String, ChunkedVideoUpload> chunkedVideoUploads = new java.util.HashMap<>();
        private static final int MAX_CHUNKED_VIDEO_SOURCE_BYTES = 100 * 1024 * 1024;
        private static final int MAX_COMPRESSED_VIDEO_BYTES = 25 * 1024 * 1024;
        // 720p first; if that still doesn't fit under the 25MB ceiling, one
        // more attempt at a visibly lower resolution/bitrate rather than
        // giving up outright — never falling back to the untouched original
        // is only safe because this retry exists.
        private static final int[] VIDEO_COMPRESSION_TIER_HEIGHTS = { 720, 480 };
        private static final int[] VIDEO_COMPRESSION_TIER_BITRATES = { 2_500_000, 1_200_000 };

        private static final class ChunkedVideoUpload {
            final File file;
            final FileOutputStream output;
            final int expectedTotalBytes;
            int writtenBytes;
            ChunkedVideoUpload(File file, FileOutputStream output, int expectedTotalBytes) {
                this.file = file; this.output = output; this.expectedTotalBytes = expectedTotalBytes; this.writtenBytes = 0;
            }
        }

        @JavascriptInterface
        public boolean supportsChunkedVideoCompression() { return true; }

        private void emitVideoCompression(String requestId, byte[] output) {
            mediaCompressionExecutor.execute(() -> {
                String detail = "{requestId:" + JSONObject.quote(requestId) + ",ok:" + (output != null);
                if (output != null) {
                    detail += ",mime:'video/mp4',base64:" + JSONObject.quote(Base64.encodeToString(output, Base64.NO_WRAP));
                }
                detail += "}";
                String script = "window.dispatchEvent(new CustomEvent('vaultlix:video-compression-result',{detail:" + detail + "}));";
                runOnUiThread(() -> {
                    if (isFinishing() || isDestroyed()) return;
                    String current = getBridge().getWebView().getUrl();
                    if (current == null || !current.startsWith("https://vaultlix.com/")) return;
                    getBridge().getWebView().evaluateJavascript(script, null);
                });
            });
        }

        @JavascriptInterface
        public boolean beginVideoCompression(String requestId, String filename, int totalBytes, String mime) {
            if (requestId == null || requestId.isEmpty() || requestId.length() > 80
                    || totalBytes <= 0 || totalBytes > MAX_CHUNKED_VIDEO_SOURCE_BYTES) return false;
            try {
                mediaCompressionExecutor.execute(() -> {
                    if (chunkedVideoUploads.containsKey(requestId)) return;
                    try {
                        File directory = new File(getCacheDir(), "media-compression");
                        if (!directory.exists() && !directory.mkdirs()) return;
                        String extension = "mp4";
                        String candidate = filename == null ? "" : filename.toLowerCase(java.util.Locale.ROOT);
                        int dot = candidate.lastIndexOf('.');
                        if (dot >= 0) {
                            String requestedExtension = candidate.substring(dot + 1);
                            if (requestedExtension.matches("mp4|mov|m4v|3gp|mkv|webm")) extension = requestedExtension;
                        }
                        File file = new File(directory, "input-" + System.nanoTime() + "." + extension);
                        FileOutputStream output = new FileOutputStream(file, false);
                        chunkedVideoUploads.put(requestId, new ChunkedVideoUpload(file, output, totalBytes));
                    } catch (Exception ignored) { }
                });
                return true;
            } catch (RejectedExecutionException unavailable) { return false; }
        }

        @JavascriptInterface
        public boolean appendVideoCompressionChunk(String requestId, String chunkBase64) {
            if (requestId == null || chunkBase64 == null) return false;
            try {
                mediaCompressionExecutor.execute(() -> {
                    ChunkedVideoUpload upload = chunkedVideoUploads.get(requestId);
                    if (upload == null) return;
                    try {
                        byte[] data = Base64.decode(chunkBase64, Base64.DEFAULT);
                        // A chunk that fails to decode, or would overrun the
                        // size this upload was opened for, means the two
                        // sides disagree about what is being sent — abandon
                        // it rather than write something a later finish call
                        // could mistake for a complete, trustworthy file.
                        if (data.length == 0 || upload.writtenBytes + data.length > upload.expectedTotalBytes) {
                            abandonChunkedUpload(requestId);
                            emitVideoCompression(requestId, null);
                            return;
                        }
                        upload.output.write(data);
                        upload.writtenBytes += data.length;
                    } catch (Exception ignored) {
                        abandonChunkedUpload(requestId);
                        emitVideoCompression(requestId, null);
                    }
                });
                return true;
            } catch (RejectedExecutionException unavailable) { return false; }
        }

        @JavascriptInterface
        public void cancelVideoCompression(String requestId) {
            if (requestId == null) return;
            try { mediaCompressionExecutor.execute(() -> abandonChunkedUpload(requestId)); }
            catch (RejectedExecutionException ignored) { }
        }

        // Must only ever be called while already running on mediaCompressionExecutor.
        private void abandonChunkedUpload(String requestId) {
            ChunkedVideoUpload upload = chunkedVideoUploads.remove(requestId);
            if (upload == null) return;
            try { upload.output.close(); } catch (Exception ignored) { }
            upload.file.delete();
        }

        @UnstableApi
        @JavascriptInterface
        public void finishVideoCompression(String requestId) {
            if (requestId == null) return;
            try {
                mediaCompressionExecutor.execute(() -> {
                    ChunkedVideoUpload upload = chunkedVideoUploads.remove(requestId);
                    if (upload == null) return;
                    try { upload.output.close(); } catch (Exception ignored) { }
                    int originalSize = upload.writtenBytes;
                    File outputFile = new File(upload.file.getParentFile(), "output-" + System.nanoTime() + ".mp4");
                    runOnUiThread(() -> startVideoCompression(requestId, upload.file, outputFile, originalSize, 0));
                });
            } catch (RejectedExecutionException ignored) { }
        }

        @UnstableApi
        private void retryOrFailVideoCompression(String requestId, File inputFile, File outputFile, int originalSize, int tier) {
            outputFile.delete();
            int nextTier = tier + 1;
            if (nextTier >= VIDEO_COMPRESSION_TIER_HEIGHTS.length) {
                inputFile.delete();
                emitVideoCompression(requestId, null);
                return;
            }
            File nextOutput = new File(inputFile.getParentFile(), "output-" + System.nanoTime() + ".mp4");
            runOnUiThread(() -> startVideoCompression(requestId, inputFile, nextOutput, originalSize, nextTier));
        }

        @UnstableApi
        private void startVideoCompression(String requestId, File inputFile, File outputFile, int originalSize, int tier) {
            try {
                VideoEncoderSettings encoderSettings = new VideoEncoderSettings.Builder()
                        .setBitrate(VIDEO_COMPRESSION_TIER_BITRATES[tier])
                        .build();
                DefaultEncoderFactory encoderFactory = new DefaultEncoderFactory.Builder(MainActivity.this)
                        .setRequestedVideoEncoderSettings(encoderSettings)
                        .build();
                EditedMediaItem item = new EditedMediaItem.Builder(MediaItem.fromUri(Uri.fromFile(inputFile)))
                        .setEffects(new Effects(
                                Collections.emptyList(),
                                Collections.singletonList(Presentation.createForHeight(VIDEO_COMPRESSION_TIER_HEIGHTS[tier]))))
                        .build();
                Transformer transformer = new Transformer.Builder(MainActivity.this)
                        .setAudioMimeType(MimeTypes.AUDIO_AAC)
                        .setVideoMimeType(MimeTypes.VIDEO_H264)
                        .setEncoderFactory(encoderFactory)
                        .addListener(new Transformer.Listener() {
                            @Override public void onCompleted(Composition composition, ExportResult result) {
                                mediaCompressionExecutor.execute(() -> {
                                    try (FileInputStream input = new FileInputStream(outputFile)) {
                                        byte[] bytes = input.readAllBytes();
                                        if (bytes.length > 0 && bytes.length < originalSize && bytes.length <= MAX_COMPRESSED_VIDEO_BYTES) {
                                            inputFile.delete(); outputFile.delete();
                                            emitVideoCompression(requestId, bytes);
                                        } else {
                                            retryOrFailVideoCompression(requestId, inputFile, outputFile, originalSize, tier);
                                        }
                                    } catch (Exception ignored) {
                                        retryOrFailVideoCompression(requestId, inputFile, outputFile, originalSize, tier);
                                    }
                                });
                            }
                            @Override public void onError(Composition composition, ExportResult result, ExportException exception) {
                                retryOrFailVideoCompression(requestId, inputFile, outputFile, originalSize, tier);
                            }
                        })
                        .build();
                transformer.start(item, outputFile.getAbsolutePath());
            } catch (Exception ignored) {
                retryOrFailVideoCompression(requestId, inputFile, outputFile, originalSize, tier);
            }
        }

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
    public void authenticateSensitiveAction(String reason) {
        runOnUiThread(() -> {
                emitDeviceAuthenticationPending();
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
                    emitDeviceAuthentication(false, false);
                    return;
                }
                try {
                    BiometricPrompt prompt = new BiometricPrompt.Builder(MainActivity.this)
                            .setTitle("Confirm it’s you")
                            .setSubtitle(reason == null || reason.trim().isEmpty()
                                    ? "Open your Vaultlix recovery code" : reason)
                            .setNegativeButton("Cancel", getMainExecutor(), (dialog, which) ->
                                    emitDeviceAuthentication(false, true))
                            .build();
                    prompt.authenticate(new CancellationSignal(), getMainExecutor(),
                            new BiometricPrompt.AuthenticationCallback() {
                                @Override
                                public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                                    emitDeviceAuthentication(true, true);
                                }

                                @Override
                                public void onAuthenticationError(int errorCode, CharSequence errString) {
                                    boolean unavailable = errorCode == BiometricPrompt.BIOMETRIC_ERROR_HW_NOT_PRESENT
                                            || errorCode == BiometricPrompt.BIOMETRIC_ERROR_NO_BIOMETRICS
                                            || errorCode == BiometricPrompt.BIOMETRIC_ERROR_HW_UNAVAILABLE;
                                    emitDeviceAuthentication(false, !unavailable);
                                }

                                @Override
                                public void onAuthenticationFailed() {
                                    // The platform keeps the prompt open so the user can try again.
                                }
                            });
                } catch (RuntimeException unavailable) {
                    emitDeviceAuthentication(false, false);
                }
            });
        }

        @JavascriptInterface
        public boolean prepareShareImage(String dataUrl) {
            if (dataUrl == null || !dataUrl.startsWith("data:image/png;base64,") || dataUrl.length() > 12_000_000) return false;
            try {
                int comma = dataUrl.indexOf(',');
                byte[] png = Base64.decode(dataUrl.substring(comma + 1), Base64.DEFAULT);
                if (png.length == 0 || png.length > 8_000_000) return false;
                File directory = new File(getCacheDir(), "shared");
                if (!directory.exists() && !directory.mkdirs()) return false;
                File card = new File(directory, "vaultlix-private-number.png");
                try (FileOutputStream output = new FileOutputStream(card, false)) { output.write(png); }
                preparedNumberCardUri = FileProvider.getUriForFile(MainActivity.this, getPackageName() + ".fileprovider", card);
                return true;
            } catch (Exception ignored) { return false; }
        }

        @JavascriptInterface
        public boolean sharePreparedImage() {
            Uri uri = preparedNumberCardUri;
            if (uri == null) return false;
            runOnUiThread(() -> {
                try {
                    Intent sendIntent = new Intent(Intent.ACTION_SEND);
                    sendIntent.setType("image/png");
                    sendIntent.putExtra(Intent.EXTRA_STREAM, uri);
                    sendIntent.setClipData(ClipData.newRawUri("Vaultlix number card", uri));
                    sendIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    startActivity(Intent.createChooser(sendIntent, "Share your Vaultlix number"));
                } catch (Exception ignored) {}
            });
            return true;
        }

        @JavascriptInterface
        public boolean shareImage(String dataUrl) {
            return prepareShareImage(dataUrl) && sharePreparedImage();
        }

        @JavascriptInterface
        public boolean shareMedia(String dataUrl, String requestedName) {
            if (dataUrl == null || dataUrl.length() > 36_000_000) return false;
            int marker = dataUrl.indexOf(";base64,");
            if (!dataUrl.startsWith("data:") || marker < 6) return false;
            String mime = dataUrl.substring(5, marker);
            if (!mime.matches("[A-Za-z0-9][A-Za-z0-9.+-]*/[A-Za-z0-9][A-Za-z0-9.+;=_-]*")) return false;
            try {
                byte[] bytes = Base64.decode(dataUrl.substring(marker + 8), Base64.DEFAULT);
                if (bytes.length == 0 || bytes.length > 25 * 1024 * 1024) return false;
                String safeName = requestedName == null ? "vaultlix-file" : requestedName.replaceAll("[^A-Za-z0-9._ -]", "_");
                if (safeName.trim().isEmpty()) safeName = "vaultlix-file";
                File directory = new File(getCacheDir(), "shared-media");
                if (!directory.exists() && !directory.mkdirs()) return false;
                File outputFile = new File(directory, System.currentTimeMillis() + "-" + safeName);
                try (FileOutputStream output = new FileOutputStream(outputFile, false)) { output.write(bytes); }
                Uri uri = FileProvider.getUriForFile(MainActivity.this, getPackageName() + ".fileprovider", outputFile);
                String finalMime = mime;
                runOnUiThread(() -> {
                    Intent sendIntent = new Intent(Intent.ACTION_SEND);
                    sendIntent.setType(finalMime);
                    sendIntent.putExtra(Intent.EXTRA_STREAM, uri);
                    sendIntent.setClipData(ClipData.newRawUri("Vaultlix attachment", uri));
                    sendIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    startActivity(Intent.createChooser(sendIntent, "Save or share"));
                });
                scheduleGuaranteedMediaCacheCleanup();
                return true;
            } catch (Exception ignored) { return false; }
        }

        @JavascriptInterface
        public boolean saveMedia(String dataUrl, String requestedName) {
            if (dataUrl == null || dataUrl.length() > 36_000_000) return false;
            int marker = dataUrl.indexOf(";base64,");
            if (!dataUrl.startsWith("data:") || marker < 6) return false;
            String mime = dataUrl.substring(5, marker);
            if (!mime.matches("[A-Za-z0-9][A-Za-z0-9.+-]*/[A-Za-z0-9][A-Za-z0-9.+;=_-]*")) return false;
            try {
                byte[] bytes = Base64.decode(dataUrl.substring(marker + 8), Base64.DEFAULT);
                if (bytes.length == 0 || bytes.length > 25 * 1024 * 1024) return false;
                String safeName = requestedName == null ? "vaultlix-file" : requestedName.replaceAll("[^A-Za-z0-9._ -]", "_");
                if (safeName.trim().isEmpty()) safeName = "vaultlix-file";
                File directory = new File(getCacheDir(), "saved-media");
                if (!directory.exists() && !directory.mkdirs()) return false;
                File source = new File(directory, System.currentTimeMillis() + "-" + safeName);
                try (FileOutputStream output = new FileOutputStream(source, false)) { output.write(bytes); }
                pendingSaveMediaFile = source;
                String finalName = safeName;
                String finalMime = mime;
                runOnUiThread(() -> {
                    try {
                        Intent saveIntent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                        saveIntent.addCategory(Intent.CATEGORY_OPENABLE);
                        saveIntent.setType(finalMime);
                        saveIntent.putExtra(Intent.EXTRA_TITLE, finalName);
                        startActivityForResult(saveIntent, SAVE_MEDIA_REQUEST);
                    } catch (Exception ignored) {
                        if (pendingSaveMediaFile == source) pendingSaveMediaFile = null;
                        source.delete();
                    }
                });
                return true;
            } catch (Exception ignored) { return false; }
        }

        @JavascriptInterface
        public boolean openMedia(String dataUrl, String requestedName) {
            if (dataUrl == null || dataUrl.length() > 36_000_000) return false;
            int marker = dataUrl.indexOf(";base64,");
            if (!dataUrl.startsWith("data:") || marker < 6) return false;
            String mime = dataUrl.substring(5, marker);
            if (!mime.matches("[A-Za-z0-9][A-Za-z0-9.+-]*/[A-Za-z0-9][A-Za-z0-9.+;=_-]*")) return false;
            try {
                byte[] bytes = Base64.decode(dataUrl.substring(marker + 8), Base64.DEFAULT);
                if (bytes.length == 0 || bytes.length > 25 * 1024 * 1024) return false;
                String safeName = requestedName == null ? "vaultlix-file" : requestedName.replaceAll("[^A-Za-z0-9._ -]", "_");
                if (safeName.trim().isEmpty()) safeName = "vaultlix-file";
                File directory = new File(getCacheDir(), "open-media");
                if (!directory.exists() && !directory.mkdirs()) return false;
                File source = new File(directory, System.currentTimeMillis() + "-" + safeName);
                try (FileOutputStream output = new FileOutputStream(source, false)) { output.write(bytes); }
                Uri uri = FileProvider.getUriForFile(MainActivity.this, getPackageName() + ".fileprovider", source);
                String finalMime = mime;
                runOnUiThread(() -> {
                    try {
                        Intent openIntent = new Intent(Intent.ACTION_VIEW);
                        openIntent.setDataAndType(uri, finalMime);
                        openIntent.setClipData(ClipData.newRawUri("Vaultlix attachment", uri));
                        openIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        startActivity(Intent.createChooser(openIntent, "Open PDF with"));
                    } catch (Exception ignored) {}
                });
                scheduleGuaranteedMediaCacheCleanup();
                return true;
            } catch (Exception ignored) { return false; }
        }

        @JavascriptInterface
        public void setDocumentPreviewOpen(boolean open) {
            runOnUiThread(() -> setRequestedOrientation(open
                    ? ActivityInfo.SCREEN_ORIENTATION_SENSOR
                    : ActivityInfo.SCREEN_ORIENTATION_PORTRAIT));
        }

        @JavascriptInterface
        public void goToDeviceHome() {
            runOnUiThread(() -> {
                Intent home = new Intent(Intent.ACTION_MAIN);
                home.addCategory(Intent.CATEGORY_HOME);
                home.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(home);
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
                secureMessageStore.clearAll();
                purgeDecryptedMediaCacheNow();
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

        /** JSON: {"route":"phone|bluetooth|speaker","bluetoothAvailable":bool,"bluetoothPermission":bool}. */
        @JavascriptInterface
        public String getAudioRouteState() {
            return MainActivity.this.audioRouteStateJson();
        }

        @JavascriptInterface
        public boolean setCallAudioRoute(String route) {
            return MainActivity.this.setCallAudioRoute(route);
        }

        @JavascriptInterface
        public void requestBluetoothPermission() {
            runOnUiThread(MainActivity.this::requestBluetoothPermission);
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
        public boolean canUseFullScreenCalls() {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return true;
            NotificationManager manager = getSystemService(NotificationManager.class);
            return manager != null && manager.canUseFullScreenIntent();
        }

        @JavascriptInterface
        public void openFullScreenCallSettings() {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return;
            runOnUiThread(() -> {
                Intent settingsIntent = new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT)
                        .setData(Uri.parse("package:" + getPackageName()));
                try {
                    startActivity(settingsIntent);
                } catch (RuntimeException unavailableOnOem) {
                    startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                            .setData(Uri.parse("package:" + getPackageName())));
                }
            });
        }

        @JavascriptInterface
        public boolean provisionCallRoom(String handle, String code, String token, String keyBase64) {
            return nativeCallRoomStore.save(handle, code, token, keyBase64);
        }

        @JavascriptInterface
        public boolean provisionCallRoomWithAvatar(String handle, String code, String token, String keyBase64, String profileImage) {
            return nativeCallRoomStore.save(handle, code, token, keyBase64, profileImage);
        }

        @JavascriptInterface
        public void removeCallRoom(String handle, String code) {
            nativeCallRoomStore.remove(handle == null ? "" : handle, code == null ? "" : code);
        }

        @JavascriptInterface
        public boolean startOutgoingCall(String roomHandle, String caller, String peer, String inviteId) {
            return startOutgoingCallInternal(roomHandle, caller, peer, inviteId, false);
        }

        @JavascriptInterface
        public boolean startOutgoingVideoCall(String roomHandle, String caller, String peer, String inviteId) {
            return startOutgoingCallInternal(roomHandle, caller, peer, inviteId, true);
        }

        private boolean startOutgoingCallInternal(String roomHandle, String caller, String peer, String inviteId, boolean startWithVideo) {
            configureCallAudioRoute();
            NativeCallRoomStore.Room saved = nativeCallRoomStore.byHandle(roomHandle);
            if (saved == null || !nativeCallEngine.prepareOutgoing(roomHandle, caller, inviteId, startWithVideo)) return false;
            runOnUiThread(() -> {
                View focused = getCurrentFocus();
                InputMethodManager keyboard = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
                if (keyboard != null && focused != null) keyboard.hideSoftInputFromWindow(focused.getWindowToken(), 0);
                Intent call = new Intent(MainActivity.this, NativeCallActivity.class)
                        .putExtra(NativeCallActivity.EXTRA_CALLER, peer)
                        .putExtra(NativeCallActivity.EXTRA_ROOM_CODE, saved.code)
                        .putExtra(NativeCallActivity.EXTRA_CALLER_AVATAR_PATH, saved.avatarPath)
                        .putExtra(NativeCallActivity.EXTRA_START_WITH_VIDEO, startWithVideo)
                        .putExtra(NativeCallActivity.EXTRA_OUTGOING, true);
                startActivity(call);
                overridePendingTransition(0, 0);
            });
            return true;
        }

        @JavascriptInterface
        public boolean prepareIncomingCall(String roomHandle, String caller) {
            boolean prepared = nativeCallEngine.prepareIncomingHandle(roomHandle, caller);
            if (prepared) runOnUiThread(() -> {
                View focused = getCurrentFocus();
                InputMethodManager keyboard = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
                if (keyboard != null) {
                    View tokenView = focused != null ? focused : getWindow().getDecorView();
                    keyboard.hideSoftInputFromWindow(tokenView.getWindowToken(), 0);
                }
                if (focused != null) focused.clearFocus();
                getWindow().getDecorView().requestFocus();
            });
            return prepared;
        }

        @JavascriptInterface
        public void answerIncomingCall(String caller) {
            configureCallAudioRoute();
            String code = nativeCallEngine.currentRoomCode();
            NativeCallRoomStore.Room saved = nativeCallRoomStore.byCode(code);
            if (saved != null && !NativeCallActivity.isRunning()) {
                String peer = caller == null || caller.trim().isEmpty() ? "Someone" : caller.trim();
                runOnUiThread(() -> {
                    Intent call = new Intent(MainActivity.this, NativeCallActivity.class)
                            .putExtra(NativeCallActivity.EXTRA_CALLER, peer)
                            .putExtra(NativeCallActivity.EXTRA_ROOM_CODE, saved.code)
                            .putExtra(NativeCallActivity.EXTRA_CALLER_AVATAR_PATH, saved.avatarPath)
                            .putExtra(NativeCallActivity.EXTRA_OUTGOING, false);
                    startActivity(call);
                    overridePendingTransition(0, 0);
                });
            }
            nativeCallEngine.answer();
        }

        @JavascriptInterface
        public void endNativeCall(String outcome) { nativeCallEngine.end(true, outcome); }

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
    public static void notifyDedicatedCallEnded(Context context, String roomCode, String historyText) {
        MainActivity activity = activeInstance.get();
        Context persistenceContext = activity != null ? activity : context;
        if (persistenceContext != null) {
            NativeCallActions.markPendingWebViewCallEnd(persistenceContext, roomCode, historyText);
        }
        if (activity == null || activity.isFinishing() || activity.isDestroyed()) return;
        // A locked-screen call surface may finish while MainActivity is
        // technically resumed but still hidden and unfocused behind the
        // keyguard. WebView can discard evaluateJavascript in that state, so
        // persist a one-shot marker and consume it only after window focus is
        // genuinely restored.
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
