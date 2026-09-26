import Foundation

// Run with: ./ClipTests/run.sh   (plain Swift, no Xcode project needed)
var failures = 0
func check(_ condition: @autoclosure () -> Bool, _ message: String, line: Int = #line) {
    if !condition() { failures += 1; print("FAIL (line \(line)): \(message)") }
}
func url(_ text: String) -> URL? { URL(string: text) }

// ── links ────────────────────────────────────────────────────────────────
check(InviteLink.target(from: url("https://vaultlix.com/p-ABC234")) == .shareCode("ABC234"), "p- link")
check(InviteLink.target(from: url("https://vaultlix.com/p-abc234?ref=qr")) == .shareCode("ABC234"), "lower case with a query")
check(InviteLink.target(from: url("https://vaultlix.com/p/ABC234/")) == .shareCode("ABC234"), "p/ link with a trailing slash")
check(InviteLink.target(from: url("https://www.vaultlix.com/p-ABC234")) == .shareCode("ABC234"), "www host")
check(InviteLink.target(from: url("https://vaultlix.com/2345678901?ref=qr")) == .privateNumber("2345678901"), "private number link")
check(InviteLink.target(from: url("https://vaultlix.com/234567")) == .privateNumber("234567"), "six-digit private number")
check(InviteLink.target(from: url("http://vaultlix.com/p-ABC234")) == nil, "http is refused")
check(InviteLink.target(from: url("https://evil.com/p-ABC234")) == nil, "another host is refused")
check(InviteLink.target(from: url("https://vaultlix.com.evil.com/p-ABC234")) == nil, "look-alike host is refused")
check(InviteLink.target(from: url("https://vaultlix.com/p-ABC23")) == nil, "code too short")
check(InviteLink.target(from: url("https://vaultlix.com/p-ABC2345")) == nil, "code too long")
check(InviteLink.target(from: url("https://vaultlix.com/p-ABC0O1")) == nil, "characters codes never use")
check(InviteLink.target(from: url("https://vaultlix.com/p-ABC234/../x")) == nil, "path tricks")
check(InviteLink.target(from: url("https://vaultlix.com/join/abc")) == nil, "a room link is not an invitation")
check(InviteLink.target(from: url("https://vaultlix.com/1234567890")) == nil, "private numbers do not start with 0 or 1")
check(InviteLink.target(from: url("https://vaultlix.com/23456")) == nil, "private number too short")
check(InviteLink.target(from: nil) == nil, "no link")
check(InviteLink.lookupPath(for: .shareCode("ABC234")) == "/api/profile-share/ABC234", "lookup path (code)")
check(InviteLink.lookupPath(for: .privateNumber("2345678901")) == "/api/profile/2345678901", "lookup path (number)")

// ── the invitation handed from the App Clip to the app ───────────────────
func freshDefaults() -> UserDefaults {
    let name = "vaultlix.tests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: name)!
    defaults.removePersistentDomain(forName: name)
    return defaults
}
let now = Date(timeIntervalSince1970: 2_000_000_000)
do {
    let d = freshDefaults()
    check(SharedInvite.pendingCode(now: now, defaults: d) == nil, "nothing saved yet")
    SharedInvite.save(code: "abc234", now: now, defaults: d)
    check(SharedInvite.pendingCode(now: now, defaults: d) == "ABC234", "saved, upper-cased")
    check(SharedInvite.pendingCode(now: now.addingTimeInterval(6 * 24 * 3600), defaults: d) == "ABC234", "still fresh after 6 days")
    check(SharedInvite.pendingCode(now: now.addingTimeInterval(8 * 24 * 3600), defaults: d) == nil, "ignored after a week")
    check(SharedInvite.pendingCode(now: now.addingTimeInterval(-7200), defaults: d) == nil, "not from the future")
    SharedInvite.clear(defaults: d)
    check(SharedInvite.pendingCode(now: now, defaults: d) == nil, "cleared")
}
do {
    let d = freshDefaults()
    SharedInvite.save(code: "NOTACODE", now: now, defaults: d)
    SharedInvite.save(code: "ABC0O1", now: now, defaults: d)
    check(SharedInvite.pendingCode(now: now, defaults: d) == nil, "a malformed code is never stored")
    d.set("ABC234", forKey: "pendingInviteCode") // no date: ignored
    check(SharedInvite.pendingCode(now: now, defaults: d) == nil, "a code without a date is ignored")
}
do {
    let d = freshDefaults()
    let key = SharedInvite.lookupKey(defaults: d)
    check(key.count >= 20 && key.count <= 128 && key.allSatisfy { $0.isLetter || $0.isNumber }, "lookup key fits the server's pattern")
    check(SharedInvite.lookupKey(defaults: d) == key, "and stays the same for this install")
}

// ── what is shown ────────────────────────────────────────────────────────
check(ProfileService.displayName("  Vasanth  ") == "Vasanth", "trimmed")
check(ProfileService.displayName("Line one\nLine two") == "Line one Line two", "one line")
check(ProfileService.displayName("") == "A friend", "empty name")
check(ProfileService.displayName(String(repeating: "x", count: 200)).count == 60, "long name is cut")
check(ProfileService.photo(from: nil) == nil, "no photo")
check(ProfileService.photo(from: "https://evil.example/x.png") == nil, "a link is not a photo")
check(ProfileService.photo(from: "data:text/html;base64,PGI+") == nil, "not an image")
check(ProfileService.photo(from: "data:image/png;base64,iVBORw0KGgo=") != nil, "a data image")
check(ProfileService.photo(from: "data:image/png,notbase64") == nil, "must be base64")

if failures == 0 { print("All clip logic checks passed") } else { print("\(failures) check(s) failed"); exit(1) }
