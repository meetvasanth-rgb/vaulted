import Foundation

/// The one invitation that travels from the App Clip to the full app. Both
/// belong to the same App Group, so a code saved by the App Clip is still there
/// when the person installs Vaultlix. Only the public six-character profile
/// code is stored, only when it is well formed, and it is ignored after a week.
enum SharedInvite {
    static let groupIdentifier = "group.com.vaultlix.app"
    static let maxAge: TimeInterval = 7 * 24 * 60 * 60
    private static let codeKey = "pendingInviteCode"
    private static let dateKey = "pendingInviteAt"
    private static let lookupKeyKey = "profileLookupKey"

    private static func store(_ defaults: UserDefaults?) -> UserDefaults? {
        defaults ?? UserDefaults(suiteName: groupIdentifier)
    }

    static func save(code: String, now: Date = Date(), defaults: UserDefaults? = nil) {
        let code = code.uppercased()
        guard InviteLink.isValidShareCode(code), let store = store(defaults) else { return }
        store.set(code, forKey: codeKey)
        store.set(now.timeIntervalSince1970, forKey: dateKey)
    }

    /// The saved code, if it is well formed and recent.
    static func pendingCode(now: Date = Date(), defaults: UserDefaults? = nil) -> String? {
        guard let store = store(defaults), let code = store.string(forKey: codeKey), InviteLink.isValidShareCode(code) else { return nil }
        let saved = store.double(forKey: dateKey)
        guard saved > 0 else { return nil }
        let age = now.timeIntervalSince1970 - saved
        return age >= -3600 && age <= maxAge ? code : nil
    }

    static func clear(defaults: UserDefaults? = nil) {
        guard let store = store(defaults) else { return }
        store.removeObject(forKey: codeKey)
        store.removeObject(forKey: dateKey)
    }

    /// A random per-install key, so the public lookup is rate-limited for this
    /// device rather than for everyone sharing an address.
    static func lookupKey(defaults: UserDefaults? = nil) -> String {
        if let store = store(defaults), let existing = store.string(forKey: lookupKeyKey), existing.count >= 20 { return existing }
        let key = (UUID().uuidString + UUID().uuidString).replacingOccurrences(of: "-", with: "")
        store(defaults)?.set(key, forKey: lookupKeyKey)
        return key
    }
}
