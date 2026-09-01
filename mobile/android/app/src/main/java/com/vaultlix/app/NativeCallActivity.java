package com.vaultlix.app;

import android.app.Activity;
import android.content.res.ColorStateList;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.HapticFeedbackConstants;
import android.view.WindowManager;
import android.widget.ImageButton;
import android.widget.ImageView;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.Space;
import android.widget.TextView;

import java.util.Random;

/** Keyguard-safe, audio-only presentation for the native Android WebRTC engine. */
public class NativeCallActivity extends Activity implements NativeWebRtcCallEngine.Listener {
    static final String EXTRA_CALLER = "caller";
    static final String EXTRA_ROOM_CODE = "roomCode";
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
    private TextView muteLabel;
    private TextView routeLabel;
    private ImageButton muteButton;
    private ImageButton routeButton;
    private long connectedAt;
    private boolean muted;
    private boolean speaker;
    private AudioManager audioManager;
    private LinearLayout callRoot;
    private String roomCode;
    private boolean finishingCall;
    private final Runnable tick = new Runnable() {
        @Override public void run() {
            if (connectedAt == 0 || status == null) return;
            long seconds = Math.max(0, (System.currentTimeMillis() - connectedAt) / 1000);
            status.setText(String.format(java.util.Locale.US, "%02d:%02d", seconds / 60, seconds % 60));
            handler.postDelayed(this, 1000);
        }
    };

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        setShowWhenLocked(true);
        setTurnScreenOn(true);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN);
        getWindow().setStatusBarColor(INK);
        getWindow().setNavigationBarColor(INK);
        roomCode = getIntent().getStringExtra(EXTRA_ROOM_CODE);
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
        configureAudio(false);
        buildUi(getIntent().getStringExtra(EXTRA_CALLER));
    }

    private void buildUi(String callerValue) {
        String caller = callerValue == null || callerValue.trim().isEmpty()
                ? getString(R.string.native_private_call) : callerValue.trim();
        FrameLayout stage = new FrameLayout(this);
        stage.setBackgroundColor(INK);
        stage.addView(new BinaryStreamView(), new FrameLayout.LayoutParams(-1, -1));

        LinearLayout root = new LinearLayout(this);
        callRoot = root;
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        root.setPadding(dp(28), dp(28), dp(28), dp(28));
        root.setBackgroundColor(Color.TRANSPARENT);

        LinearLayout brandRow = new LinearLayout(this);
        brandRow.setGravity(Gravity.CENTER_VERTICAL);
        ImageView lock = new ImageView(this);
        lock.setImageResource(R.drawable.ic_call_lock);
        lock.setImageTintList(ColorStateList.valueOf(IVORY));
        lock.setPadding(dp(9), dp(9), dp(9), dp(9));
        lock.setBackground(circle(CONTROL));
        brandRow.addView(lock, new LinearLayout.LayoutParams(dp(38), dp(38)));
        TextView brand = label("Vaultlix", 20, IVORY);
        brand.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        brand.setLetterSpacing(-0.02f);
        LinearLayout.LayoutParams brandText = new LinearLayout.LayoutParams(-2, -2);
        brandText.setMargins(dp(11), 0, 0, 0);
        brandRow.addView(brand, brandText);
        root.addView(brandRow, new LinearLayout.LayoutParams(-2, dp(42)));

        root.addView(new Space(this), new LinearLayout.LayoutParams(1, 0, 1.05f));
        TextView avatar = label(initialFor(caller), 39, IVORY);
        avatar.setTypeface(Typeface.create("sans-serif", Typeface.BOLD));
        avatar.setBackground(circle(CONTROL_ACTIVE));
        root.addView(avatar, new LinearLayout.LayoutParams(dp(104), dp(104)));

        TextView name = label(caller, 32, Color.WHITE);
        name.setTypeface(Typeface.create("sans-serif", Typeface.NORMAL));
        name.setMaxLines(2);
        LinearLayout.LayoutParams nameParams = new LinearLayout.LayoutParams(-1, -2);
        nameParams.setMargins(0, dp(25), 0, dp(8));
        root.addView(name, nameParams);

        status = label(getString(R.string.native_connecting_securely), 18, IVORY);
        root.addView(status);

        LinearLayout privacyPill = new LinearLayout(this);
        privacyPill.setGravity(Gravity.CENTER);
        privacyPill.setPadding(dp(14), dp(8), dp(14), dp(8));
        privacyPill.setBackground(roundRect(Color.rgb(48, 64, 57), 99));
        ImageView privacyLock = new ImageView(this);
        privacyLock.setImageResource(R.drawable.ic_call_lock);
        privacyLock.setImageTintList(ColorStateList.valueOf(Color.rgb(165, 214, 181)));
        privacyPill.addView(privacyLock, new LinearLayout.LayoutParams(dp(15), dp(15)));
        TextView secure = label(getString(R.string.native_encrypted_relayed), 12, Color.rgb(202, 218, 207));
        LinearLayout.LayoutParams secureParams = new LinearLayout.LayoutParams(-2, -2);
        // Keep the lock visually attached to the privacy copy across OEM
        // font metrics and display scaling (notably OnePlus/ColorOS).
        secureParams.setMargins(dp(4), 0, 0, 0);
        privacyPill.addView(secure, secureParams);
        LinearLayout.LayoutParams pillParams = new LinearLayout.LayoutParams(-2, -2);
        pillParams.setMargins(0, dp(20), 0, 0);
        root.addView(privacyPill, pillParams);

        root.addView(new Space(this), new LinearLayout.LayoutParams(1, 0, .9f));
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
        ((ImageButton) endControl.getChildAt(0)).setOnClickListener(v -> { engine.end(true); finishCall(); });
        actions.addView(muteControl, controlParams());
        actions.addView(routeControl, controlParams());
        actions.addView(endControl, controlParams());
        root.addView(actions, new LinearLayout.LayoutParams(-1, dp(112)));
        root.setFocusableInTouchMode(true);
        root.requestFocus();
        stage.addView(root, new FrameLayout.LayoutParams(-1, -1));
        setContentView(stage);
    }

    private LinearLayout control(int icon, int label, int color, boolean end) {
        LinearLayout wrapper = new LinearLayout(this);
        wrapper.setOrientation(LinearLayout.VERTICAL);
        wrapper.setGravity(Gravity.CENTER_HORIZONTAL);
        ImageButton button = new ImageButton(this);
        button.setImageResource(icon);
        button.setImageTintList(ColorStateList.valueOf(Color.WHITE));
        int iconPadding = dp(end ? 18 : 20);
        button.setPadding(iconPadding, iconPadding, iconPadding, iconPadding);
        button.setBackground(circle(color));
        button.setContentDescription(getString(label));
        wrapper.addView(button, new LinearLayout.LayoutParams(dp(68), dp(68)));
        TextView text = label(getString(label), 12, end ? Color.rgb(245, 203, 211) : MUTED_TEXT);
        text.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        LinearLayout.LayoutParams textParams = new LinearLayout.LayoutParams(-1, -2);
        textParams.setMargins(0, dp(9), 0, 0);
        wrapper.addView(text, textParams);
        return wrapper;
    }

    private void toggleMute() {
        muted = !muted;
        engine.setMuted(muted);
        muteButton.setBackground(circle(muted ? CONTROL_ACTIVE : CONTROL));
        muteLabel.setText(muted ? R.string.native_unmute : R.string.native_mute);
        muteButton.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP);
    }

    private void toggleSpeaker() {
        speaker = !speaker;
        configureAudio(speaker);
        routeButton.setBackground(circle(speaker ? CONTROL_ACTIVE : CONTROL));
        routeLabel.setText(speaker ? R.string.native_phone : R.string.native_speaker);
        routeButton.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP);
    }

    @Override public void onState(String value) { runOnUiThread(() -> { if (connectedAt == 0 && status != null) status.setText(R.string.native_connecting_securely); }); }
    @Override public void onConnected() { runOnUiThread(() -> { clearIncomingCallBanner(); if (connectedAt != 0) return; connectedAt=System.currentTimeMillis(); getWindow().getDecorView().performHapticFeedback(HapticFeedbackConstants.CONFIRM); tick.run(); }); }
    @Override public void onEnded(String reason) { runOnUiThread(this::finishCall); }

    private void finishCall() {
        if (finishingCall) return;
        finishingCall = true;
        handler.removeCallbacks(tick);
        String history = connectedAt == 0 ? "" : getString(R.string.native_encrypted_call_duration, formatDuration((System.currentTimeMillis()-connectedAt)/1000));
        MainActivity.notifyDedicatedCallEnded(roomCode, history);
        showCallEndedMoment();
    }

    private void showCallEndedMoment() {
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
        mark.setTypeface(Typeface.create("sans-serif", Typeface.NORMAL));
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

    @Override protected void onDestroy() { handler.removeCallbacks(tick); if (engine != null) engine.removeListener(this); restoreAudio(); super.onDestroy(); }

    private void clearIncomingCallBanner() {
        VaultlixMessagingService.clearActiveCallNotifications(this);
    }

    @SuppressWarnings("deprecation") private void configureAudio(boolean useSpeaker) {
        if (audioManager == null) return; audioManager.setMode(AudioManager.MODE_IN_COMMUNICATION);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            for (AudioDeviceInfo device : audioManager.getAvailableCommunicationDevices()) {
                int desired = useSpeaker ? AudioDeviceInfo.TYPE_BUILTIN_SPEAKER : AudioDeviceInfo.TYPE_BUILTIN_EARPIECE;
                if (device.getType() == desired) { audioManager.setCommunicationDevice(device); break; }
            }
        } else audioManager.setSpeakerphoneOn(useSpeaker);
    }

    @SuppressWarnings("deprecation") private void restoreAudio() { if (audioManager != null) { if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) audioManager.clearCommunicationDevice(); else audioManager.setSpeakerphoneOn(false); audioManager.setMode(AudioManager.MODE_NORMAL); } }
    private TextView label(String value,int size,int color){ TextView v=new TextView(this);v.setText(value);v.setTextSize(size);v.setTextColor(color);v.setGravity(Gravity.CENTER);v.setIncludeFontPadding(false);return v; }
    private LinearLayout.LayoutParams controlParams(){ LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(0,-1,1);p.setMargins(dp(4),0,dp(4),0);return p; }
    private GradientDrawable circle(int color){ GradientDrawable d=new GradientDrawable();d.setShape(GradientDrawable.OVAL);d.setColor(color);return d; }
    private GradientDrawable roundRect(int color,int radius){ GradientDrawable d=new GradientDrawable();d.setColor(color);d.setCornerRadius(dp(radius));return d; }
    private String initialFor(String value){ String trimmed=value == null ? "" : value.trim(); return trimmed.isEmpty() ? "V" : trimmed.substring(0,1).toUpperCase(java.util.Locale.getDefault()); }
    private int dp(int value){return Math.round(value*getResources().getDisplayMetrics().density);}
    private String formatDuration(long value){return String.format(java.util.Locale.US,"%02d:%02d",value/60,value%60);}

    /** Subtle horizontal encrypted-data texture behind the live call UI. */
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
                y[i] = dp(58) + random.nextInt(Math.max(1, height - dp(116)));
            }
        }

        @Override protected void onDraw(Canvas canvas) {
            super.onDraw(canvas);
            long now = System.nanoTime();
            float elapsed = lastFrame == 0 ? 0f : Math.min(.05f, (now - lastFrame) / 1_000_000_000f);
            lastFrame = now;
            for (int i = 0; i < STREAM_COUNT; i++) {
                x[i] += speed[i] * elapsed;
                float width = paint.measureText(bits[i]);
                if (x[i] > getWidth() + dp(20)) x[i] = -width - random.nextInt(dp(90));
                paint.setColor(i % 3 == 0 ? Color.argb(30, 221, 129, 151) : Color.argb(19, 250, 246, 247));
                canvas.drawText(bits[i], x[i], y[i], paint);
            }
            postInvalidateOnAnimation();
        }
    }
}
