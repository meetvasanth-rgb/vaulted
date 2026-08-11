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
final class NativeCallRoomStore {
    static let shared = NativeCallRoomStore()
    private let service = "com.vaultlix.app.native-call-room"

    private init() {}

    func save(_ room: NativeCallRoom) -> Bool {
        guard let encoded = try? JSONEncoder().encode(room) else { return false }
        let lookup: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: room.handle,
        ]
        SecItemDelete(lookup as CFDictionary)
        var add = lookup
        add[kSecValueData as String] = encoded
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }

    func room(handle: String) -> NativeCallRoom? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: handle,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return try? JSONDecoder().decode(NativeCallRoom.self, from: data)
    }
}
