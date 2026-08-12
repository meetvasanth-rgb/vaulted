package com.vaultlix.app;

import android.content.Context;
import android.content.SharedPreferences;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Sends native call actions that can occur before the WebView is available. */
final class NativeCallActions {
    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();
    private static final String DECLINE_URL = "https://vaultlix.com/api/native-call/decline";
    private static final String PREFS = "native_call_actions";
    private static final String LAST_DECLINED_CALL_ID = "last_declined_call_id";
    private static final String LAST_DECLINED_AT = "last_declined_at";
    private static final long DECLINE_TOMBSTONE_MS = 2 * 60 * 1000L;

    private NativeCallActions() {}

    static boolean wasRecentlyDeclined(Context context, String callId) {
        String normalizedCallId = normalize(callId);
        if (normalizedCallId.isEmpty()) return false;
        SharedPreferences preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        long age = System.currentTimeMillis() - preferences.getLong(LAST_DECLINED_AT, 0L);
        return normalizedCallId.equals(preferences.getString(LAST_DECLINED_CALL_ID, ""))
                && age >= 0L
                && age < DECLINE_TOMBSTONE_MS;
    }

    static void decline(Context context, String callId, Runnable completion) {
        String normalizedCallId = normalize(callId);
        if (normalizedCallId.isEmpty()) {
            if (completion != null) completion.run();
            return;
        }
        // The server intentionally schedules one FCM retry while a call is
        // ringing. It may already be queued when this decline reaches the
        // server, so remember the call ID locally before starting the request
        // and suppress only late deliveries for this exact call.
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString(LAST_DECLINED_CALL_ID, normalizedCallId)
                .putLong(LAST_DECLINED_AT, System.currentTimeMillis())
                .apply();
        EXECUTOR.execute(() -> {
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) new URL(DECLINE_URL).openConnection();
                connection.setRequestMethod("POST");
                connection.setConnectTimeout(5_000);
                connection.setReadTimeout(5_000);
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                connection.setRequestProperty("Accept", "application/json");
                String escapedCallId = normalizedCallId.replace("\\", "\\\\").replace("\"", "\\\"");
                byte[] body = ("{\"callId\":\"" + escapedCallId + "\"}").getBytes(StandardCharsets.UTF_8);
                connection.setFixedLengthStreamingMode(body.length);
                try (OutputStream output = connection.getOutputStream()) {
                    output.write(body);
                }
                // Completing the response ensures the server receives the
                // entire request before the receiver's process may suspend.
                connection.getResponseCode();
            } catch (Exception ignored) {
                // The notification must still dismiss offline. The server's
                // ring timeout remains the safe fallback if delivery fails.
            } finally {
                if (connection != null) connection.disconnect();
                if (completion != null) completion.run();
            }
        });
    }

    private static String normalize(String callId) {
        return callId == null ? "" : callId.trim();
    }
}
