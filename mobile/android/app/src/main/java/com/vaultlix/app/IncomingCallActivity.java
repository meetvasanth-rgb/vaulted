package com.vaultlix.app;

import android.app.Activity;
import android.Manifest;
import android.content.pm.PackageManager;
import android.app.NotificationManager;
import android.content.Intent;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.ImageButton;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.Space;
import android.widget.TextView;

import java.lang.ref.WeakReference;

public class IncomingCallActivity extends Activity {
    private static final int INK = Color.rgb(35, 25, 33);
    private static final int INK_SOFT = Color.rgb(57, 39, 51);
    private static final int IVORY = Color.rgb(250, 246, 247);
    private static final int ROSE = Color.rgb(205, 119, 140);
    private static final int BURGUNDY = Color.rgb(111, 39, 66);
    private static final int DECLINE = Color.rgb(196, 67, 91);
    private static final int ANSWER = Color.rgb(65, 164, 116);
    public static final String EXTRA_INVITE_URI = "inviteUri";
    public static final String EXTRA_CALLER = "caller";
    public static final String EXTRA_AUTO_ANSWER = "autoAnswer";
    public static final String EXTRA_CALL_ID = "callId";
    public static final String EXTRA_NATIVE_PREPARED = "nativePrepared";

    private String inviteUri;
    private int notificationId;
    private String callId;
    private boolean answerInProgress;
    private boolean nativePrepared;
    private String caller;
    private final Handler ringtoneHandler = new Handler(Looper.getMainLooper());
    private final Runnable ringtoneTimeout = this::stopIncomingRingtone;
    private Ringtone incomingRingtone;
    private static WeakReference<IncomingCallActivity> activeActivity = new WeakReference<>(null);

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        activeActivity = new WeakReference<>(this);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().addFlags(
                WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
        );
        getWindow().setStatusBarColor(INK);
        getWindow().setNavigationBarColor(INK);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            getWindow().getDecorView().setSystemUiVisibility(0);
        }
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN);

        handleIntent(getIntent());
    }

    @Override
    protected void onDestroy() {
        stopIncomingRingtone();
        if (activeActivity.get() == this) activeActivity.clear();
        super.onDestroy();
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_VOLUME_DOWN
                && event.getRepeatCount() == 0
                && incomingRingtone != null
                && incomingRingtone.isPlaying()) {
            // Match the platform phone-call convention: volume-down silences
            // this incoming ring only. The call remains pending and the user
            // can still answer or decline it from the visible call surface.
            stopIncomingRingtone();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    public static void finishActiveCall() {
        IncomingCallActivity activity = activeActivity.get();
        if (activity != null) activity.runOnUiThread(activity::finish);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent);
    }

    private void handleIntent(Intent intent) {
        inviteUri = intent.getStringExtra(EXTRA_INVITE_URI);
        callId = intent.getStringExtra(EXTRA_CALL_ID);
        caller = intent.getStringExtra(EXTRA_CALLER);
        nativePrepared = intent.getBooleanExtra(EXTRA_NATIVE_PREPARED, false);
        notificationId = intent.getIntExtra(
                VaultlixMessagingService.EXTRA_CALL_NOTIFICATION_ID,
                Integer.MIN_VALUE
        );
        if (NativeCallActions.wasRecentlyAnswered(this, callId)) {
            // The notification's full-screen PendingIntent may already be in
            // the System UI launch queue when the first Answer tap cancels it.
            // Never let that stale launch cover the connected call activity.
            cancelNotification();
            finish();
            overridePendingTransition(0, 0);
            return;
        }
        showIncomingCall(caller);
        // The full-screen call surface now owns presentation. Remove the
        // duplicate heads-up notification so Android never shows two call UIs,
        // then keep ringing from the visible activity. Pixel devices delay
        // notification audio until after this cancellation, otherwise leaving
        // the full-screen incoming call completely silent.
        cancelNotification();
        startIncomingRingtone();
        if (intent.getBooleanExtra(EXTRA_AUTO_ANSWER, false)) answerCall();
    }

    private void showIncomingCall(String caller) {
        String displayName = caller == null || caller.trim().isEmpty()
                ? getString(R.string.native_private_call) : caller.trim();
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        root.setPadding(dp(30), dp(72), dp(30), dp(30));
        root.setBackgroundColor(INK);

        View brandRule = new View(this);
        brandRule.setBackgroundColor(BURGUNDY);
        root.addView(brandRule, new LinearLayout.LayoutParams(dp(50), dp(1)));
        TextView brand = text("Vaultlix", 20, IVORY);
        brand.setTypeface(getResources().getFont(R.font.cormorant_garamond));
        brand.setLetterSpacing(0.12f);
        LinearLayout.LayoutParams brandParams = new LinearLayout.LayoutParams(-2, -2);
        brandParams.setMargins(0, dp(14), 0, 0);
        root.addView(brand, brandParams);

        root.addView(new Space(this), new LinearLayout.LayoutParams(1, 0, .75f));

        FrameLayout portrait = new FrameLayout(this);
        View halo = new View(this);
        halo.setBackground(circle(Color.argb(24, 255, 255, 255)));
        portrait.addView(halo, centered(dp(132), dp(132)));
        TextView avatar = text(initialFor(displayName), 42, BURGUNDY);
        avatar.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        avatar.setBackground(circle(IVORY));
        portrait.addView(avatar, centered(dp(104), dp(104)));
        root.addView(portrait, new LinearLayout.LayoutParams(dp(132), dp(132)));

        TextView name = text(displayName, displayName.length() > 22 ? 28 : 32, Color.WHITE);
        name.setTypeface(Typeface.create("sans-serif", Typeface.NORMAL));
        name.setMaxLines(2);
        name.setEllipsize(TextUtils.TruncateAt.END);
        LinearLayout.LayoutParams nameParams = new LinearLayout.LayoutParams(-1, -2);
        nameParams.setMargins(0, dp(28), 0, dp(9));
        root.addView(name, nameParams);

        TextView subtitle = text(getString(R.string.native_incoming_encrypted_call), 11, IVORY);
        subtitle.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        subtitle.setAllCaps(true);
        subtitle.setLetterSpacing(.12f);
        root.addView(subtitle);

        root.addView(new Space(this), new LinearLayout.LayoutParams(1, 0, 1f));

        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        actions.setGravity(Gravity.CENTER);
        LinearLayout decline = callAction(R.drawable.ic_call_end, R.string.native_decline, DECLINE, false);
        actionButton(decline).setOnClickListener(view -> declineCall());
        actions.addView(decline, new LinearLayout.LayoutParams(0, dp(114), 1));

        LinearLayout answer = callAction(R.drawable.ic_call_end, R.string.native_answer, ANSWER, true);
        ImageButton answerButton = actionButton(answer);
        answerButton.setRotation(180f);
        answerButton.setOnClickListener(view -> answerCall());
        actions.addView(answer, new LinearLayout.LayoutParams(0, dp(114), 1));

        LinearLayout.LayoutParams actionsParams = new LinearLayout.LayoutParams(-1, dp(114));
        actionsParams.setMargins(dp(8), 0, dp(8), dp(20));
        root.addView(actions, actionsParams);
        root.setFocusableInTouchMode(true);
        root.requestFocus();
        setContentView(root);
    }

    private void answerCall() {
        if (answerInProgress) return;
        if (nativePrepared && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, 71);
            return;
        }
        answerInProgress = true;
        stopIncomingRingtone();
        NativeCallActions.markAnswerStarted(this, callId);
        NativeCallActions.answer(this, callId);
        cancelNotification();
        // ColorOS can retain/re-present the CallStyle heads-up surface while
        // handing off from this full-screen activity to NativeCallActivity.
        // Clear every Vaultlix call-channel notification, not just the ID
        // attached to this particular PendingIntent. Ordinary message
        // notifications use other channels and are left untouched.
        VaultlixMessagingService.clearActiveCallNotifications(this);
        if (nativePrepared) {
            NativeWebRtcCallEngine.get(this).answer();
            Intent call = new Intent(this, NativeCallActivity.class)
                    .putExtra(NativeCallActivity.EXTRA_CALLER, caller)
                    .putExtra(NativeCallActivity.EXTRA_ROOM_CODE, extractRoomCode());
            startActivity(call);
            finish();
            return;
        }
        // Use one dedicated call-only host in every device state. Besides
        // keeping chat hidden above keyguard, this gives foreground and
        // background answers the same branded secure-connection transition.
        openLockedCall();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == 71 && grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) answerCall();
    }

    private String extractRoomCode() {
        try { return Uri.parse(inviteUri).getQueryParameter("room"); }
        catch (Exception ignored) { return ""; }
    }

    private void openLockedCall() {
        if (inviteUri == null || inviteUri.isEmpty()) {
            finish();
            return;
        }
        Intent call = new Intent(this, LockedCallActivity.class);
        call.putExtra(EXTRA_INVITE_URI, inviteUri);
        call.putExtra(VaultlixMessagingService.EXTRA_CALL_NOTIFICATION_ID, notificationId);
        startActivity(call);
        finish();
    }

    private void declineCall() {
        stopIncomingRingtone();
        cancelNotification();
        NativeCallActions.decline(this, callId, null);
        finish();
        // The vault inbox is already resumed underneath this activity. Avoid
        // Android's default close fade briefly compositing this call surface
        // over the live WebView after the user has declined.
        overridePendingTransition(0, 0);
    }

    private void cancelNotification() {
        if (notificationId == Integer.MIN_VALUE) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.cancel(notificationId);
    }

    private void startIncomingRingtone() {
        stopIncomingRingtone();
        AudioManager manager = getSystemService(AudioManager.class);
        if (manager != null && manager.getRingerMode() != AudioManager.RINGER_MODE_NORMAL) return;
        Uri sound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
        Ringtone ringtone = RingtoneManager.getRingtone(getApplicationContext(), sound);
        if (ringtone == null) return;
        ringtone.setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build());
        ringtone.setLooping(true);
        incomingRingtone = ringtone;
        ringtone.play();
        ringtoneHandler.postDelayed(ringtoneTimeout, 60_000);
    }

    private void stopIncomingRingtone() {
        ringtoneHandler.removeCallbacks(ringtoneTimeout);
        Ringtone ringtone = incomingRingtone;
        incomingRingtone = null;
        if (ringtone != null && ringtone.isPlaying()) ringtone.stop();
    }

    private TextView text(String value, int sizeSp, int color) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(sizeSp);
        view.setTextColor(color);
        view.setGravity(Gravity.CENTER);
        return view;
    }

    private LinearLayout callAction(int icon, int label, int color, boolean pulse) {
        LinearLayout wrapper = new LinearLayout(this);
        wrapper.setOrientation(LinearLayout.VERTICAL);
        wrapper.setGravity(Gravity.CENTER_HORIZONTAL);
        FrameLayout buttonStage = new FrameLayout(this);
        if (pulse) {
            View ring = new View(this);
            ring.setBackground(circle(Color.argb(38, 116, 225, 169)));
            buttonStage.addView(ring, centered(dp(88), dp(88)));
            ring.setScaleX(.82f);
            ring.setScaleY(.82f);
            ring.setAlpha(.7f);
            ring.animate().scaleX(1.08f).scaleY(1.08f).alpha(0f).setDuration(1_450).withEndAction(() -> {
                ring.setScaleX(.82f); ring.setScaleY(.82f); ring.setAlpha(.7f);
                ring.animate().scaleX(1.08f).scaleY(1.08f).alpha(0f).setDuration(1_450).start();
            }).start();
        }
        ImageButton button = new ImageButton(this);
        button.setImageResource(icon);
        button.setImageTintList(ColorStateList.valueOf(Color.WHITE));
        button.setPadding(dp(21), dp(21), dp(21), dp(21));
        button.setBackground(circle(color));
        button.setContentDescription(getString(label));
        buttonStage.addView(button, centered(dp(72), dp(72)));
        wrapper.addView(buttonStage, new LinearLayout.LayoutParams(dp(92), dp(88)));
        TextView caption = text(getString(label), 14, IVORY);
        caption.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        wrapper.addView(caption, new LinearLayout.LayoutParams(-1, dp(26)));
        return wrapper;
    }

    private FrameLayout.LayoutParams centered(int width, int height) {
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(width, height);
        params.gravity = Gravity.CENTER;
        return params;
    }

    private ImageButton actionButton(LinearLayout control) {
        FrameLayout stage = (FrameLayout) control.getChildAt(0);
        return (ImageButton) stage.getChildAt(stage.getChildCount() - 1);
    }

    private GradientDrawable circle(int color) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setShape(GradientDrawable.OVAL);
        drawable.setColor(color);
        return drawable;
    }

    private GradientDrawable verticalGradient(int top, int bottom) {
        GradientDrawable drawable = new GradientDrawable(
                GradientDrawable.Orientation.TOP_BOTTOM,
                new int[] { top, INK, bottom }
        );
        drawable.setGradientType(GradientDrawable.LINEAR_GRADIENT);
        return drawable;
    }

    private String initialFor(String value) {
        String trimmed = value == null ? "" : value.trim();
        return trimmed.isEmpty() ? "V" : trimmed.substring(0, 1).toUpperCase(java.util.Locale.getDefault());
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
