import SwiftUI

@main
struct VaultlixClipApp: App {
    @StateObject private var model = InviteModel()

    var body: some Scene {
        WindowGroup {
            InviteView(model: model)
                // Scanning a friend's QR (or opening their link) launches the App Clip with the link.
                .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                    model.handle(url: activity.webpageURL)
                }
                .onOpenURL { model.handle(url: $0) }
                .onAppear {
                    // Xcode's "_XCAppClipURL" launches the clip with a link while testing.
                    if let text = ProcessInfo.processInfo.environment["_XCAppClipURL"], let url = URL(string: text) {
                        model.handle(url: url)
                    }
                }
        }
    }
}
