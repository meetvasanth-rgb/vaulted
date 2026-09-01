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
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
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
        if (activeActivity.get() == this) activeActivity.clear();
        super.onDestroy();
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
        // duplicate heads-up notification so Android never shows two call UIs.
        cancelNotification();
        if (intent.getBooleanExtra(EXTRA_AUTO_ANSWER, false)) answerCall();
    }

    private void showIncomingCall(String caller) {
        String displayName = caller == null || caller.trim().isEmpty()
                ? getString(R.string.native_private_call) : caller.trim();
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        root.setPadding(dp(30), dp(30), dp(30), dp(30));
        root.setBackground(verticalGradient(INK_SOFT, INK));

        LinearLayout brandRow = new LinearLayout(this);
        brandRow.setGravity(Gravity.CENTER);
        ImageView brandLock = new ImageView(this);
        brandLock.setImageResource(R.drawable.ic_call_lock);
        brandLock.setImageTintList(ColorStateList.valueOf(ROSE));
        brandLock.setPadding(dp(7), dp(7), dp(7), dp(7));
        brandLock.setBackground(circle(Color.argb(42, 255, 255, 255)));
        brandRow.addView(brandLock, new LinearLayout.LayoutParams(dp(32), dp(32)));
        TextView brand = text("VAULTLIX", 13, IVORY);
        brand.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        brand.setLetterSpacing(0.24f);
        LinearLayout.LayoutParams brandParams = new LinearLayout.LayoutParams(-2, -2);
        brandParams.setMargins(dp(10), 0, 0, 0);
        brandRow.addView(brand, brandParams);
        root.addView(brandRow, new LinearLayout.LayoutParams(-1, dp(40)));

        root.addView(new Space(this), new LinearLayout.LayoutParams(1, 0, .75f));

        FrameLayout portrait = new FrameLayout(this);
        View halo = new View(this);
        halo.setBackground(circle(Color.argb(24, 255, 255, 255)));
        portrait.addView(halo, centered(dp(132), dp(132)));
        TextView avatar = text(initialFor(displayName), 42, BURGUNDY);
        avatar.setTypeface(Typeface.create("sans-serif", Typeface.NORMAL));
        avatar.setBackground(circle(IVORY));
        portrait.addView(avatar, centered(dp(104), dp(104)));
        root.addView(portrait, new LinearLayout.LayoutParams(dp(132), dp(132)));

        TextView name = text(displayName, 34, Color.WHITE);
        // Pin the identity to Android's sans-serif family so OEM-specific
        // serif substitutions cannot make the same build look different.
        name.setTypeface(Typeface.create("sans-serif", Typeface.NORMAL));
        name.setMaxLines(2);
        LinearLayout.LayoutParams nameParams = new LinearLayout.LayoutParams(-1, -2);
        nameParams.setMargins(0, dp(28), 0, dp(9));
        root.addView(name, nameParams);

        TextView subtitle = text(getString(R.string.native_incoming_encrypted_call), 17, ROSE);
        subtitle.setTypeface(Typeface.create("sans-serif", Typeface.NORMAL));
        root.addView(subtitle);

        LinearLayout privacy = new LinearLayout(this);
        privacy.setGravity(Gravity.CENTER);
        ImageView privacyLock = new ImageView(this);
        privacyLock.setImageResource(R.drawable.ic_call_lock);
        privacyLock.setImageTintList(ColorStateList.valueOf(Color.rgb(202, 190, 197)));
        privacy.addView(privacyLock, new LinearLayout.LayoutParams(dp(14), dp(14)));
        TextView privacyText = text(getString(R.string.native_private_identity_protected), 12, Color.rgb(202, 190, 197));
        LinearLayout.LayoutParams privacyTextParams = new LinearLayout.LayoutParams(-2, -2);
        privacyTextParams.setMargins(dp(7), 0, 0, 0);
        privacy.addView(privacyText, privacyTextParams);
        LinearLayout.LayoutParams privacyParams = new LinearLayout.LayoutParams(-2, dp(34));
        privacyParams.setMargins(0, dp(18), 0, 0);
        root.addView(privacy, privacyParams);

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
