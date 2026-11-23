package com.vaultlix.app;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONArray;
import org.json.JSONObject;

/** Short-lived E2E ciphertext staging, populated before the notification is displayed. */
final class NotificationMessageCache {
    private static final long TTL = 10 * 60 * 1000;
    private final SharedPreferences prefs;
    NotificationMessageCache(Context context) {
        prefs = context.getApplicationContext().getSharedPreferences("notification-ciphertext-v1", Context.MODE_PRIVATE);
    }
    synchronized void put(String conversation, String encoded) {
        try {
            if (conversation.isEmpty() || conversation.length() > 128 || encoded.length() > 1800) return;
            JSONObject envelope = new JSONObject(encoded);
            String id = envelope.optString("id");
            String cipher = envelope.optString("content", envelope.optString("ciphertext"));
            if (id.isEmpty() || id.length() > 128 || !(cipher.startsWith("v:") || cipher.startsWith("v2:") || cipher.startsWith("g1:"))) return;
            JSONObject record = new JSONObject().put("kind", "notification-envelope").put("id", id)
                .put("envelope", envelope).put("receivedAt", System.currentTimeMillis());
            SharedPreferences.Editor edit = prefs.edit();
            long cutoff = System.currentTimeMillis() - TTL;
            int count = 0;
            for (String key : prefs.getAll().keySet()) {
                try { if (new JSONObject(prefs.getString(key, "{}")).optLong("receivedAt") < cutoff || ++count > 200) edit.remove(key); }
                catch (Exception ignored) { edit.remove(key); }
            }
            edit.putString(conversation + "|" + id, record.toString()).commit();
        } catch (Exception ignored) {}
    }
    synchronized JSONArray recent(String conversation) {
        JSONArray result = new JSONArray();
        long cutoff = System.currentTimeMillis() - TTL;
        for (String key : prefs.getAll().keySet()) if (key.startsWith(conversation + "|")) {
            try {
                String value = prefs.getString(key, "{}");
                if (new JSONObject(value).optLong("receivedAt") >= cutoff) result.put(value);
            } catch (Exception ignored) {}
        }
        return result;
    }
    synchronized void remove(String conversation, String id) { prefs.edit().remove(conversation + "|" + id).commit(); }
    synchronized void clear(String conversation) {
        SharedPreferences.Editor edit = prefs.edit();
        for (String key : prefs.getAll().keySet()) if (key.startsWith(conversation + "|")) edit.remove(key);
        edit.commit();
    }
    synchronized void clearAll() { prefs.edit().clear().commit(); }
}
