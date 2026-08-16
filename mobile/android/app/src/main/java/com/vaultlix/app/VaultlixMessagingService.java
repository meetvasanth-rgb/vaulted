package com.vaultlix.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.media.AudioAttributes;
import android.os.Build;
import android.os.PowerManager;
import android.service.notification.StatusBarNotification;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.Person;

import com.capacitorjs.plugins.pushnotifications.MessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

public class VaultlixMessagingService extends MessagingService {
    public static final String CALL_CHANNEL_PREFIX = "vaultlix_calls_";
    public static final String EXTRA_CALL_NOTIFICATION_ID = "callNotificationId";

    @Override
    public void onMessageReceived(@NonNull RemoteMessage remoteMessage) {
        Map<String, String> data = remoteMessage.getData();
        if ("true".equalsIgnoreCase(data.get("isCallEnd"))) {
            clearActiveCallNotifications(this);
            IncomingCallActivity.finishActiveCall();
            LockedCallActivity.finishActiveCall();
            return;
        }
        if ("true".equalsIgnoreCase(data.get("isCall"))) {
            showIncomingCall(data);
            return;
        }
        super.onMessageReceived(remoteMessage);
    }

    private void showIncomingCall(Map<String, String> data) {
        String code = safe(data.get("code"));
        String callId = safe(data.get("callId"));
        if (NativeCallActions.wasRecentlyDeclined(this, callId)
                || NativeCallActions.wasRecentlyAnswered(this, callId)) return;
        String caller = safe(data.get("caller"));
        String body = safe(data.get("body"));
        if (caller.isEmpty() && body.toLowerCase().endsWith(" is calling")) {
            caller = body.substring(0, body.length() - " is calling".length()).trim();
        }
        if (caller.isEmpty()) caller = "Vaultlix caller";
        if (body.isEmpty()) body = "Tap to answer";

        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;

        String callTone = getSharedPreferences("vaultlix_sounds", MODE_PRIVATE)
                .getString("callTone", "vaultlix");
        if (!("classic".equals(callTone) || "minimal".equals(callTone))) callTone = "vaultlix";
        String callChannelId = CALL_CHANNEL_PREFIX + callTone;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    callChannelId,
                    "Calls",
                    NotificationManager.IMPORTANCE_HIGH
            );
            channel.setDescription("Incoming encrypted call alerts");
            channel.enableVibration(true);
            int soundId = getResources().getIdentifier("vault_call_" + callTone, "raw", getPackageName());
            if (soundId != 0) {
                Uri sound = Uri.parse("android.resource://" + getPackageName() + "/" + soundId);
                AudioAttributes attributes = new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build();
                channel.setSound(sound, attributes);
            }
            channel.setLockscreenVisibility(NotificationCompat.VISIBILITY_PUBLIC);
            manager.createNotificationChannel(channel);
        }

        // A call notification targets an existing local vault, not the public
        // join flow. Carry the one native answer decision through page restore
        // so the WebRTC state machine consumes it exactly once.
        Uri inviteUri = Uri.parse("https://vaultlix.com/").buildUpon()
                .appendQueryParameter("room", code)
                .appendQueryParameter("nativeCallAction", "answer")
                .build();
        int requestCode = code.hashCode();
        Intent displayIntent = incomingCallIntent(inviteUri, caller, callId, requestCode, false);

        PendingIntent displayCall = PendingIntent.getActivity(
                this,
                requestCode,
                displayIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Intent answerIntent = incomingCallIntent(inviteUri, caller, callId, requestCode, true);
        PendingIntent answerCall = PendingIntent.getActivity(
                this,
                requestCode + 1,
                answerIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Intent declineIntent = new Intent(this, CallActionReceiver.class)
                .setAction(CallActionReceiver.ACTION_DECLINE)
                .putExtra(CallActionReceiver.EXTRA_NOTIFICATION_ID, requestCode)
                .putExtra(CallActionReceiver.EXTRA_CALL_ID, callId);
        PendingIntent declineCall = PendingIntent.getBroadcast(
                this,
                requestCode,
                declineIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Person callerPerson = new Person.Builder()
                .setName(caller)
                .setImportant(true)
                .build();

        NotificationCompat.Builder notification = new NotificationCompat.Builder(this, callChannelId)
                .setSmallIcon(R.drawable.ic_stat_vaultlix)
                .setColor(Color.rgb(104, 44, 67))
                .setContentTitle(caller)
                .setContentText(body)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setStyle(NotificationCompat.CallStyle.forIncomingCall(callerPerson, declineCall, answerCall))
                .setAutoCancel(true)
                .setOngoing(true)
                .setTimeoutAfter(60_000)
                .setContentIntent(displayCall)
                .setFullScreenIntent(displayCall, true);

        wakeDisplayForIncomingCall();
        manager.notify(requestCode, notification.build());
    }

    private Intent incomingCallIntent(Uri inviteUri, String caller, String callId, int notificationId, boolean autoAnswer) {
        Intent intent = new Intent(this, IncomingCallActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        intent.putExtra(IncomingCallActivity.EXTRA_INVITE_URI, inviteUri.toString());
        intent.putExtra(IncomingCallActivity.EXTRA_CALLER, caller);
        intent.putExtra(IncomingCallActivity.EXTRA_CALL_ID, callId);
        intent.putExtra(IncomingCallActivity.EXTRA_AUTO_ANSWER, autoAnswer);
        intent.putExtra(EXTRA_CALL_NOTIFICATION_ID, notificationId);
        return intent;
    }

    @SuppressWarnings("deprecation")
    private void wakeDisplayForIncomingCall() {
        PowerManager powerManager = getSystemService(PowerManager.class);
        if (powerManager == null || powerManager.isInteractive()) return;
        PowerManager.WakeLock wakeLock = powerManager.newWakeLock(
                PowerManager.SCREEN_BRIGHT_WAKE_LOCK
                        | PowerManager.ACQUIRE_CAUSES_WAKEUP
                        | PowerManager.ON_AFTER_RELEASE,
                "Vaultlix:IncomingCall"
        );
        wakeLock.acquire(10_000);
    }

    private static String safe(String value) {
        return value == null ? "" : value.trim();
    }

    public static void clearActiveCallNotifications(android.content.Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return;
        for (StatusBarNotification active : manager.getActiveNotifications()) {
            String channelId = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                    ? active.getNotification().getChannelId()
                    : null;
            if (channelId != null && channelId.startsWith(CALL_CHANNEL_PREFIX)) manager.cancel(active.getId());
        }
    }
}
