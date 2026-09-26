import SwiftUI
import StoreKit

struct InviteView: View {
    @ObservedObject var model: InviteModel
    @State private var showInstall = false

    private let burgundy = Color(red: 0.408, green: 0.173, blue: 0.263)

    var body: some View {
        VStack(spacing: 18) {
            Spacer(minLength: 24)
            content
            Spacer(minLength: 12)
            Button {
                showInstall = true
            } label: {
                Text("Get Vaultlix")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(burgundy)
                    .foregroundColor(.white)
                    .clipShape(RoundedRectangle(cornerRadius: 14))
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 12)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(red: 0.98, green: 0.97, blue: 0.97).ignoresSafeArea())
        // Apple's own install sheet for an App Clip, shown once the invitation is on screen.
        .appStoreOverlay(isPresented: $showInstall) { SKOverlay.AppClipConfiguration(position: .bottom) }
        .onChange(of: model.state) { state in
            if case .ready = state { showInstall = true }
        }
    }

    @ViewBuilder private var content: some View {
        switch model.state {
        case .waiting, .loading:
            ProgressView("Opening your invitation…").tint(burgundy)
        case .ready(let friend):
            VStack(spacing: 14) {
                avatar(for: friend)
                Text("\(friend.name) invited you to Vaultlix")
                    .font(.title2.weight(.bold))
                    .multilineTextAlignment(.center)
                    .foregroundColor(Color(red: 0.153, green: 0.114, blue: 0.145))
                Text("Vaultlix gives you a private number for end-to-end encrypted chats and calls. No phone number, email or contacts needed.")
                    .font(.subheadline)
                    .multilineTextAlignment(.center)
                    .foregroundColor(.secondary)
                    .padding(.horizontal, 28)
                Text("Invite code \(friend.code)")
                    .font(.footnote.monospaced())
                    .foregroundColor(.secondary)
                    .textSelection(.enabled)
                Text("After installing, Vaultlix opens \(friend.name)'s invitation. If it does not, tap “Have an invite code?” and enter the code above.")
                    .font(.caption)
                    .multilineTextAlignment(.center)
                    .foregroundColor(.secondary)
                    .padding(.horizontal, 32)
            }
        case .unavailable(let message):
            VStack(spacing: 10) {
                Image(systemName: "lock.shield").font(.system(size: 44)).foregroundColor(burgundy)
                Text(message).multilineTextAlignment(.center).foregroundColor(.secondary).padding(.horizontal, 28)
            }
        }
    }

    @ViewBuilder private func avatar(for friend: InvitedFriend) -> some View {
        if let data = friend.photo, let image = UIImage(data: data) {
            Image(uiImage: image).resizable().scaledToFill().frame(width: 92, height: 92).clipShape(Circle())
        } else {
            Circle().fill(burgundy.opacity(0.12)).frame(width: 92, height: 92)
                .overlay(Text(String(friend.name.prefix(1)).uppercased()).font(.largeTitle.weight(.bold)).foregroundColor(burgundy))
        }
    }
}
