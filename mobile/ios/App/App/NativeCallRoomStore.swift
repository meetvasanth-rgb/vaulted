import Foundation
import Security

struct NativeCallRoom: Codable {
    let handle: String
    let code: String
    let token: String
    let aesKey: Data
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
}
