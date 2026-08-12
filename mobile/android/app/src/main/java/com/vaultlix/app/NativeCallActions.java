package com.vaultlix.app;

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

    private NativeCallActions() {}

    static void decline(String callId, Runnable completion) {
        if (callId == null || callId.trim().isEmpty()) {
            if (completion != null) completion.run();
            return;
        }
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
                String escapedCallId = callId.trim().replace("\\", "\\\\").replace("\"", "\\\"");
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
}
