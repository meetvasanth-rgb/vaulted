package com.vaultlix.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.ThumbnailUtils;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
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
        final String avatarPath;

        Room(String handle, String code, String token, byte[] aesKey, String avatarPath) {
            this.handle = handle;
            this.code = code;
            this.token = token;
            this.aesKey = aesKey;
            this.avatarPath = avatarPath;
        }
    }

    private static final String PREFS = "native_call_rooms_v1";
    private static final String KEY_ALIAS = "vaultlix_native_call_rooms_v1";
    private final SharedPreferences preferences;
    private final File avatarDirectory;

    NativeCallRoomStore(Context context) {
        Context app = context.getApplicationContext();
        preferences = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        avatarDirectory = new File(app.getFilesDir(), "native-call-avatars");
    }

    boolean save(String handle, String code, String token, String keyBase64) {
        return save(handle, code, token, keyBase64, null);
    }

    boolean save(String handle, String code, String token, String keyBase64, String profileImage) {
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
            if (profileImage != null) saveAvatar(handle, profileImage);
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
            File avatar = avatarFile(handle);
            return new Room(clear.getString("handle"), clear.getString("code"), clear.getString("token"), key,
                    avatar.isFile() ? avatar.getAbsolutePath() : null);
        } catch (Exception ignored) { return null; }
    }

    void remove(String handle, String code) {
        preferences.edit().remove("h:" + handle).remove("c:" + code).apply();
        File avatar = avatarFile(handle);
        if (avatar.isFile()) avatar.delete();
    }

    void clear() {
        preferences.edit().clear().apply();
        File[] avatars = avatarDirectory.listFiles();
        if (avatars != null) for (File avatar : avatars) avatar.delete();
        try {
            KeyStore store = KeyStore.getInstance("AndroidKeyStore");
            store.load(null);
            if (store.containsAlias(KEY_ALIAS)) store.deleteEntry(KEY_ALIAS);
        } catch (Exception ignored) {}
    }

    private File avatarFile(String handle) {
        return new File(avatarDirectory, handle + ".jpg");
    }

    private void saveAvatar(String handle, String dataUri) {
        File target = avatarFile(handle);
        if (dataUri == null || dataUri.isEmpty()) {
            if (target.isFile()) target.delete();
            return;
        }
        try {
            int comma = dataUri.indexOf(',');
            if (comma < 0 || !dataUri.substring(0, comma).startsWith("data:image/")) return;
            byte[] source = Base64.decode(dataUri.substring(comma + 1), Base64.DEFAULT);
            if (source.length == 0 || source.length > 512 * 1024) return;
            Bitmap decoded = BitmapFactory.decodeByteArray(source, 0, source.length);
            if (decoded == null) return;
            Bitmap square = ThumbnailUtils.extractThumbnail(decoded, 256, 256, ThumbnailUtils.OPTIONS_RECYCLE_INPUT);
            if (!avatarDirectory.exists() && !avatarDirectory.mkdirs()) {
                square.recycle();
                return;
            }
            try (FileOutputStream output = new FileOutputStream(target)) {
                square.compress(Bitmap.CompressFormat.JPEG, 90, output);
            }
            square.recycle();
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
