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

import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Map;

public class VaultlixMessagingService extends MessagingService {
    public static final String CALL_CHANNEL_PREFIX = "vaultlix_calls_";
    private static final String MESSAGE_CHANNEL_ID = "vaultlix_messages_universal_v2";
    public static final String EXTRA_CALL_NOTIFICATION_ID = "callNotificationId";

    @Override
    public void onMessageReceived(@NonNull RemoteMessage remoteMessage) {
        Map<String, String> data = remoteMessage.getData();
        if ("true".equalsIgnoreCase(data.get("isCallEnd"))) {
            NativeWebRtcCallEngine engine = NativeWebRtcCallEngine.get(this);
            String callOutcome = safe(data.get("callOutcome"));
            // Trust the server's own missedCall flag alone — it is computed
            // from wasStillRinging (server/index.js: isMissedCall =
            // wasStillRinging && callOutcome === 'unanswered'), which is the
            // only place that actually knows whether the call was accepted.
            // callOutcome alone is NOT a safe secondary signal: a caller-side
            // 30s ring timeout can still send terminalReason:'unanswered'
            // even after the callee genuinely answered (e.g. if the answer
            // signal was delayed reaching the caller), which previously made
            // this OR mislabel a normally-completed call as missed and show
            // a spurious "call completed"/"Missed call" notification for it.
            boolean missedCall = "true".equalsIgnoreCase(data.get("missedCall"));
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
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) ensureMessageChannel(manager);
        // A regular chat message (server/index.js sends it data-only,
        // identified by carrying a msgId, for exactly this reason — see the
        // comment there). Building the notification here ourselves, instead
        // of relying on an auto-displayed FCM "notification" payload, is what
        // actually lets this code run reliably while the app is backgrounded
        // or the device is locked — which is also what makes the
        // mark-delivered report below possible in that state at all.
        String msgId = safe(data.get("msgId"));
        if (!msgId.isEmpty()) {
            showMessageNotification(data);
            reportMessageDelivered(safe(data.get("code")), msgId);
            return;
        }
        // Private-group messages carry a groupId instead of a msgId/code
        // (see server/index.js) — same underlying reliability reason as
        // above: server/index.js now sends these data-only too, so this is
        // the only place a notification (and its ?group= deep link) gets
        // built for them. No mark-delivered report here — group delivery
        // receipts aren't tracked per-message the way 1:1 messages are.
        String groupId = safe(data.get("groupId"));
        if (!groupId.isEmpty()) {
            showGroupMessageNotification(data);
            return;
        }
        super.onMessageReceived(remoteMessage);
    }

    private void ensureMessageChannel(NotificationManager manager) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(
                MESSAGE_CHANNEL_ID,
                "Messages and missed calls",
                NotificationManager.IMPORTANCE_HIGH
        );
        channel.enableVibration(true);
        Uri sound = Uri.parse("android.resource://" + getPackageName() + "/" + R.raw.vault_chime);
        channel.setSound(sound, new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build());
        channel.setLockscreenVisibility(NotificationCompat.VISIBILITY_PUBLIC);
        manager.createNotificationChannel(channel);
    }

    // The tone saved on this phone (see MessageTone) wins; the one the server put in
    // the push is only the fallback for a phone that has not saved one yet.
    private String chosenTone(Map<String, String> data) {
        String local = MessageTone.stored(this);
        return local != null ? local : data.get("tone");
    }

    private static final String TONE_CHANNEL_PREFIX = "vaultlix_messages_tone_";
    // Matches DEFAULT_MESSAGE_TONE in server/index.js: used when no choice is sent.
    private static final String DEFAULT_TONE = "glow";

    // Ids the server may name (server/index.js MESSAGE_TONE_IDS). Anything else
    // falls back to the default tone. "chime" is the original channel.
    private static String normalizeTone(String tone) {
        if (tone == null) return DEFAULT_TONE;
        switch (tone) {
            case "chime": case "none": case "glow": case "bright": case "sweet": case "notify": case "soft":
            case "whistle": case "triplet": case "ripple": case "spark": case "lantern":
            case "harp": case "marimba": case "droplet":
                return tone;
            default:
                return DEFAULT_TONE;
        }
    }

    private static String toneLabel(String tone) {
        if ("none".equals(tone)) return "Silent";
        return Character.toUpperCase(tone.charAt(0)) + tone.substring(1);
    }

    // An Android notification channel fixes its sound when it is created, so each
    // tone gets its own channel and a message uses the channel of the tone the
    // person chose. The original chime keeps its existing channel untouched.
    private String ensureMessageChannel(NotificationManager manager, String requestedTone) {
        String tone = normalizeTone(requestedTone);
        if ("chime".equals(tone)) {
            ensureMessageChannel(manager);
            return MESSAGE_CHANNEL_ID;
        }
        String channelId = TONE_CHANNEL_PREFIX + tone;
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return MESSAGE_CHANNEL_ID;
        if (manager.getNotificationChannel(channelId) != null) return channelId;
        NotificationChannel channel = new NotificationChannel(
                channelId,
                "Messages · " + toneLabel(tone),
                NotificationManager.IMPORTANCE_HIGH
        );
        channel.enableVibration(true);
        int resource = "none".equals(tone) ? 0
                : getResources().getIdentifier("vault_tone_" + tone, "raw", getPackageName());
        if (resource == 0) {
            channel.setSound(null, null);
        } else {
            channel.setSound(Uri.parse("android.resource://" + getPackageName() + "/" + resource),
                    new AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                            .build());
        }
        channel.setLockscreenVisibility(NotificationCompat.VISIBILITY_PUBLIC);
        manager.createNotificationChannel(channel);
        return channelId;
    }

    // Stands in for the FCM SDK's own auto-displayed notification, now that
    // regular messages arrive data-only (see onMessageReceived above). One
    // stable ID per room (not per message) so a burst of messages from the
    // same conversation updates a single tray entry instead of stacking.
    private void showMessageNotification(Map<String, String> data) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;
        String channelId = ensureMessageChannel(manager, chosenTone(data));

        String code = safe(data.get("code"));
        String title = safe(data.get("title"));
        String body = safe(data.get("body"));
        Uri conversationUri = Uri.parse("https://vaultlix.com/").buildUpon()
                .appendQueryParameter("room", code)
                .build();
        int notificationId = ("message:" + code).hashCode();
        Intent openConversation = new Intent(Intent.ACTION_VIEW, conversationUri, this, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent contentIntent = PendingIntent.getActivity(
                this,
                notificationId,
                openConversation,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        manager.notify(notificationId, new NotificationCompat.Builder(this, channelId)
                .setSmallIcon(R.drawable.ic_stat_vaultlix)
                .setColor(Color.rgb(104, 44, 67))
                .setContentTitle(title.isEmpty() ? "Vaultlix" : title)
                .setContentText(body.isEmpty() ? "New message" : body)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setAutoCancel(true)
                .setContentIntent(contentIntent)
                .build());
    }

    // Group-message equivalent of showMessageNotification above — same
    // shape, but deep-links to ?group=<groupId> (read by client/index.html's
    // startup ?group= handling, the same param sw.js's web-push path already
    // uses) instead of ?room=<code>, and uses its own "group:"-prefixed
    // notification-id namespace so it can never collide with or be silently
    // replaced by a room notification.
    private void showGroupMessageNotification(Map<String, String> data) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;
        String channelId = ensureMessageChannel(manager, chosenTone(data));

        String groupId = safe(data.get("groupId"));
        String title = safe(data.get("title"));
        String body = safe(data.get("body"));
        Uri conversationUri = Uri.parse("https://vaultlix.com/").buildUpon()
                .appendQueryParameter("group", groupId)
                .build();
        int notificationId = ("group:" + groupId).hashCode();
        Intent openConversation = new Intent(Intent.ACTION_VIEW, conversationUri, this, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent contentIntent = PendingIntent.getActivity(
                this,
                notificationId,
                openConversation,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        manager.notify(notificationId, new NotificationCompat.Builder(this, channelId)
                .setSmallIcon(R.drawable.ic_stat_vaultlix)
                .setColor(Color.rgb(104, 44, 67))
                .setContentTitle(title.isEmpty() ? "Vaultlix" : title)
                .setContentText(body.isEmpty() ? "New message" : body)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setAutoCancel(true)
                .setContentIntent(contentIntent)
                .build());
    }

    // The whole reason onMessageReceived now runs reliably while locked/
    // backgrounded (see above) — this is the actual fix for the sender's
    // tick staying on "sent" until the recipient opens the app. The room
    // token comes from NativeCallRoomStore, not the WebView's own storage:
    // that store is populated for every room the moment its E2E key is
    // derived (see provisionAndroidCallRoom in client/index.html), not only
    // rooms that have been called through, and — unlike IndexedDB inside the
    // WebView — it's readable from here even when the WebView isn't loaded
    // at all. Best-effort and silent on any failure: the page's own poll
    // loop (or a Web Push subscription's sw.js handler) remains the fallback
    // the instant the app is actually opened.
    private void reportMessageDelivered(String code, String msgId) {
        if (code.isEmpty() || msgId.isEmpty()) return;
        NativeCallRoomStore.Room room = new NativeCallRoomStore(this).byCode(code);
        if (room == null || room.token == null || room.token.isEmpty()) return;
        HttpURLConnection connection = null;
        try {
            JSONObject body = new JSONObject().put("code", code).put("token", room.token).put("msgId", msgId);
            connection = (HttpURLConnection) new URL("https://vaultlix.com/api/mark-delivered").openConnection();
            connection.setRequestMethod("POST");
            connection.setRequestProperty("Content-Type", "application/json");
            // FirebaseMessagingService.onMessageReceived() runs under a
            // system-granted time budget (roughly 10s) before the process
            // risks being killed — keep this well inside it even in the
            // worst case where both connect and read each stall out.
            connection.setConnectTimeout(3000);
            connection.setReadTimeout(3000);
            connection.setDoOutput(true);
            try (OutputStream out = connection.getOutputStream()) {
                out.write(body.toString().getBytes(StandardCharsets.UTF_8));
            }
            connection.getResponseCode(); // drain the response so the request actually completes
        } catch (Exception ignored) {
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private void showMissedCall(Map<String, String> data) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;
        ensureMessageChannel(manager);

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

        String notificationCaller = isVideoCall ? "VIDEO CALL · " + caller : caller;
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
