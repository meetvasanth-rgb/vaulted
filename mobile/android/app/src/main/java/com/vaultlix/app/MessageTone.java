package com.vaultlix.app;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * The message tone the person chose in Settings, kept on this phone. The web layer
 * writes it through the JavaScript bridge, and {@link VaultlixMessagingService} reads
 * it first when it posts a message notification, so the lock-screen sound does not
 * depend on the server having remembered the choice (the push still carries one as a
 * fallback). Only known tone ids are stored.
 */
final class MessageTone {
    private static final String PREFS = "vaultlix_message_tone";
    private static final String KEY = "tone";

    private MessageTone() {}

    /** True for "chime", "none" and every bundled tone; false for anything else. */
    static boolean isKnown(String tone) {
        if (tone == null) return false;
        switch (tone) {
            case "chime": case "none": case "glow": case "bright": case "sweet": case "notify":
            case "soft": case "whistle": case "triplet": case "ripple": case "spark":
            case "lantern": case "harp": case "marimba": case "droplet":
                return true;
            default:
                return false;
        }
    }

    static void store(Context context, String tone) {
        if (context == null || !isKnown(tone)) return;
        SharedPreferences prefs = context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        prefs.edit().putString(KEY, tone).apply();
    }

    /** The stored tone, or null when the person has not chosen one on this phone yet. */
    static String stored(Context context) {
        if (context == null) return null;
        String tone = context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null);
        return isKnown(tone) ? tone : null;
    }
}
