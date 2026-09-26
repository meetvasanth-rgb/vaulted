package com.vaultlix.app;

import android.content.Context;
import android.content.SharedPreferences;

import com.android.installreferrer.api.InstallReferrerClient;
import com.android.installreferrer.api.InstallReferrerStateListener;
import com.android.installreferrer.api.ReferrerDetails;

import java.net.URLDecoder;
import java.util.regex.Pattern;

/**
 * An invitation that survives the Play Store install.
 *
 * A friend's QR opens vaultlix.com/p-CODE. Where the app is not installed, the
 * page sends Android to Google Play with referrer=vaultlix_invite%3DCODE. On the
 * first launch the Play Install Referrer API hands that value back, and the web
 * app shows "X invited you to extend a private line" - the person still chooses
 * to connect; nothing is sent on their behalf.
 *
 * Only the six-character public profile code is carried, and only when it is
 * well formed and recent. The lookup happens once per install: an answer (even
 * "nothing") is remembered, while a Play outage is retried on the next launch.
 */
final class InstallInvite {
    static final String PARAM = "vaultlix_invite";
    /** An install older than this is not a fresh invitation (for example an app update). */
    static final long MAX_AGE_SECONDS = 7L * 24 * 60 * 60;

    private static final Pattern CODE = Pattern.compile("^[A-HJ-NP-Z2-9]{6}$");
    private static final String PREFS = "vaultlix_install_invite";
    private static final String KEY_CHECKED = "checked";
    private static final String KEY_CODE = "code";

    private InstallInvite() {}

    /** The invite code inside a referrer string, or null. Pure, so it is unit tested. */
    static String parseCode(String referrer) {
        if (referrer == null || referrer.length() > 2048) return null;
        String value = referrer;
        for (int pass = 0; pass < 2; pass++) {
            String found = scan(value);
            if (found != null) return found;
            try { value = URLDecoder.decode(value, "UTF-8"); } catch (Exception ignored) { return null; }
        }
        return null;
    }

    private static String scan(String query) {
        for (String pair : query.split("&")) {
            int equals = pair.indexOf('=');
            if (equals <= 0) continue;
            if (!PARAM.equals(pair.substring(0, equals))) continue;
            String code = pair.substring(equals + 1).trim().toUpperCase(java.util.Locale.ROOT);
            if (CODE.matcher(code).matches()) return code;
        }
        return null;
    }

    /** True when an install that began at installBeganSeconds is recent enough to be an invitation. */
    static boolean isFresh(long installBeganSeconds, long nowSeconds) {
        if (installBeganSeconds <= 0) return true; // the timestamp is informational; do not discard on its absence
        long age = nowSeconds - installBeganSeconds;
        return age >= -3600 && age <= MAX_AGE_SECONDS;
    }

    static void checkOnce(Context context) {
        final SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (prefs.getBoolean(KEY_CHECKED, false)) return;
        final InstallReferrerClient client;
        try {
            client = InstallReferrerClient.newBuilder(context).build();
            client.startConnection(new InstallReferrerStateListener() {
                @Override public void onInstallReferrerSetupFinished(int responseCode) {
                    try {
                        if (responseCode == InstallReferrerClient.InstallReferrerResponse.OK) {
                            ReferrerDetails details = client.getInstallReferrer();
                            String code = isFresh(details.getInstallBeginTimestampSeconds(), System.currentTimeMillis() / 1000)
                                    ? parseCode(details.getInstallReferrer()) : null;
                            prefs.edit().putBoolean(KEY_CHECKED, true).putString(KEY_CODE, code == null ? "" : code).apply();
                        } else if (responseCode != InstallReferrerClient.InstallReferrerResponse.SERVICE_UNAVAILABLE) {
                            // Not supported on this device: there will never be an answer.
                            prefs.edit().putBoolean(KEY_CHECKED, true).putString(KEY_CODE, "").apply();
                        }
                    } catch (Exception ignored) {
                        // Leave it unchecked; the next launch tries again.
                    } finally {
                        try { client.endConnection(); } catch (Exception ignored) {}
                    }
                }
                @Override public void onInstallReferrerServiceDisconnected() {}
            });
        } catch (Exception ignored) {
            // No Play Store: no invitation.
            prefs.edit().putBoolean(KEY_CHECKED, true).putString(KEY_CODE, "").apply();
        }
    }

    static String pendingCode(Context context) {
        String code = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_CODE, "");
        return code != null && CODE.matcher(code).matches() ? code : "";
    }

    static boolean checked(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_CHECKED, false);
    }

    static void clear(Context context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_CODE, "").apply();
    }
}
