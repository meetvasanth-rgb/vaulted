package com.vaultlix.app;

import android.Manifest;
import android.app.Activity;
import android.app.KeyguardManager;
import android.content.pm.PackageManager;
import android.content.res.ColorStateList;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.media.AudioDeviceInfo;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioTrack;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.util.Log;
import android.view.Gravity;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.view.WindowManager;
import android.widget.ImageButton;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.ImageView;
import android.widget.Toast;

import org.webrtc.RendererCommon;
import org.webrtc.SurfaceViewRenderer;

import java.util.Random;

/** Keyguard-safe presentation (audio, with optional video) for the native Android WebRTC engine. */
public class NativeCallActivity extends Activity implements NativeWebRtcCallEngine.Listener {
    private static final String TAG = "VaultlixCallAudio";
    private static volatile boolean running;

    static boolean isRunning() { return running; }
    static final String EXTRA_CALLER = "caller";
    static final String EXTRA_ROOM_CODE = "roomCode";
    static final String EXTRA_OUTGOING = "outgoing";
    static final String EXTRA_START_WITH_VIDEO = "startWithVideo";
    static final String EXTRA_CALLER_AVATAR_PATH = "callerAvatarPath";
    private static final int INK = Color.rgb(39, 29, 37);
    private static final int IVORY = Color.rgb(250, 246, 247);
    private static final int MUTED_TEXT = Color.rgb(190, 177, 184);
    private static final int CONTROL = Color.rgb(63, 48, 58);
    private static final int CONTROL_ACTIVE = Color.rgb(104, 44, 67);
    private static final int END = Color.rgb(190, 76, 99);
    private static final int VANISH_BACKGROUND = Color.rgb(250, 245, 247);
    private static final int VANISH_BURGUNDY = Color.rgb(104, 44, 67);

    private final Handler handler = new Handler(Looper.getMainLooper());
    private NativeWebRtcCallEngine engine;
    private TextView status;
    private TextView security;
    private TextView timer;
    private TextView tagline;
    private TextView muteLabel;
    private TextView routeLabel;
    private ImageButton muteButton;
    private ImageButton routeButton;
    private ImageButton videoButton;
    private TextView videoLabel;
    private LinearLayout flipControl;
    private LinearLayout videoControl;
    private SurfaceViewRenderer remoteView;
    private SurfaceViewRenderer localView;
    private FrameLayout localFrame;
    private TextView videoTitle;
    private View rainView;
    private View videoScrim;
    private View brandRuleView;
    private View brandView;
    private LinearLayout identityView;
    private String callerDisplay = "";
    private boolean remoteVideoShown;
    private boolean frontCamera = true;
    private android.app.AlertDialog videoDialog;
    // A peer on an older app never answers a video request; stop waiting.
    private final Runnable videoRequestTimeout = () -> {
        if (this.finishingCall || this.videoLabel == null || this.engine.hasVideoConsent()) return;
        this.videoLabel.setText(R.string.native_video);
        Toast.makeText(this, getString(R.string.native_video_declined, this.callerDisplay), Toast.LENGTH_SHORT).show();
    };
    private boolean resumeCameraOnStart;
    private long connectedAt;
    private boolean muted;
    // null until the user picks a route, then "phone", "bluetooth" or "speaker".
    // With no choice the system's Bluetooth headset is kept, else the earpiece.
    private String requestedRoute;
    private AudioManager audioManager;
    private LinearLayout callRoot;
    private String roomCode;
    private boolean finishingCall;
    private boolean outgoing;
    private boolean startWithVideo;
    private String pendingHistory = "";
    private AudioTrack ringbackTrack;
    private final Runnable enforceRequestedAudioRoute = () -> {
        if (!finishingCall) applyAudioRoute(requestedRoute);
    };
    // A headset can connect or disconnect mid-call, so keep the button honest.
    private final Runnable audioRoutePoll = new Runnable() {
        @Override public void run() {
            if (finishingCall) return;
            // Until the user explicitly chooses a route, follow the call
            // default: Bluetooth when a call-capable headset is connected,
            // otherwise the receiver. This also catches a headset that
            // becomes visible just after Android finishes call setup.
            if (requestedRoute == null) applyAudioRoute(null);
            else renderAudioRoute(currentRouteName());
            handler.postDelayed(this, 2_000);
        }
    };
    private final Runnable ringback = new Runnable() {
        @Override public void run() {
            if (!outgoing || connectedAt != 0 || finishingCall) return;
            if (ringbackTrack != null && ringbackTrack.getState() == AudioTrack.STATE_INITIALIZED) {
                try {
                    if (ringbackTrack.getPlayState() == AudioTrack.PLAYSTATE_PLAYING) ringbackTrack.stop();
                    ringbackTrack.setPlaybackHeadPosition(0);
                    ringbackTrack.play();
                } catch (IllegalStateException ignored) {}
            }
            handler.postDelayed(this, 4000);
        }
    };
    private final Runnable tick = new Runnable() {
        @Override public void run() {
            if (connectedAt == 0 || timer == null) return;
            long seconds = Math.max(0, (System.currentTimeMillis() - connectedAt) / 1000);
            timer.setText(String.format(java.util.Locale.US, "%02d:%02d", seconds / 60, seconds % 60));
            updateVideoTitle();
            handler.postDelayed(this, 1000);
        }
    };

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        running = true;
        setShowWhenLocked(true);
        setTurnScreenOn(true);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN);
        getWindow().setStatusBarColor(INK);
        getWindow().setNavigationBarColor(INK);
        roomCode = getIntent().getStringExtra(EXTRA_ROOM_CODE);
        outgoing = getIntent().getBooleanExtra(EXTRA_OUTGOING, false);
        startWithVideo = outgoing && getIntent().getBooleanExtra(EXTRA_START_WITH_VIDEO, false);
        engine = NativeWebRtcCallEngine.get(this);
        engine.addListener(this);
        clearIncomingCallBanner();
        // Some OEM System UI builds complete the incoming-call heads-up
        // transition after the answer PendingIntent has already cancelled
        // it. Repeat the narrowly scoped cleanup across that short handoff
        // window so the stale Answer/Decline card cannot cover a live call.
        handler.postDelayed(this::clearIncomingCallBanner, 180);
        handler.postDelayed(this::clearIncomingCallBanner, 750);
        handler.postDelayed(this::clearIncomingCallBanner, 1800);
        audioManager = getSystemService(AudioManager.class);
        requestAudioRoute(null);
        requestBluetoothPermissionIfUnlocked();
        handler.postDelayed(audioRoutePoll, 2_000);
        buildUi(
                getIntent().getStringExtra(EXTRA_CALLER),
                getIntent().getStringExtra(EXTRA_CALLER_AVATAR_PATH)
        );
        // Incoming WebRTC setup begins while the phone is still ringing. If
        // ICE connects before this activity attaches its listener, restore the
        // original connection time so the timer and call-history entry are not
        // lost when the user later answers or opens the call screen.
        long activeConnectedAt = engine.connectedAtMs();
        if (activeConnectedAt > 0L) renderConnected(activeConnectedAt);
        if (outgoing) {
            try {
                ringbackTrack = buildRingbackTrack();
                handler.post(ringback);
            } catch (RuntimeException ignored) {}
        }
    }

    private void buildUi(String callerValue, String callerAvatarPath) {
        String caller = callerValue == null || callerValue.trim().isEmpty()
                ? getString(R.string.native_private_call) : callerValue.trim();
        FrameLayout stage = new FrameLayout(this);
        stage.setBackgroundColor(INK);
        rainView = new BinaryStreamView();
        stage.addView(rainView, new FrameLayout.LayoutParams(-1, -1));
        callerDisplay = caller;
        remoteView = new SurfaceViewRenderer(this);
        if (engine.videoSupported()) remoteView.init(engine.eglContext(), null);
        remoteView.setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FILL);
        remoteView.setEnableHardwareScaler(true);
        remoteView.setVisibility(View.GONE);
        stage.addView(remoteView, new FrameLayout.LayoutParams(-1, -1));
        // Keeps the controls and title legible over any picture.
        videoScrim = new View(this);
        GradientDrawable scrim = new GradientDrawable(GradientDrawable.Orientation.BOTTOM_TOP,
                new int[] { Color.argb(190, 0, 0, 0), Color.TRANSPARENT });
        videoScrim.setBackground(scrim);
        videoScrim.setVisibility(View.GONE);
        FrameLayout.LayoutParams scrimParams = new FrameLayout.LayoutParams(-1, dp(260));
        scrimParams.gravity = Gravity.BOTTOM;
        stage.addView(videoScrim, scrimParams);

        LinearLayout root = new LinearLayout(this);
        callRoot = root;
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        // Mirror the iOS/Web call surface's 84pt top rhythm. The old Android
        // lock+wordmark row hugged the status bar and looked detached from
        // the rest of the call identity.
        root.setPadding(dp(28), dp(72), dp(28), dp(28));
        root.setBackgroundColor(Color.TRANSPARENT);

        View brandRule = new View(this);
        brandRuleView = brandRule;
        brandRule.setBackgroundColor(CONTROL_ACTIVE);
        root.addView(brandRule, new LinearLayout.LayoutParams(dp(50), dp(1)));
        TextView brand = label("Vaultlix", 20, IVORY);
        brand.setTypeface(identityTypeface());
        brand.setLetterSpacing(.12f);
        brandView = brand;
        LinearLayout.LayoutParams brandText = new LinearLayout.LayoutParams(-2, -2);
        brandText.setMargins(0, dp(14), 0, 0);
        root.addView(brand, brandText);

        LinearLayout identity = new LinearLayout(this);
        identity.setOrientation(LinearLayout.VERTICAL);
        identity.setGravity(Gravity.CENTER);
        identityView = identity;
        root.addView(identity, new LinearLayout.LayoutParams(-1, 0, 1f));

        // Keep the same peer identity visible from ringing through the entire
        // connected call. IncomingCallActivity previously owned the photo but
        // dropped its path during this native activity handoff.
        FrameLayout portrait = new FrameLayout(this);
        View halo = new View(this);
        halo.setBackground(circle(Color.argb(24, 255, 255, 255)));
        portrait.addView(halo, centered(dp(108), dp(108)));
        Bitmap callerPhoto = callerAvatarPath == null ? null : BitmapFactory.decodeFile(callerAvatarPath);
        if (callerPhoto != null) {
            ImageView avatar = new ImageView(this);
            avatar.setImageBitmap(callerPhoto);
            avatar.setScaleType(ImageView.ScaleType.CENTER_CROP);
            avatar.setBackground(circle(IVORY));
            avatar.setClipToOutline(true);
            portrait.addView(avatar, centered(dp(88), dp(88)));
        } else {
            TextView avatar = label(initialFor(caller), 34, CONTROL_ACTIVE);
            avatar.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
            avatar.setBackground(circle(IVORY));
            portrait.addView(avatar, centered(dp(88), dp(88)));
        }
        identity.addView(portrait, new LinearLayout.LayoutParams(dp(108), dp(108)));

        TextView name = label(caller, caller.length() > 22 ? 27 : 31, Color.WHITE);
        name.setTypeface(Typeface.create("sans-serif", Typeface.NORMAL));
        name.setMaxLines(2);
        name.setEllipsize(TextUtils.TruncateAt.END);
        LinearLayout.LayoutParams nameParams = new LinearLayout.LayoutParams(-1, -2);
        nameParams.setMargins(0, dp(25), 0, dp(10));
        identity.addView(name, nameParams);

        status = callCaption(statusText(engine.currentState()), IVORY);
        identity.addView(status);
        security = callCaption(getString(R.string.native_end_to_end_encrypted), Color.WHITE);
        LinearLayout.LayoutParams securityParams = new LinearLayout.LayoutParams(-2, -2);
        securityParams.setMargins(0, dp(9), 0, 0);
        identity.addView(security, securityParams);
        timer = label("00:00", 34, Color.WHITE);
        timer.setTypeface(Typeface.create("sans-serif", Typeface.NORMAL));
        timer.setLetterSpacing(.06f);
        timer.setVisibility(View.GONE);
        LinearLayout.LayoutParams timerParams = new LinearLayout.LayoutParams(-2, -2);
        timerParams.setMargins(0, dp(8), 0, 0);
        identity.addView(timer, timerParams);
        tagline = label(getString(R.string.native_call_vanished), 13, MUTED_TEXT);
        tagline.setTypeface(Typeface.create("sans-serif", Typeface.NORMAL));
        tagline.setLetterSpacing(.10f);
        tagline.setVisibility(View.GONE);
        LinearLayout.LayoutParams taglineParams = new LinearLayout.LayoutParams(-2, -2);
        taglineParams.setMargins(0, dp(12), 0, 0);
        identity.addView(tagline, taglineParams);

        LinearLayout actions = new LinearLayout(this);
        actions.setGravity(Gravity.CENTER);
        actions.setBaselineAligned(false);
        LinearLayout muteControl = control(R.drawable.ic_call_mic, R.string.native_mute, CONTROL, false);
        muteButton = (ImageButton) muteControl.getChildAt(0);
        muteLabel = (TextView) muteControl.getChildAt(1);
        muteButton.setOnClickListener(v -> toggleMute());
        LinearLayout routeControl = control(R.drawable.ic_call_speaker, R.string.native_speaker, CONTROL, false);
        routeButton = (ImageButton) routeControl.getChildAt(0);
        routeLabel = (TextView) routeControl.getChildAt(1);
        routeButton.setOnClickListener(v -> toggleSpeaker());
        LinearLayout endControl = control(R.drawable.ic_call_end, R.string.native_end, END, true);
        ((ImageButton) endControl.getChildAt(0)).setOnClickListener(v -> {
            if (outgoing && connectedAt == 0) pendingHistory = "Cancelled call";
            engine.end(true);
            finishCall();
        });
        videoControl = control(R.drawable.ic_call_video, R.string.native_video, CONTROL, false);
        videoButton = (ImageButton) videoControl.getChildAt(0);
        videoLabel = (TextView) videoControl.getChildAt(1);
        videoButton.setOnClickListener(v -> toggleVideo());
        videoControl.setAlpha(.45f);
        flipControl = control(R.drawable.ic_call_flip, R.string.native_flip_camera, CONTROL, false);
        ((ImageButton) flipControl.getChildAt(0)).setOnClickListener(v -> {
            engine.switchCamera();
            frontCamera = !frontCamera;
            if (localView != null) localView.setMirror(frontCamera);
        });
        flipControl.setVisibility(View.GONE);
        actions.addView(muteControl, controlParams());
        actions.addView(routeControl, controlParams());
        actions.addView(videoControl, controlParams());
        actions.addView(flipControl, controlParams());
        actions.addView(endControl, controlParams());
        root.addView(actions, new LinearLayout.LayoutParams(-1, dp(112)));
        root.setFocusableInTouchMode(true);
        root.requestFocus();
        stage.addView(root, new FrameLayout.LayoutParams(-1, -1));
        videoTitle = label(caller, 15, Color.WHITE);
        videoTitle.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        videoTitle.setShadowLayer(dp(4), 0, dp(1), Color.argb(160, 0, 0, 0));
        videoTitle.setMaxLines(1);
        videoTitle.setEllipsize(TextUtils.TruncateAt.END);
        videoTitle.setVisibility(View.GONE);
        FrameLayout.LayoutParams titleParams = new FrameLayout.LayoutParams(-1, -2);
        titleParams.setMargins(dp(96), dp(50), dp(96), 0);
        stage.addView(videoTitle, titleParams);
        localFrame = new FrameLayout(this);
        localFrame.setBackground(roundRect(Color.argb(200, 250, 246, 247), 10));
        localFrame.setPadding(dp(2), dp(2), dp(2), dp(2));
        localView = new SurfaceViewRenderer(this);
        if (engine.videoSupported()) localView.init(engine.eglContext(), null);
        localView.setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FILL);
        localView.setMirror(true);
        localView.setZOrderMediaOverlay(true);
        localFrame.addView(localView, new FrameLayout.LayoutParams(-1, -1));
        localFrame.setVisibility(View.GONE);
        FrameLayout.LayoutParams pip = new FrameLayout.LayoutParams(dp(96), dp(136));
        // Above the controls, like the other calling apps, so it never sits under the status bar.
        pip.gravity = Gravity.BOTTOM | Gravity.END;
        pip.setMargins(0, 0, dp(18), dp(176));
        stage.addView(localFrame, pip);
        setContentView(stage);
        if (!engine.videoSupported()) videoControl.setVisibility(View.GONE);
        engine.setVideoSinks(localView, remoteView);
        renderVideo(engine.isCameraOn(), engine.isRemoteVideoOn());
    }

    private LinearLayout control(int icon, int label, int color, boolean end) {
        LinearLayout wrapper = new LinearLayout(this);
        wrapper.setOrientation(LinearLayout.VERTICAL);
        wrapper.setGravity(Gravity.CENTER_HORIZONTAL);
        ImageButton button = new ImageButton(this);
        button.setImageResource(icon);
        button.setImageTintList(ColorStateList.valueOf(Color.WHITE));
        int iconPadding = dp(end ? 15 : 16);
        button.setPadding(iconPadding, iconPadding, iconPadding, iconPadding);
        button.setBackground(circle(color));
        button.setContentDescription(getString(label));
        wrapper.addView(button, new LinearLayout.LayoutParams(dp(56), dp(56)));
        TextView text = label(getString(label), 12, end ? Color.rgb(245, 203, 211) : MUTED_TEXT);
        text.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        LinearLayout.LayoutParams textParams = new LinearLayout.LayoutParams(-1, -2);
        textParams.setMargins(0, dp(9), 0, 0);
        wrapper.addView(text, textParams);
        return wrapper;
    }

    private FrameLayout.LayoutParams centered(int width, int height) {
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(width, height);
        params.gravity = Gravity.CENTER;
        return params;
    }

    private void toggleVideo() {
        if (connectedAt == 0) return;
        if (engine.isCameraOn()) { engine.setCameraEnabled(false); return; }
        if (!engine.hasVideoConsent()) {
            // Video needs both people to agree, so ask first (like a phone's
            // "switch to video call"); no camera starts until the peer accepts.
            showVideoDialog(new android.app.AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)
                    .setTitle(R.string.native_video_switch_title)
                    .setMessage(getString(R.string.native_video_switch_body, callerDisplay))
                    .setNegativeButton(R.string.native_cancel, null)
                    .setPositiveButton(R.string.native_switch, (dialog, which) -> {
                        engine.requestVideo();
                        videoLabel.setText(R.string.native_video_waiting);
                        handler.removeCallbacks(videoRequestTimeout);
                        handler.postDelayed(videoRequestTimeout, 20_000);
                    })
                    .create());
            return;
        }
        startLocalCamera();
    }

    private void showVideoDialog(android.app.AlertDialog dialog) {
        if (videoDialog != null && videoDialog.isShowing()) videoDialog.dismiss();
        videoDialog = dialog;
        dialog.show();
    }

    private void startLocalCamera() {
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            engine.setCameraEnabled(true);
            return;
        }
        KeyguardManager keyguard = getSystemService(KeyguardManager.class);
        if (keyguard != null && keyguard.isKeyguardLocked()) {
            // A permission dialog cannot appear over the keyguard, so ask for
            // the unlock first and then for the camera.
            Toast.makeText(this, R.string.native_video_unlock, Toast.LENGTH_SHORT).show();
            keyguard.requestDismissKeyguard(this, new KeyguardManager.KeyguardDismissCallback() {
                @Override public void onDismissSucceeded() {
                    requestPermissions(new String[] { Manifest.permission.CAMERA }, 75);
                }
            });
            return;
        }
        requestPermissions(new String[] { Manifest.permission.CAMERA }, 75);
    }

    @Override public void onVideoRequest() {
        runOnUiThread(() -> {
            if (finishingCall || isFinishing()) return;
            showVideoDialog(new android.app.AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)
                    .setTitle(R.string.native_video_switch_title)
                    .setMessage(getString(R.string.native_video_request_body, callerDisplay))
                    .setCancelable(false)
                    .setNegativeButton(R.string.native_not_now, (dialog, which) -> engine.respondVideo(false))
                    .setPositiveButton(R.string.native_switch, (dialog, which) -> {
                        engine.respondVideo(true);
                        startLocalCamera();
                    })
                    .create());
        });
    }

    @Override public void onVideoResponse(boolean accepted) {
        runOnUiThread(() -> {
            handler.removeCallbacks(videoRequestTimeout);
            if (finishingCall || isFinishing()) return;
            if (accepted) startLocalCamera();
            else {
                videoLabel.setText(R.string.native_video);
                Toast.makeText(this, getString(R.string.native_video_declined, callerDisplay), Toast.LENGTH_SHORT).show();
            }
        });
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == 75 && grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            engine.setCameraEnabled(true);
        } else if (requestCode == 74 && grantResults.length > 0
                && grantResults[0] == PackageManager.PERMISSION_GRANTED
                && requestedRoute == null) {
            // The first route decision can run before Android 12+ returns the
            // Bluetooth permission. Re-evaluate immediately after approval.
            requestAudioRoute(null);
        }
    }

    @Override public void onVideoState(boolean localOn, boolean remoteOn) {
        runOnUiThread(() -> renderVideo(localOn, remoteOn));
    }

    // Remote video takes the whole screen (the peer's identity is on it); the
    // local camera is the small preview. Either can be on without the other.
    private void renderVideo(boolean localOn, boolean remoteOn) {
        if (remoteView == null || localFrame == null) return;
        remoteVideoShown = remoteOn;
        remoteView.setVisibility(remoteOn ? View.VISIBLE : View.GONE);
        localFrame.setVisibility(localOn ? View.VISIBLE : View.GONE);
        rainView.setVisibility(remoteOn ? View.GONE : View.VISIBLE);
        videoScrim.setVisibility(remoteOn ? View.VISIBLE : View.GONE);
        identityView.setVisibility(remoteOn ? View.INVISIBLE : View.VISIBLE);
        brandRuleView.setVisibility(remoteOn ? View.INVISIBLE : View.VISIBLE);
        brandView.setVisibility(remoteOn ? View.INVISIBLE : View.VISIBLE);
        videoTitle.setVisibility(remoteOn ? View.VISIBLE : View.GONE);
        updateVideoTitle();
        videoButton.setBackground(circle(localOn ? CONTROL_ACTIVE : CONTROL));
        videoLabel.setText(localOn ? R.string.native_stop_video : R.string.native_video);
        flipControl.setVisibility(localOn ? View.VISIBLE : View.GONE);
    }

    private void updateVideoTitle() {
        if (videoTitle == null || !remoteVideoShown) return;
        String time = connectedAt == 0 ? "" : "  ·  " + formatDuration(Math.max(0, (System.currentTimeMillis() - connectedAt) / 1000));
        videoTitle.setText(callerDisplay + time);
    }

    @Override protected void onStop() {
        // Android only lets the foreground call screen use the camera, so the
        // camera pauses when the screen is left or locked and resumes on return.
        if (engine != null && engine.isCameraOn() && !finishingCall) {
            resumeCameraOnStart = true;
            engine.setCameraEnabled(false);
        }
        super.onStop();
    }

    @Override protected void onStart() {
        super.onStart();
        if (resumeCameraOnStart && engine != null && !finishingCall) {
            resumeCameraOnStart = false;
            engine.setCameraEnabled(true);
        }
    }

    private void toggleMute() {
        muted = !muted;
        engine.setMuted(muted);
        muteButton.setBackground(circle(muted ? CONTROL_ACTIVE : CONTROL));
        muteLabel.setText(muted ? R.string.native_unmute : R.string.native_mute);
        muteButton.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP);
    }

    // With a Bluetooth headset a tap goes Bluetooth -> Speaker -> Phone;
    // without one it is the original Phone <-> Speaker pair.
    private void toggleSpeaker() {
        String[] order = isBluetoothAudioAvailable()
                ? new String[] { "bluetooth", "speaker", "phone" }
                : new String[] { "phone", "speaker" };
        String current = requestedRoute != null ? requestedRoute : currentRouteName();
        int index = java.util.Arrays.asList(order).indexOf(current);
        requestAudioRoute(order[(index + 1) % order.length]);
        routeButton.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP);
    }

    // The label and icon show where audio is going now (the same as the
    // in-app call screen), not what the next tap would do.
    private void renderAudioRoute(String route) {
        if (routeButton == null || routeLabel == null) return;
        routeButton.setImageResource("bluetooth".equals(route) ? R.drawable.ic_call_bluetooth : R.drawable.ic_call_speaker);
        routeButton.setBackground(circle("phone".equals(route) ? CONTROL : CONTROL_ACTIVE));
        routeLabel.setText("bluetooth".equals(route) ? R.string.native_bluetooth
                : "speaker".equals(route) ? R.string.native_speaker : R.string.native_phone);
    }

    private boolean isBluetoothDevice(AudioDeviceInfo device) {
        if (device == null) return false;
        int type = device.getType();
        return type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO
                || type == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP
                || (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                    && type == AudioDeviceInfo.TYPE_BLE_HEADSET);
    }

    /** A Bluetooth headset that can carry a call (SCO, or LE Audio on 12+). */
    private boolean isBluetoothCallDevice(AudioDeviceInfo device) {
        if (device == null) return false;
        int type = device.getType();
        return type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO
                || (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                    && type == AudioDeviceInfo.TYPE_BLE_HEADSET);
    }

    /** Android 12+ needs BLUETOOTH_CONNECT granted at runtime to use a headset. */
    private boolean hasBluetoothPermission() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.S
                || checkSelfPermission(android.Manifest.permission.BLUETOOTH_CONNECT)
                        == android.content.pm.PackageManager.PERMISSION_GRANTED;
    }

    /** Ask once, and only when the screen is unlocked: never over the keyguard. */
    private void requestBluetoothPermissionIfUnlocked() {
        if (hasBluetoothPermission()) return;
        android.app.KeyguardManager keyguard = getSystemService(android.app.KeyguardManager.class);
        if (keyguard != null && keyguard.isKeyguardLocked()) return;
        requestPermissions(new String[] { android.Manifest.permission.BLUETOOTH_CONNECT }, 74);
    }

    private boolean isBluetoothAudioAvailable() {
        if (audioManager == null || !hasBluetoothPermission()) return false;
        AudioDeviceInfo[] candidates = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                ? audioManager.getAvailableCommunicationDevices().toArray(new AudioDeviceInfo[0])
                : audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS);
        for (AudioDeviceInfo device : candidates) {
            if (isBluetoothCallDevice(device)) return true;
        }
        return false;
    }

    private String routeNameOf(AudioDeviceInfo device) {
        if (device != null && device.getType() == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) return "speaker";
        return isBluetoothDevice(device) ? "bluetooth" : "phone";
    }

    @SuppressWarnings("deprecation")
    private String currentRouteName() {
        if (audioManager == null) return "phone";
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) return routeNameOf(audioManager.getCommunicationDevice());
        if (audioManager.isSpeakerphoneOn()) return "speaker";
        return audioManager.isBluetoothScoOn() ? "bluetooth" : "phone";
    }

    @Override public void onState(String value) {
        runOnUiThread(() -> {
            if (connectedAt == 0 && status != null) status.setText(statusText(value));
        });
    }
    @Override public void onConnected() {
        long activeConnectedAt = engine.connectedAtMs();
        renderConnected(activeConnectedAt > 0L ? activeConnectedAt : System.currentTimeMillis());
    }

    private void renderConnected(long connectionStartedAt) { runOnUiThread(() -> { clearIncomingCallBanner(); stopRingback(); if (connectedAt != 0) return;
        connectedAt=connectionStartedAt;
        if (videoControl != null) videoControl.setAlpha(1f);
        // libwebrtc/OEM audio initialization can replace a route selected
        // while the call was ringing. Reassert the user's current choice as
        // soon as the remote track becomes active.
        requestAudioRoute(requestedRoute);
        status.setText(getString(R.string.native_end_to_end_encrypted_call));
        security.setVisibility(View.GONE);
        timer.setVisibility(View.VISIBLE);
        tagline.setVisibility(View.VISIBLE);
        getWindow().getDecorView().performHapticFeedback(HapticFeedbackConstants.CONFIRM);
        tick.run();
        if (startWithVideo && !engine.isCameraOn()) {
            startWithVideo = false;
            engine.requestVideo();
            if (videoLabel != null) videoLabel.setText(R.string.native_video_waiting);
            handler.removeCallbacks(videoRequestTimeout);
            handler.postDelayed(videoRequestTimeout, 20_000);
        }
    }); }
    @Override public void onEnded(String reason) { runOnUiThread(() -> {
        if (connectedAt == 0) {
            if ("declined".equals(reason)) pendingHistory = outgoing ? "Call declined" : "Declined call";
            else if ("cancelled".equals(reason)) pendingHistory = outgoing ? "Cancelled call" : "Caller cancelled";
            else if ("unanswered".equals(reason)) pendingHistory = outgoing ? "No answer" : "Missed encrypted call";
            else if ("busy".equals(reason) && outgoing) {
                Toast.makeText(this, R.string.native_peer_on_another_call, Toast.LENGTH_LONG).show();
            }
        }
        finishCall();
    }); }

    private void finishCall() {
        if (finishingCall) return;
        finishingCall = true;
        stopRingback();
        if (videoDialog != null && videoDialog.isShowing()) videoDialog.dismiss();
        handler.removeCallbacks(tick);
        handler.removeCallbacks(enforceRequestedAudioRoute);
        boolean wasConnected = connectedAt != 0;
        String history = wasConnected ? getString(R.string.native_encrypted_call_duration, formatDuration((System.currentTimeMillis()-connectedAt)/1000)) : pendingHistory;
        MainActivity.notifyDedicatedCallEnded(this, roomCode, history);
        if (wasConnected) {
            showCallEndedMoment();
        } else {
            finish();
            overridePendingTransition(0, 0);
        }
    }

    private void showCallEndedMoment() {
        if (remoteView != null) remoteView.setVisibility(View.GONE);
        if (videoScrim != null) videoScrim.setVisibility(View.GONE);
        if (localFrame != null) localFrame.setVisibility(View.GONE);
        if (videoTitle != null) videoTitle.setVisibility(View.GONE);
        if (callRoot == null) { finish(); overridePendingTransition(0, 0); return; }
        getWindow().setStatusBarColor(VANISH_BACKGROUND);
        getWindow().setNavigationBarColor(VANISH_BACKGROUND);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            int flags = android.view.View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                flags |= android.view.View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            }
            getWindow().getDecorView().setSystemUiVisibility(flags);
        }
        callRoot.removeAllViews();
        callRoot.setGravity(Gravity.CENTER);
        callRoot.setBackgroundColor(VANISH_BACKGROUND);
        TextView mark = label("V", 64, VANISH_BURGUNDY);
        mark.setTypeface(identityTypeface());
        mark.setAlpha(0f);
        mark.setScaleX(.8f);
        mark.setScaleY(.8f);
        callRoot.addView(mark, new LinearLayout.LayoutParams(-1, -2));
        LinearLayout message = new LinearLayout(this);
        message.setGravity(Gravity.CENTER);
        message.setAlpha(0f);
        LinearLayout.LayoutParams messageParams = new LinearLayout.LayoutParams(-2, -2);
        messageParams.setMargins(0, dp(18), 0, 0);
        callRoot.addView(message, messageParams);
        String vanished = getString(R.string.native_call_vanished).toUpperCase(java.util.Locale.getDefault());
        for (int index = 0; index < vanished.length(); index++) {
            TextView grain = label(String.valueOf(vanished.charAt(index)), 11, VANISH_BURGUNDY);
            grain.setTypeface(Typeface.create("sans-serif", Typeface.NORMAL));
            grain.setLetterSpacing(.08f);
            grain.setTag(index);
            message.addView(grain, new LinearLayout.LayoutParams(-2, -2));
        }
        mark.animate().alpha(1f).scaleX(1f).scaleY(1f).setDuration(400).start();
        message.animate().alpha(.8f).setStartDelay(550).setDuration(400).start();
        handler.postDelayed(() -> {
            mark.animate().alpha(0f).translationY(-dp(24)).setDuration(600).start();
        }, 1_700);
        handler.postDelayed(() -> {
            Random random = new Random();
            for (int index = 0; index < message.getChildCount(); index++) {
                TextView grain = (TextView) message.getChildAt(index);
                if (grain.getText().toString().trim().isEmpty()) continue;
                float dx = dp(random.nextInt(35) - 17);
                float dy = dp(16 + random.nextInt(27));
                float rotation = random.nextInt(61) - 30;
                grain.animate()
                        .alpha(0f)
                        .translationX(dx)
                        .translationY(dy)
                        .rotation(rotation)
                        .setStartDelay(index * 16L + random.nextInt(46))
                        .setDuration(850)
                        .start();
            }
        }, 2_350);
        handler.postDelayed(() -> { finish(); overridePendingTransition(0, 0); }, 3_650);
    }

    private void stopRingback() {
        handler.removeCallbacks(ringback);
        if (ringbackTrack != null && ringbackTrack.getState() == AudioTrack.STATE_INITIALIZED) {
            try { ringbackTrack.stop(); } catch (IllegalStateException ignored) {}
        }
    }

    /**
     * Generate ringback ourselves instead of relying on ToneGenerator's
     * telecom tones. Samsung and OnePlus firmware commonly suppress those
     * tones once MODE_IN_COMMUNICATION is active. VOICE_COMMUNICATION_SIGNALLING
     * follows the currently selected communication device, so the sound moves
     * between earpiece and speaker with the existing route button.
     */
    private AudioTrack buildRingbackTrack() {
        final int sampleRate = 16000;
        final int durationMs = 1800;
        final int sampleCount = sampleRate * durationMs / 1000;
        final short[] samples = new short[sampleCount];
        final int fadeSamples = sampleRate / 100;
        for (int i = 0; i < sampleCount; i++) {
            double envelope = 1.0;
            if (i < fadeSamples) envelope = i / (double) fadeSamples;
            else if (i > sampleCount - fadeSamples) envelope = (sampleCount - i) / (double) fadeSamples;
            double seconds = i / (double) sampleRate;
            double tone = Math.sin(2.0 * Math.PI * 440.0 * seconds)
                    + Math.sin(2.0 * Math.PI * 480.0 * seconds);
            samples[i] = (short) (tone * envelope * Short.MAX_VALUE * 0.12);
        }
        AudioAttributes attributes = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION_SIGNALLING)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build();
        AudioFormat format = new AudioFormat.Builder()
                .setSampleRate(sampleRate)
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                .build();
        AudioTrack track = new AudioTrack.Builder()
                .setAudioAttributes(attributes)
                .setAudioFormat(format)
                .setTransferMode(AudioTrack.MODE_STATIC)
                .setBufferSizeInBytes(samples.length * 2)
                .build();
        track.write(samples, 0, samples.length, AudioTrack.WRITE_BLOCKING);
        track.setVolume(0.8f);
        return track;
    }

    @Override protected void onDestroy() {
        running = false;
        if (videoDialog != null && videoDialog.isShowing()) videoDialog.dismiss();
        handler.removeCallbacks(tick);
        handler.removeCallbacks(videoRequestTimeout);
        stopRingback();
        if (ringbackTrack != null) { ringbackTrack.release(); ringbackTrack = null; }
        if (engine != null) { engine.removeListener(this); engine.detachVideoSinks(localView, remoteView); }
        if (localView != null) { localView.release(); localView = null; }
        if (remoteView != null) { remoteView.release(); remoteView = null; }
        restoreAudio();
        super.onDestroy();
    }

    private void clearIncomingCallBanner() {
        VaultlixMessagingService.clearActiveCallNotifications(this);
    }

    private void requestAudioRoute(String route) {
        requestedRoute = route;
        handler.removeCallbacks(enforceRequestedAudioRoute);
        applyAudioRoute(route);
        // WebRTC creates its playout stream asynchronously. Several OEMs
        // accept setCommunicationDevice() and then restore the receiver a
        // fraction of a second later, so keep the explicit user route across
        // that bounded initialization window.
        handler.postDelayed(enforceRequestedAudioRoute, 180);
        handler.postDelayed(enforceRequestedAudioRoute, 600);
        handler.postDelayed(enforceRequestedAudioRoute, 1_400);
    }

    /** route: "phone", "bluetooth", "speaker", or null for the default (keep a connected headset, else earpiece). */
    @SuppressWarnings("deprecation")
    private boolean applyAudioRoute(String route) {
        if (audioManager == null) return false;
        audioManager.setMode(AudioManager.MODE_IN_COMMUNICATION);
        boolean applied = false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            AudioDeviceInfo selected = audioManager.getCommunicationDevice();
            if (route == null) {
                // A connected call-capable headset is the default even when
                // Android has not selected it yet. Merely preserving the
                // current route left new calls on the receiver indefinitely.
                route = isBluetoothAudioAvailable() ? "bluetooth" : "phone";
            }
            if ("bluetooth".equals(route) && !hasBluetoothPermission()) {
                renderAudioRoute(currentRouteName());
                return false;
            }
            for (AudioDeviceInfo device : audioManager.getAvailableCommunicationDevices()) {
                boolean wanted = "speaker".equals(route) ? device.getType() == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
                        : "bluetooth".equals(route) ? isBluetoothCallDevice(device)
                        : device.getType() == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE;
                if (wanted) {
                    applied = audioManager.setCommunicationDevice(device);
                    break;
                }
            }
            selected = audioManager.getCommunicationDevice();
            String actual = routeNameOf(selected);
            renderAudioRoute(actual);
            if (!applied || !actual.equals(route)) {
                Log.w(TAG, "Audio route not yet applied; requested=" + route
                        + " selectedType=" + (selected == null ? "none" : selected.getType()));
            }
            return applied && actual.equals(route);
        }
        if (route == null) route = isBluetoothAudioAvailable() ? "bluetooth" : "phone";
        if ("bluetooth".equals(route)) {
            audioManager.setSpeakerphoneOn(false);
            audioManager.startBluetoothSco();
            audioManager.setBluetoothScoOn(true);
            applied = true;
        } else {
            audioManager.stopBluetoothSco();
            audioManager.setBluetoothScoOn(false);
            audioManager.setSpeakerphoneOn("speaker".equals(route));
            applied = audioManager.isSpeakerphoneOn() == "speaker".equals(route);
        }
        renderAudioRoute(currentRouteName());
        if (!applied) Log.w(TAG, "Legacy audio route not yet applied; requested=" + route);
        return applied;
    }

    @SuppressWarnings("deprecation") private void restoreAudio() { handler.removeCallbacks(enforceRequestedAudioRoute); handler.removeCallbacks(audioRoutePoll); if (audioManager != null) { if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) audioManager.clearCommunicationDevice(); else { audioManager.stopBluetoothSco(); audioManager.setBluetoothScoOn(false); audioManager.setSpeakerphoneOn(false); } audioManager.setMode(AudioManager.MODE_NORMAL); } }
    private TextView label(String value,int size,int color){ TextView v=new TextView(this);v.setText(value);v.setTextSize(size);v.setTextColor(color);v.setGravity(Gravity.CENTER);v.setIncludeFontPadding(false);return v; }
    private TextView callCaption(String value, int color){ TextView v=label(value,11,color);v.setTypeface(Typeface.create("sans-serif-medium",Typeface.NORMAL));v.setAllCaps(true);v.setLetterSpacing(.12f);return v; }
    private LinearLayout.LayoutParams controlParams(){ LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(0,-1,1);p.setMargins(dp(2),0,dp(2),0);return p; }
    private GradientDrawable circle(int color){ GradientDrawable d=new GradientDrawable();d.setShape(GradientDrawable.OVAL);d.setColor(color);return d; }
    private GradientDrawable roundRect(int color,int radius){ GradientDrawable d=new GradientDrawable();d.setColor(color);d.setCornerRadius(dp(radius));return d; }
    private String initialFor(String value){ String trimmed=value == null ? "" : value.trim(); return trimmed.isEmpty() ? "V" : trimmed.substring(0,1).toUpperCase(java.util.Locale.getDefault()); }
    private String statusText(String value) {
        if ("calling".equals(value)) return getString(R.string.native_calling);
        if ("ringing".equals(value)) return getString(R.string.native_ringing);
        return getString(R.string.native_connecting_securely);
    }
    private int dp(int value){return Math.round(value*getResources().getDisplayMetrics().density);}
    private String formatDuration(long value){return String.format(java.util.Locale.US,"%02d:%02d",value/60,value%60);}
    private Typeface identityTypeface(){return getResources().getFont(R.font.cormorant_garamond);}

    /** Subtle vertical encrypted-data rain behind the live call UI. */
    private final class BinaryStreamView extends android.view.View {
        private static final int STREAM_COUNT = 18;
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Random random = new Random(0x5641554cL);
        private final float[] x = new float[STREAM_COUNT];
        private final float[] y = new float[STREAM_COUNT];
        private final float[] speed = new float[STREAM_COUNT];
        private final String[] bits = new String[STREAM_COUNT];
        private long lastFrame;

        BinaryStreamView() {
            super(NativeCallActivity.this);
            paint.setTypeface(Typeface.create("monospace", Typeface.NORMAL));
            paint.setTextSize(dp(11));
            for (int i = 0; i < STREAM_COUNT; i++) {
                speed[i] = dp(8 + random.nextInt(13));
                StringBuilder value = new StringBuilder();
                for (int bit = 0; bit < 9 + random.nextInt(11); bit++) value.append(random.nextBoolean() ? '1' : '0');
                bits[i] = value.toString();
            }
        }

        @Override protected void onSizeChanged(int width, int height, int oldWidth, int oldHeight) {
            for (int i = 0; i < STREAM_COUNT; i++) {
                x[i] = random.nextInt(Math.max(1, width));
                y[i] = random.nextInt(Math.max(1, height));
            }
        }

        @Override protected void onDraw(Canvas canvas) {
            super.onDraw(canvas);
            long now = System.nanoTime();
            float elapsed = lastFrame == 0 ? 0f : Math.min(.05f, (now - lastFrame) / 1_000_000_000f);
            lastFrame = now;
            for (int i = 0; i < STREAM_COUNT; i++) {
                y[i] += speed[i] * elapsed;
                float columnHeight = bits[i].length() * dp(12);
                if (y[i] - columnHeight > getHeight() + dp(20)) {
                    y[i] = -random.nextInt(dp(140));
                    x[i] = random.nextInt(Math.max(1, getWidth()));
                }
                paint.setColor(i % 3 == 0 ? Color.argb(112, 229, 137, 160) : Color.argb(82, 250, 246, 247));
                for (int bit = 0; bit < bits[i].length(); bit++) {
                    canvas.drawText(String.valueOf(bits[i].charAt(bit)), x[i], y[i] - (bits[i].length() - bit) * dp(12), paint);
                }
            }
            postInvalidateOnAnimation();
        }
    }
}
