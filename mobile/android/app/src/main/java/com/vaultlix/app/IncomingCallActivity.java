package com.vaultlix.app;

import android.app.Activity;
import android.app.NotificationManager;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.lang.ref.WeakReference;

public class IncomingCallActivity extends Activity {
    public static final String EXTRA_INVITE_URI = "inviteUri";
    public static final String EXTRA_CALLER = "caller";
    public static final String EXTRA_AUTO_ANSWER = "autoAnswer";
    public static final String EXTRA_CALL_ID = "callId";

    private String inviteUri;
    private int notificationId;
    private String callId;
    private boolean answerInProgress;
    private static WeakReference<IncomingCallActivity> activeActivity = new WeakReference<>(null);

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        activeActivity = new WeakReference<>(this);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().addFlags(
                WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
        );

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
        showIncomingCall(intent.getStringExtra(EXTRA_CALLER));
        if (intent.getBooleanExtra(EXTRA_AUTO_ANSWER, false)) answerCall();
    }

    private void showIncomingCall(String caller) {
        int padding = dp(28);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setPadding(padding, padding, padding, padding);
        root.setBackgroundColor(Color.rgb(39, 29, 37));

        TextView brand = text("Vaultlix", 18, Color.rgb(251, 247, 248));
        brand.setLetterSpacing(0.18f);
        root.addView(brand);

        TextView name = text(
                caller == null || caller.trim().isEmpty() ? "Incoming call" : caller.trim(),
                34,
                Color.WHITE
        );
        name.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        LinearLayout.LayoutParams nameParams = new LinearLayout.LayoutParams(-2, -2);
        nameParams.setMargins(0, dp(54), 0, dp(10));
        root.addView(name, nameParams);

        TextView subtitle = text("Incoming encrypted call", 15, Color.rgb(200, 117, 136));
        root.addView(subtitle);

        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        actions.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams actionsParams = new LinearLayout.LayoutParams(-1, -2);
        actionsParams.setMargins(0, dp(72), 0, 0);

        Button decline = actionButton("Decline", Color.rgb(184, 55, 78));
        decline.setOnClickListener(view -> declineCall());
        actions.addView(decline, new LinearLayout.LayoutParams(0, dp(58), 1));

        View gap = new View(this);
        actions.addView(gap, new LinearLayout.LayoutParams(dp(18), 1));

        Button answer = actionButton("Answer", Color.rgb(63, 151, 104));
        answer.setOnClickListener(view -> answerCall());
        actions.addView(answer, new LinearLayout.LayoutParams(0, dp(58), 1));

        root.addView(actions, actionsParams);
        setContentView(root);
    }

    private void answerCall() {
        if (answerInProgress) return;
        answerInProgress = true;
        NativeCallActions.markAnswerStarted(this, callId);
        cancelNotification();
        // Use one dedicated call-only host in every device state. Besides
        // keeping chat hidden above keyguard, this gives foreground and
        // background answers the same branded secure-connection transition.
        openLockedCall();
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

    private Button actionButton(String label, int color) {
        Button button = new Button(this);
        button.setText(label);
        button.setTextColor(Color.WHITE);
        button.setTextSize(17);
        button.setAllCaps(false);
        button.setBackgroundColor(color);
        return button;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
