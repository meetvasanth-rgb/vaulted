import Foundation

/// A Vaultlix link, read for the friend it points at. Pure Foundation: the App
/// Clip and the tests use it, and it never touches the network.
enum InviteLink {
    enum Target: Equatable {
        /// The six-character public profile code (vaultlix.com/p-ABC234).
        case shareCode(String)
        /// A single-use, pre-approved invitation (vaultlix.com/invite/ABC234).
        case privateInvite(String)
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
        guard let url, url.scheme?.lowercased() == "https", let host = url.host?.lowercased() else { return nil }
        // Apple's default App Clip link carries the public invitation code as
        // a launch parameter. Accept only this exact Clip bundle identifier.
        if host == "appclip.apple.com", url.path == "/id",
           let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
           components.queryItems?.first(where: { $0.name == "p" })?.value == "com.vaultlix.app.Clip",
           let code = components.queryItems?.first(where: { $0.name == "invite" || $0.name == "code" })?.value?.uppercased(),
           isValidShareCode(code) {
            let isPrivate = components.queryItems?.first(where: { $0.name == "private" })?.value == "1"
            return isPrivate ? .privateInvite(code) : .shareCode(code)
        }
        guard host == "vaultlix.com" || host == "www.vaultlix.com" else { return nil }
        let path = url.path
        // /invite/ABC234 is a one-time pre-approved invitation. It uses the
        // same public lookup transport as a profile code; the server marks
        // the returned profile as a private invitation.
        if path.hasPrefix("/invite/") {
            var code = String(path.dropFirst("/invite/".count)).uppercased()
            if code.hasSuffix("/") { code.removeLast() }
            return isValidShareCode(code) ? .privateInvite(code) : nil
        }
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
        case .shareCode(let code), .privateInvite(let code): return "/api/profile-share/\(code)"
        case .privateNumber(let number): return "/api/profile/\(number)"
        }
    }
}
