import Foundation
import CryptoKit
import Security
import SQLCipher

/// SQLCipher contains only ciphertext. The distinct key for each message is
/// stored as a ThisDeviceOnly Keychain item and is destroyed before its row.
final class SecureMessageStore {
    static let shared = SecureMessageStore()
    private let queue = DispatchQueue(label: "com.vaultlix.secure-message-store")
    private var database: OpaquePointer?

    private init() {}

    func put(conversationID: String, messageID: String, plaintext: String, createdAt: Int64) -> Bool {
        queue.sync {
            guard valid(conversationID), valid(messageID), open() else { return false }
            let account = messageKeyAccount(conversationID, messageID)
            deleteKey(account: account)
            let key = SymmetricKey(size: .bits256)
            let keyData = key.withUnsafeBytes { Data($0) }
            guard saveKey(keyData, account: account),
                  let sealed = try? AES.GCM.seal(Data(plaintext.utf8), using: key),
                  let nonce = sealed.nonce.withUnsafeBytes({ Data($0) }) as Data? else {
                deleteKey(account: account)
                return false
            }
            let sql = "INSERT OR REPLACE INTO messages(conversation_id,message_id,nonce,ciphertext,tag,created_at) VALUES(?,?,?,?,?,?)"
            var statement: OpaquePointer?
            guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK else { return false }
            defer { sqlite3_finalize(statement) }
            bind(conversationID, to: statement, at: 1)
            bind(messageID, to: statement, at: 2)
            bind(nonce, to: statement, at: 3)
            bind(sealed.ciphertext, to: statement, at: 4)
            bind(sealed.tag, to: statement, at: 5)
            sqlite3_bind_int64(statement, 6, createdAt)
            if sqlite3_step(statement) != SQLITE_DONE { deleteKey(account: account); return false }
            return true
        }
    }

    func delete(conversationID: String, messageID: String) -> Bool {
        queue.sync {
            guard valid(conversationID), valid(messageID), open() else { return false }
            deleteKey(account: messageKeyAccount(conversationID, messageID))
            return execute("DELETE FROM messages WHERE conversation_id=? AND message_id=?", [conversationID, messageID]) && checkpoint()
        }
    }

    func clear(conversationID: String) -> Bool {
        queue.sync {
            guard valid(conversationID), open() else { return false }
            var statement: OpaquePointer?
            guard sqlite3_prepare_v2(database, "SELECT message_id FROM messages WHERE conversation_id=?", -1, &statement, nil) == SQLITE_OK else { return false }
            bind(conversationID, to: statement, at: 1)
            while sqlite3_step(statement) == SQLITE_ROW {
                if let value = sqlite3_column_text(statement, 0) {
                    deleteKey(account: messageKeyAccount(conversationID, String(cString: value)))
                }
            }
            sqlite3_finalize(statement)
            return execute("DELETE FROM messages WHERE conversation_id=?", [conversationID]) && checkpoint()
        }
    }

    private func open() -> Bool {
        if database != nil { return true }
        guard let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { return false }
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent("vaultlix-messages.db")
        guard sqlite3_open(url.path, &database) == SQLITE_OK,
              let passphrase = loadOrCreateKey(account: "database.v1") else { database = nil; return false }
        var resourceValues = URLResourceValues()
        resourceValues.isExcludedFromBackup = true
        var protectedURL = url
        try? protectedURL.setResourceValues(resourceValues)
        // A raw hex key avoids both passphrase KDF ambiguity and embedding
        // arbitrary key bytes in quoted SQL text.
        let hex = passphrase.map { String(format: "%02x", $0) }.joined()
        guard sqlite3_exec(database, "PRAGMA key=\"x'\(hex)'\";", nil, nil, nil) == SQLITE_OK else {
            sqlite3_close(database); database = nil; return false
        }
        return sqlite3_exec(database, "PRAGMA cipher_memory_security=ON; PRAGMA secure_delete=ON; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS messages(conversation_id TEXT NOT NULL,message_id TEXT NOT NULL,nonce BLOB NOT NULL,ciphertext BLOB NOT NULL,tag BLOB NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(conversation_id,message_id));", nil, nil, nil) == SQLITE_OK
    }

    private func checkpoint() -> Bool {
        sqlite3_exec(database, "PRAGMA wal_checkpoint(TRUNCATE); PRAGMA incremental_vacuum;", nil, nil, nil) == SQLITE_OK
    }

    private func execute(_ sql: String, _ values: [String]) -> Bool {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK else { return false }
        defer { sqlite3_finalize(statement) }
        for (index, value) in values.enumerated() { bind(value, to: statement, at: Int32(index + 1)) }
        return sqlite3_step(statement) == SQLITE_DONE
    }

    private func bind(_ value: String, to statement: OpaquePointer?, at index: Int32) {
        sqlite3_bind_text(statement, index, value, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self))
    }

    private func bind(_ value: Data, to statement: OpaquePointer?, at index: Int32) {
        _ = value.withUnsafeBytes { sqlite3_bind_blob(statement, index, $0.baseAddress, Int32($0.count), unsafeBitCast(-1, to: sqlite3_destructor_type.self)) }
    }

    private func valid(_ value: String) -> Bool { !value.isEmpty && value.count <= 128 }
    private func messageKeyAccount(_ conversationID: String, _ messageID: String) -> String {
        Data(SHA256.hash(data: Data((conversationID + "\u{0}" + messageID).utf8))).base64EncodedString()
    }

    private func loadOrCreateKey(account: String) -> Data? {
        if let existing = loadKey(account: account) { return existing }
        var bytes = Data(count: 32)
        let status = bytes.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
        return status == errSecSuccess && saveKey(bytes, account: account) ? bytes : nil
    }

    private func loadKey(account: String) -> Data? {
        var query = keyQuery(account)
        query[kSecReturnData as String] = true
        var result: CFTypeRef?
        return SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess ? result as? Data : nil
    }

    private func saveKey(_ data: Data, account: String) -> Bool {
        var query = keyQuery(account)
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        return SecItemAdd(query as CFDictionary, nil) == errSecSuccess
    }

    private func deleteKey(account: String) { SecItemDelete(keyQuery(account) as CFDictionary) }
    private func keyQuery(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "com.vaultlix.secure-messages",
         kSecAttrAccount as String: account]
    }
}
