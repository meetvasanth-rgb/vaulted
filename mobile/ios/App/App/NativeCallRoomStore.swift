import Foundation
import Security

struct NativeCallRoom: Codable {
    let handle: String
    let code: String
    let token: String
    let aesKey: Data
    let peerName: String?
}

/// Stores only the minimum material required to answer while WKWebView is
/// suspended. Items never sync to iCloud and are unavailable before the
/// device has been unlocked once after boot.
///
/// Explicitly pinned to the app's own default keychain access group
/// (TeamID.com.vaultlix.app — the exact identifier this app already used
/// implicitly before this group existed, so existing items already saved
/// under it remain fully readable/writable with no migration). Stating it
/// explicitly, rather than relying on the implicit default, is what lets
/// VaultlixNotificationService — a separate target whose own implicit
/// default would otherwise be TeamID.com.vaultlix.app.NotificationService,
/// a different keychain space entirely — read what the main app wrote here.
/// Both targets must list this same string in their
/// com.apple.security.keychain-access-groups entitlement for that sharing
/// to actually work; the access group alone does nothing without it.
final class NativeCallRoomStore {
    static let shared = NativeCallRoomStore()
    private let service = "com.vaultlix.app.native-call-room"
    private let accessGroup = "3KLX2S84MV.com.vaultlix.app"
    private let shareRecipientHandlesKey = "vaultlix.share.recipient-handles.v1"

    private init() {}

    func save(_ room: NativeCallRoom) -> Bool {
        guard let encoded = try? JSONEncoder().encode(room) else { return false }
        let lookup: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: room.handle,
            kSecAttrAccessGroup as String: accessGroup,
        ]
        SecItemDelete(lookup as CFDictionary)
        var add = lookup
        add[kSecValueData as String] = encoded
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        guard SecItemAdd(add as CFDictionary, nil) == errSecSuccess else { return false }
        // A separate, lightweight index (handle only, not the full room
        // payload) so a lookup that only has the room code — all a push
        // notification's userInfo ever carries — can still find the right
        // entry above. Keychain has no way to query by a field inside the
        // encoded blob directly.
        return saveCodeIndex(code: room.code, handle: room.handle)
    }

    private func saveCodeIndex(code: String, handle: String) -> Bool {
        guard let data = handle.data(using: .utf8) else { return false }
        let lookup: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: "code:" + code,
            kSecAttrAccessGroup as String: accessGroup,
        ]
        SecItemDelete(lookup as CFDictionary)
        var add = lookup
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }

    func room(handle: String) -> NativeCallRoom? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: handle,
            kSecAttrAccessGroup as String: accessGroup,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return try? JSONDecoder().decode(NativeCallRoom.self, from: data)
    }

    /// Used by VaultlixNotificationService, which only ever has a room code
    /// (from the push payload) to work with, never the native call handle.
    func room(code: String) -> NativeCallRoom? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: "code:" + code,
            kSecAttrAccessGroup as String: accessGroup,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data,
              let handle = String(data: data, encoding: .utf8) else { return nil }
        return room(handle: handle)
    }

    func shareEligibleRooms() -> [NativeCallRoom] {
        let handles = UserDefaults(suiteName: "group.com.vaultlix.app")?
            .stringArray(forKey: shareRecipientHandlesKey) ?? []
        var seenCodes = Set<String>()
        return handles.compactMap { room(handle: $0) }.filter { seenCodes.insert($0.code).inserted }
    }
}

// Short-lived E2E ciphertext only. Shared with the notification extension;
// no message keys, plaintext, session tokens or read receipts are staged here.
enum NotificationMessageCache {
    private static let prefix = "vaultlix.notification-ciphertext.v1."
    private static let ttl: Double = 10 * 60 * 1000
    private static var defaults: UserDefaults? { UserDefaults(suiteName: "group.com.vaultlix.app") }
    private static func key(_ conversation: String, _ id: String) -> String {
        prefix + Data("\(conversation)|\(id)".utf8).base64EncodedString()
    }
    static func put(conversation: String, encoded: String) {
        guard !conversation.isEmpty, conversation.count <= 128, encoded.utf8.count <= 1800,
              let data = encoded.data(using: .utf8),
              let envelope = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let id = envelope["id"] as? String, !id.isEmpty, id.count <= 128,
              let ciphertext = (envelope["content"] ?? envelope["ciphertext"]) as? String,
              ["v:", "v2:", "g1:"].contains(where: { ciphertext.hasPrefix($0) }), let defaults else { return }
        let now = Date().timeIntervalSince1970 * 1000
        var count = 0
        for (key, value) in defaults.dictionaryRepresentation() where key.hasPrefix(prefix) {
            count += 1
            let received = (value as? [String: Any])?["receivedAt"] as? Double ?? 0
            if received < now - ttl || count > 200 { defaults.removeObject(forKey: key) }
        }
        defaults.set(["kind":"notification-envelope", "id":id, "conversation":conversation,
                      "envelope":envelope, "receivedAt":now], forKey:key(conversation, id))
    }
    static func recent(conversation: String) -> [String] {
        guard let defaults else { return [] }
        let cutoff = Date().timeIntervalSince1970 * 1000 - ttl
        return defaults.dictionaryRepresentation().compactMap { key, value in
            guard key.hasPrefix(prefix), let record = value as? [String: Any],
                  record["conversation"] as? String == conversation,
                  (record["receivedAt"] as? Double ?? 0) >= cutoff,
                  let data = try? JSONSerialization.data(withJSONObject:record) else { return nil }
            return String(data:data, encoding:.utf8)
        }
    }
    static func remove(conversation: String, id: String) { defaults?.removeObject(forKey:key(conversation, id)) }
    static func clear(conversation: String? = nil) {
        guard let defaults else { return }
        for (key, value) in defaults.dictionaryRepresentation() where key.hasPrefix(prefix) {
            if conversation == nil || (value as? [String: Any])?["conversation"] as? String == conversation {
                defaults.removeObject(forKey:key)
            }
        }
    }
}
