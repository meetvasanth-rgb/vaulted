package com.vaultlix.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Device-bound encrypted storage for the minimum native-call credentials. */
final class NativeCallRoomStore {
    static final class Room {
        final String handle;
        final String code;
        final String token;
        final byte[] aesKey;

        Room(String handle, String code, String token, byte[] aesKey) {
            this.handle = handle;
            this.code = code;
            this.token = token;
            this.aesKey = aesKey;
        }
    }

    private static final String PREFS = "native_call_rooms_v1";
    private static final String KEY_ALIAS = "vaultlix_native_call_rooms_v1";
    private final SharedPreferences preferences;

    NativeCallRoomStore(Context context) {
        preferences = context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    boolean save(String handle, String code, String token, String keyBase64) {
        try {
            if (!handle.matches("^[A-Za-z0-9_-]{16,64}$") || code.length() > 128 || token.length() > 256) return false;
            byte[] key = Base64.decode(keyBase64, Base64.DEFAULT);
            if (key.length != 32) return false;
            JSONObject clear = new JSONObject()
                    .put("handle", handle).put("code", code).put("token", token)
                    .put("key", Base64.encodeToString(key, Base64.NO_WRAP));
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, storageKey());
            byte[] ciphertext = cipher.doFinal(clear.toString().getBytes(StandardCharsets.UTF_8));
            String value = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + "." +
                    Base64.encodeToString(ciphertext, Base64.NO_WRAP);
            preferences.edit().putString("h:" + handle, value).putString("c:" + code, handle).apply();
            return true;
        } catch (Exception ignored) { return false; }
    }

    Room byCode(String code) {
        return byHandle(preferences.getString("c:" + code, ""));
    }

    Room byHandle(String handle) {
        try {
            String value = preferences.getString("h:" + handle, "");
            String[] parts = value.split("\\.", 2);
            if (parts.length != 2) return null;
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, storageKey(), new GCMParameterSpec(128, Base64.decode(parts[0], Base64.DEFAULT)));
            JSONObject clear = new JSONObject(new String(cipher.doFinal(Base64.decode(parts[1], Base64.DEFAULT)), StandardCharsets.UTF_8));
            byte[] key = Base64.decode(clear.getString("key"), Base64.DEFAULT);
            if (key.length != 32) return null;
            return new Room(clear.getString("handle"), clear.getString("code"), clear.getString("token"), key);
        } catch (Exception ignored) { return null; }
    }

    void remove(String handle, String code) {
        preferences.edit().remove("h:" + handle).remove("c:" + code).apply();
    }

    void clear() {
        preferences.edit().clear().apply();
        try {
            KeyStore store = KeyStore.getInstance("AndroidKeyStore");
            store.load(null);
            if (store.containsAlias(KEY_ALIAS)) store.deleteEntry(KEY_ALIAS);
        } catch (Exception ignored) {}
    }

    private SecretKey storageKey() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(KEY_ALIAS)) return ((KeyStore.SecretKeyEntry) store.getEntry(KEY_ALIAS, null)).getSecretKey();
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build());
        return generator.generateKey();
    }
}
