package com.vaultlix.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.os.Build;
import android.os.PowerManager;
import android.service.notification.StatusBarNotification;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.Person;
import androidx.core.graphics.drawable.IconCompat;

import com.capacitorjs.plugins.pushnotifications.MessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

public class VaultlixMessagingService extends MessagingService {
    public static final String CALL_CHANNEL_PREFIX = "vaultlix_calls_";
    private static final String MESSAGE_CHANNEL_ID = "vaultlix_messages_system";
    public static final String EXTRA_CALL_NOTIFICATION_ID = "callNotificationId";

    @Override
    public void onMessageReceived(@NonNull RemoteMessage remoteMessage) {
        Map<String, String> data = remoteMessage.getData();
        if ("true".equalsIgnoreCase(data.get("isCallEnd"))) {
            NativeWebRtcCallEngine engine = NativeWebRtcCallEngine.get(this);
            String callOutcome = safe(data.get("callOutcome"));
            boolean missedCall = "true".equalsIgnoreCase(data.get("missedCall"))
                    || "unanswered".equals(callOutcome);
            if (missedCall ||
                    "cancelled".equals(callOutcome) || "declined".equals(callOutcome)) {
                // The WebView is commonly frozen or not yet restored when a
                // lock-screen ring expires. Persist the conversation-history
                // marker before closing native UI; MainActivity consumes it
                // only after its window and encrypted room list are usable.
                NativeCallActions.markPendingWebViewCallEnd(
                        this, safe(data.get("code")),
                        "cancelled".equals(callOutcome) ? "Caller cancelled" :
                                ("declined".equals(callOutcome) ? "Call declined" : "Missed call")
                );
            }
            // The engine may have already timed itself out before this FCM
            // terminal event arrives. That must not suppress the missed-call
            // alert; ownership only controls whether it is safe to end media.
            if (missedCall) showMissedCall(data);
            if (engine.shouldHandleRemoteEnd(safe(data.get("code")))) {
                engine.end(false, callOutcome);
                clearActiveCallNotifications(this);
                IncomingCallActivity.finishActiveCall();
                LockedCallActivity.finishActiveCall();
            }
            return;
        }
        if ("true".equalsIgnoreCase(data.get("isCall"))) {
            showIncomingCall(data);
            return;
        }
        super.onMessageReceived(remoteMessage);
    }

    private void showMissedCall(Map<String, String> data) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    MESSAGE_CHANNEL_ID,
                    "Messages and missed calls",
                    NotificationManager.IMPORTANCE_HIGH
            );
            channel.enableVibration(true);
            channel.setSound(
                    RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION),
                    new AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                            .build()
            );
            channel.setLockscreenVisibility(NotificationCompat.VISIBILITY_PUBLIC);
            manager.createNotificationChannel(channel);
        }

        String code = safe(data.get("code"));
        String callId = safe(data.get("callId"));
        String caller = safe(data.get("caller"));
        Uri conversationUri = Uri.parse("https://vaultlix.com/").buildUpon()
                .appendQueryParameter("room", code)
                .build();
        int notificationId = ("missed:" + (callId.isEmpty() ? code : callId)).hashCode();
        Intent openConversation = new Intent(Intent.ACTION_VIEW, conversationUri, this, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra(EXTRA_CALL_NOTIFICATION_ID, notificationId);
        PendingIntent contentIntent = PendingIntent.getActivity(
                this,
                notificationId,
                openConversation,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        manager.notify(notificationId, new NotificationCompat.Builder(this, MESSAGE_CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_vaultlix)
                .setColor(Color.rgb(104, 44, 67))
                .setContentTitle("Vaultlix")
                .setContentText(caller.isEmpty() ? "Missed call" : "Missed call from " + caller)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setAutoCancel(true)
                .setContentIntent(contentIntent)
                .build());
    }

    private void showIncomingCall(Map<String, String> data) {
        String code = safe(data.get("code"));
        String callId = safe(data.get("callId"));
        if (NativeCallActions.wasRecentlyDeclined(this, callId)
                || NativeCallActions.wasRecentlyAnswered(this, callId)) return;
        NativeWebRtcCallEngine engine = NativeWebRtcCallEngine.get(this);
        if (engine.isBusyWithAnotherRoom(code)) {
            NativeCallActions.declineWhileBusy(this, callId);
            return;
        }
        String caller = safe(data.get("caller"));
        String body = safe(data.get("body"));
        boolean isVideoCall = "true".equalsIgnoreCase(data.get("hasVideo"))
                || body.toLowerCase(java.util.Locale.ROOT).contains("video call");
        if (caller.isEmpty() && body.toLowerCase().endsWith(" is calling")) {
            caller = body.substring(0, body.length() - " is calling".length()).trim();
        }
        if (caller.isEmpty()) caller = getString(R.string.vaultlix_caller);
        if (body.isEmpty()) body = getString(R.string.tap_to_answer);
        NativeCallRoomStore.Room savedRoom = new NativeCallRoomStore(this).byCode(code);
        String avatarPath = savedRoom == null ? null : savedRoom.avatarPath;
        Bitmap callerAvatar = avatarPath == null ? null : BitmapFactory.decodeFile(avatarPath);
        // Keep one native media owner from ringing through hang-up. Handing a
        // foreground answer to WebView WebRTC while Android still owns the
        // communication audio route can connect silently on phone and speaker.
        boolean nativePrepared = engine.prepareIncoming(code);

        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;

        String callChannelId = CALL_CHANNEL_PREFIX + "system";
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    callChannelId,
                    getString(R.string.calls_channel),
                    NotificationManager.IMPORTANCE_HIGH
            );
            channel.setDescription(getString(R.string.calls_channel_description));
            channel.enableVibration(true);
            Uri sound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
            AudioAttributes attributes = new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build();
            channel.setSound(sound, attributes);
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
        Intent displayIntent = incomingCallIntent(inviteUri, caller, callId, requestCode, false, nativePrepared, avatarPath, isVideoCall);

        PendingIntent displayCall = PendingIntent.getActivity(
                this,
                requestCode,
                displayIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Intent answerIntent = incomingCallIntent(inviteUri, caller, callId, requestCode, true, nativePrepared, avatarPath, isVideoCall);
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

        String notificationCaller = isVideoCall ? caller + " · Video call" : caller;
        Person.Builder callerBuilder = new Person.Builder().setName(notificationCaller).setImportant(true);
        if (callerAvatar != null) callerBuilder.setIcon(IconCompat.createWithBitmap(callerAvatar));
        Person callerPerson = callerBuilder.build();

        NotificationCompat.Builder notification = new NotificationCompat.Builder(this, callChannelId)
                .setSmallIcon(R.drawable.ic_stat_vaultlix)
                .setColor(Color.rgb(104, 44, 67))
                .setContentTitle(isVideoCall ? "Incoming video call" : caller)
                .setContentText(isVideoCall ? "Video call · Tap to answer" : body)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setStyle(NotificationCompat.CallStyle.forIncomingCall(callerPerson, declineCall, answerCall))
                .setAutoCancel(true)
                .setOngoing(true)
                .setTimeoutAfter(60_000)
                .setContentIntent(displayCall)
                .setFullScreenIntent(displayCall, true);
        if (callerAvatar != null) notification.setLargeIcon(callerAvatar);

        wakeDisplayForIncomingCall();
        manager.notify(requestCode, notification.build());
    }

    private Intent incomingCallIntent(Uri inviteUri, String caller, String callId, int notificationId, boolean autoAnswer, boolean nativePrepared, String avatarPath, boolean isVideoCall) {
        Intent intent = new Intent(this, IncomingCallActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        intent.putExtra(IncomingCallActivity.EXTRA_INVITE_URI, inviteUri.toString());
        intent.putExtra(IncomingCallActivity.EXTRA_CALLER, caller);
        intent.putExtra(IncomingCallActivity.EXTRA_CALL_ID, callId);
        intent.putExtra(IncomingCallActivity.EXTRA_AUTO_ANSWER, autoAnswer);
        intent.putExtra(IncomingCallActivity.EXTRA_NATIVE_PREPARED, nativePrepared);
        intent.putExtra(IncomingCallActivity.EXTRA_VIDEO_CALL, isVideoCall);
        if (avatarPath != null) intent.putExtra(IncomingCallActivity.EXTRA_CALLER_AVATAR_PATH, avatarPath);
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
