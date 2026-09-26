import Foundation

/// A Vaultlix link, read for the friend it points at. Pure Foundation: the App
/// Clip and the tests use it, and it never touches the network.
enum InviteLink {
    enum Target: Equatable {
        /// The six-character public profile code (vaultlix.com/p-ABC234).
        case shareCode(String)
        /// A Private Number link (vaultlix.com/2345678901), from older cards.
        case privateNumber(String)
    }

    /// The characters a public profile code is made of: no I, O, 0 or 1.
    static let codeAlphabet = Set("ABCDEFGHJKLMNPQRSTUVWXYZ23456789")

    static func isValidShareCode(_ value: String) -> Bool {
        value.count == 6 && value.allSatisfy { codeAlphabet.contains($0) }
    }

    static func isValidPrivateNumber(_ value: String) -> Bool {
        guard (6...10).contains(value.count), let first = value.first, first >= "2", first <= "9" else { return false }
        return value.allSatisfy { $0.isASCII && $0.isNumber }
    }

    static func target(from url: URL?) -> Target? {
        guard let url, url.scheme?.lowercased() == "https",
              let host = url.host?.lowercased(), host == "vaultlix.com" || host == "www.vaultlix.com" else { return nil }
        let path = url.path
        // /p-ABC234 and /p/ABC234, with an optional trailing slash.
        for prefix in ["/p-", "/p/"] where path.hasPrefix(prefix) {
            var code = String(path.dropFirst(prefix.count)).uppercased()
            if code.hasSuffix("/") { code.removeLast() }
            return isValidShareCode(code) ? .shareCode(code) : nil
        }
        var number = String(path.dropFirst())
        if number.hasSuffix("/") { number.removeLast() }
        return isValidPrivateNumber(number) ? .privateNumber(number) : nil
    }

    /// The path of the public lookup for a target.
    static func lookupPath(for target: Target) -> String {
        switch target {
        case .shareCode(let code): return "/api/profile-share/\(code)"
        case .privateNumber(let number): return "/api/profile/\(number)"
        }
    }
}
