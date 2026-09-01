package com.vaultlix.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import net.zetetic.database.sqlcipher.SQLiteDatabase;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.SecureRandom;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * SQLCipher stores only per-message ciphertext. Every message has a distinct
 * Android Keystore AES key, so deleting that alias is the cryptographic erase
 * boundary even if an older encrypted database page is recovered later.
 */
final class SecureMessageStore {
    private static final String DB_NAME = "vaultlix-messages.db";
    private static final String PREFS = "vaultlix-secure-store";
    private static final String DB_WRAP_ALIAS = "vaultlix.db.wrap.v1";
    private static final String DB_KEY = "wrapped-db-key";
    private static final SecureRandom RANDOM = new SecureRandom();

    private final Context context;
    private SQLiteDatabase database;

    SecureMessageStore(Context context) { this.context = context.getApplicationContext(); }

    synchronized void open() throws Exception {
        if (database != null && database.isOpen()) return;
        System.loadLibrary("sqlcipher");
        byte[] passphrase = loadOrCreateDatabasePassphrase();
        File file = context.getDatabasePath(DB_NAME);
        File parent = file.getParentFile();
        if (parent != null) parent.mkdirs();
        database = SQLiteDatabase.openOrCreateDatabase(file, passphrase, null, null, null);
        java.util.Arrays.fill(passphrase, (byte) 0);
        database.rawExecSQL("PRAGMA cipher_memory_security = ON");
        database.rawExecSQL("PRAGMA secure_delete = ON");
        database.rawExecSQL("PRAGMA journal_mode = WAL");
        database.execSQL("CREATE TABLE IF NOT EXISTS messages (conversation_id TEXT NOT NULL, message_id TEXT NOT NULL, nonce BLOB NOT NULL, ciphertext BLOB NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(conversation_id,message_id))");
    }

    synchronized boolean put(String conversationId, String messageId, String plaintext, long createdAt) {
        if (!validId(conversationId, 128) || !validId(messageId, 128) || plaintext == null) return false;
        String alias = null;
        try {
            open();
            alias = messageAlias(conversationId, messageId);
            deleteAlias(alias);
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(alias,
                    KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setUserAuthenticationRequired(false)
                    .build());
            SecretKey key = generator.generateKey();
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key);
            byte[] ciphertext = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
            database.execSQL("INSERT OR REPLACE INTO messages(conversation_id,message_id,nonce,ciphertext,created_at) VALUES(?,?,?,?,?)",
                    new Object[]{conversationId, messageId, cipher.getIV(), ciphertext, createdAt});
            return true;
        } catch (Exception error) {
            if (alias != null) try { deleteAlias(alias); } catch (Exception ignored) {}
            return false;
        }
    }

    synchronized boolean delete(String conversationId, String messageId) {
        if (!validId(conversationId, 128) || !validId(messageId, 128)) return false;
        try {
            open();
            // Key destruction happens first. A crash after this point can
            // leave ciphertext, but cannot restore the deleted plaintext.
            deleteAlias(messageAlias(conversationId, messageId));
            database.execSQL("DELETE FROM messages WHERE conversation_id=? AND message_id=?", new Object[]{conversationId, messageId});
            checkpoint();
            return true;
        } catch (Exception error) {
            return false;
        }
    }

    synchronized boolean clearConversation(String conversationId) {
        if (!validId(conversationId, 128)) return false;
        try {
            open();
            try (android.database.Cursor cursor = database.rawQuery(
                    "SELECT message_id FROM messages WHERE conversation_id=?", new String[]{conversationId})) {
                while (cursor.moveToNext()) deleteAlias(messageAlias(conversationId, cursor.getString(0)));
            }
            database.execSQL("DELETE FROM messages WHERE conversation_id=?", new Object[]{conversationId});
            checkpoint();
            return true;
        } catch (Exception error) {
            return false;
        }
    }

    private void checkpoint() {
        database.rawExecSQL("PRAGMA wal_checkpoint(TRUNCATE)");
        database.rawExecSQL("PRAGMA incremental_vacuum");
    }

    private byte[] loadOrCreateDatabasePassphrase() throws Exception {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String saved = prefs.getString(DB_KEY, null);
        SecretKey wrappingKey = loadOrCreateAesKey(DB_WRAP_ALIAS);
        if (saved != null) {
            byte[] packed = Base64.decode(saved, Base64.NO_WRAP);
            byte[] nonce = java.util.Arrays.copyOfRange(packed, 0, 12);
            byte[] ciphertext = java.util.Arrays.copyOfRange(packed, 12, packed.length);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, wrappingKey, new GCMParameterSpec(128, nonce));
            return cipher.doFinal(ciphertext);
        }
        byte[] passphrase = new byte[32];
        RANDOM.nextBytes(passphrase);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, wrappingKey);
        byte[] ciphertext = cipher.doFinal(passphrase);
        byte[] packed = new byte[cipher.getIV().length + ciphertext.length];
        System.arraycopy(cipher.getIV(), 0, packed, 0, cipher.getIV().length);
        System.arraycopy(ciphertext, 0, packed, cipher.getIV().length, ciphertext.length);
        prefs.edit().putString(DB_KEY, Base64.encodeToString(packed, Base64.NO_WRAP)).apply();
        return passphrase;
    }

    private SecretKey loadOrCreateAesKey(String alias) throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(alias)) return (SecretKey) store.getKey(alias, null);
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(alias,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setUserAuthenticationRequired(false)
                .build());
        return generator.generateKey();
    }

    private String messageAlias(String conversationId, String messageId) throws Exception {
        java.security.MessageDigest digest = java.security.MessageDigest.getInstance("SHA-256");
        byte[] hash = digest.digest((conversationId + "\u0000" + messageId).getBytes(StandardCharsets.UTF_8));
        return "vaultlix.msg." + Base64.encodeToString(hash, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    }

    private void deleteAlias(String alias) throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(alias)) store.deleteEntry(alias);
    }

    private boolean validId(String value, int max) {
        return value != null && !value.isEmpty() && value.length() <= max;
    }
}
