import Foundation
import SwiftUI

/// What the App Clip shows about the friend who invited the person.
struct InvitedFriend: Equatable {
    let name: String
    let code: String
    let photo: Data?
}

@MainActor
final class InviteModel: ObservableObject {
    enum State: Equatable {
        case waiting
        case loading
        case ready(InvitedFriend)
        case unavailable(String)
    }

    @Published private(set) var state: State = .waiting
    private var handled: URL?

    func handle(url: URL?) {
        guard let url, url != handled else { return }
        handled = url
#if DEBUG
        // Debug builds only: show the invitation screen without a network lookup.
        if let name = ProcessInfo.processInfo.environment["VAULTLIX_CLIP_PREVIEW_NAME"] {
            state = .ready(InvitedFriend(name: name, code: "ABC234", photo: nil))
            return
        }
#endif
        guard let target = InviteLink.target(from: url) else {
            state = .unavailable("This link is not a Vaultlix invitation.")
            return
        }
        state = .loading
        Task { await load(target) }
    }

    private func load(_ target: InviteLink.Target) async {
        do {
            let friend = try await ProfileService.fetch(target)
            // Kept for the full app: after installing, Vaultlix opens this friend's page.
            SharedInvite.save(code: friend.code)
            state = .ready(friend)
        } catch ProfileService.Failure.notFound {
            state = .unavailable("This invitation link is no longer available.")
        } catch ProfileService.Failure.busy {
            state = .unavailable("Too many lookups. Please try again in a little while.")
        } catch {
            state = .unavailable("Could not open this invitation. Check your connection and try again.")
        }
    }
}

/// The public, unauthenticated lookup the web page uses for a friend's link.
enum ProfileService {
    enum Failure: Error { case notFound, busy, invalid, network }

    private struct Payload: Decodable {
        struct Profile: Decodable {
            let displayName: String
            let profileShareCode: String
            let profileImage: String?
        }
        let profile: Profile?
    }

    static func fetch(_ target: InviteLink.Target, session: URLSession = .shared) async throws -> InvitedFriend {
        guard let url = URL(string: "https://vaultlix.com\(InviteLink.lookupPath(for: target))") else { throw Failure.invalid }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 12)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(SharedInvite.lookupKey(), forHTTPHeaderField: "X-Vaultlix-Lookup-Key")
        let (data, response): (Data, URLResponse)
        do { (data, response) = try await session.data(for: request) } catch { throw Failure.network }
        guard let http = response as? HTTPURLResponse else { throw Failure.network }
        if http.statusCode == 404 { throw Failure.notFound }
        if http.statusCode == 429 { throw Failure.busy }
        guard http.statusCode == 200, data.count < 2_000_000,
              let profile = try? JSONDecoder().decode(Payload.self, from: data).profile,
              InviteLink.isValidShareCode(profile.profileShareCode.uppercased()) else { throw Failure.invalid }
        return InvitedFriend(name: displayName(profile.displayName), code: profile.profileShareCode.uppercased(), photo: photo(from: profile.profileImage))
    }

    /// A name as shown: trimmed, one line, not absurdly long.
    static func displayName(_ raw: String) -> String {
        let cleaned = raw.components(separatedBy: .newlines).joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
        return String(cleaned.prefix(60)).isEmpty ? "A friend" : String(cleaned.prefix(60))
    }

    /// The image out of a data: URI, only for the image types the server allows.
    static func photo(from dataURI: String?) -> Data? {
        guard let dataURI, dataURI.count < 1_500_000,
              let comma = dataURI.firstIndex(of: ","),
              dataURI.hasPrefix("data:image/"), dataURI[..<comma].hasSuffix(";base64") else { return nil }
        return Data(base64Encoded: String(dataURI[dataURI.index(after: comma)...]))
    }
}
