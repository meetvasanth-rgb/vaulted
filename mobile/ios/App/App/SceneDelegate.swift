import UIKit
import Capacitor
import WebKit
import AVFoundation
import LocalAuthentication
import UserNotifications

class SceneDelegate: UIResponder, UIWindowSceneDelegate, WKScriptMessageHandler {
    var window: UIWindow?
    private var observers: [NSObjectProtocol] = []
    private var webReady = false
    private var pendingUniversalLink: URL?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        let bridgeController = CAPBridgeViewController()
        window?.rootViewController = bridgeController
        window?.makeKeyAndVisible()
        bridgeController.webView?.configuration.userContentController.add(self, name: "vaultlixCall")

        observers.append(NotificationCenter.default.addObserver(
            forName: .vaultlixVoIPToken, object: nil, queue: .main
        ) { [weak self] note in self?.emit(name: "vaultlix:voip-token", detail: note.userInfo) })
        observers.append(NotificationCenter.default.addObserver(
            forName: .vaultlixCallAction, object: nil, queue: .main
        ) { [weak self] _ in self?.flushPendingCallActions() })
        observers.append(NotificationCenter.default.addObserver(
            forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main
        ) { [weak self] _ in self?.emitSpeakerState(success: true) })

        // PushKit can issue the token before the remote page finishes loading.
        // Re-emit the persisted value after the bridge has had time to attach.
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            if let token = VaultlixCallManager.shared.voIPToken
                ?? UserDefaults.standard.string(forKey: "vaultlix.voipToken") {
                let environment = UserDefaults.standard.string(forKey: "vaultlix.voipEnvironment") ?? "production"
                self?.emit(name: "vaultlix:voip-token", detail: ["token": token, "environment": environment])
            }
        }

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)

        if let activity = connectionOptions.userActivities.first(where: {
            $0.activityType == NSUserActivityTypeBrowsingWeb
        }), let url = activity.webpageURL, isVaultlixInvite(url) {
            pendingUniversalLink = url
        }
    }

    private func emit(name: String, detail: [AnyHashable: Any]?) {
        guard let controller = window?.rootViewController as? CAPBridgeViewController,
              let webView = controller.webView else { return }
        let safeDetail: [String: Any] = (detail ?? [:]).reduce(into: [:]) { result, item in
            guard let key = item.key as? String else { return }
            if JSONSerialization.isValidJSONObject([key: item.value]) { result[key] = item.value }
        }
        guard let data = try? JSONSerialization.data(withJSONObject: safeDetail),
              let json = String(data: data, encoding: .utf8) else { return }
        let persist = name == "vaultlix:voip-token"
            ? "window.__vaultlixNativeVoipRegistration=\(json);"
            : ""
        let script = "\(persist)window.dispatchEvent(new CustomEvent(\(String(reflecting: name)),{detail:\(json)}));"
        webView.evaluateJavaScript(script)
    }

    private func flushPendingCallActions() {
        // PushKit and CallKit give the process background execution time. Do
        // not wait for foreground activation: the caller needs the answer or
        // decline acknowledgement immediately while the lock screen is up.
        guard webReady else { return }
        for action in VaultlixCallManager.shared.consumePendingActions() {
            emit(name: "vaultlix:call-action", detail: action)
        }
    }

    private func emitSpeakerState(success: Bool) {
        emit(name: "vaultlix:call-audio-route", detail: [
            "available": true,
            "speakerOn": VaultlixCallManager.shared.isSpeakerEnabled(),
            "success": success,
        ])
    }

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard message.name == "vaultlixCall",
              let body = message.body as? [String: Any],
              let action = body["action"] as? String else { return }
        if action == "ready" {
            webReady = true
            if let token = VaultlixCallManager.shared.voIPToken
                ?? UserDefaults.standard.string(forKey: "vaultlix.voipToken") {
                let environment = UserDefaults.standard.string(forKey: "vaultlix.voipEnvironment") ?? "production"
                emit(name: "vaultlix:voip-token", detail: ["token": token, "environment": environment])
            }
            flushPendingCallActions()
            flushPendingUniversalLink()
            return
        }
        if action == "connectedHaptic" {
            let feedback = UIImpactFeedbackGenerator(style: .medium)
            feedback.prepare()
            feedback.impactOccurred()
            return
        }
        if action == "activateQuickLock" {
            UNUserNotificationCenter.current().removeAllDeliveredNotifications()
            return
        }
        if action == "emergencyReset" {
            UNUserNotificationCenter.current().removeAllDeliveredNotifications()
            UNUserNotificationCenter.current().removeAllPendingNotificationRequests()
            VaultlixCallManager.shared.endAllCalls()
            return
        }
        if action == "authenticateQuickLock" {
            let context = LAContext()
            context.localizedCancelTitle = "Keep Locked"
            var authError: NSError?
            guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &authError) else {
                emit(name: "vaultlix:quick-lock-auth", detail: [
                    "success": false,
                    "error": "Set up Face ID, Touch ID, or a device passcode to unlock Vaultlix."
                ])
                return
            }
            context.evaluatePolicy(
                .deviceOwnerAuthentication,
                localizedReason: "Unlock your private Vaultlix session"
            ) { [weak self] success, _ in
                DispatchQueue.main.async {
                    self?.emit(name: "vaultlix:quick-lock-auth", detail: ["success": success])
                }
            }
            return
        }
        if action == "getSpeakerState" {
            emitSpeakerState(success: true)
            return
        }
        if action == "prepareOutgoingAudio" {
            let success = VaultlixCallManager.shared.prepareOutgoingWebAudio()
            emitSpeakerState(success: success)
            return
        }
        if action == "startOutgoing",
           let roomHandle = body["roomHandle"] as? String,
           let code = body["code"] as? String,
           let caller = body["caller"] as? String,
           let peer = body["peer"] as? String,
           roomHandle.range(of: "^[A-Za-z0-9_-]{16,64}$", options: .regularExpression) != nil,
           code.count <= 128 {
            let success = VaultlixCallManager.shared.startOutgoingCall(
                roomHandle: roomHandle, code: code, caller: caller, peer: peer
            )
            if !success { emit(name: "vaultlix:call-action", detail: ["action": "nativeFailed", "code": code]) }
            return
        }
        if action == "setSpeaker",
           let enabled = body["enabled"] as? Bool {
            let success = VaultlixCallManager.shared.setSpeakerEnabled(
                enabled,
                activateSession: body["outgoing"] as? Bool ?? false
            )
            emitSpeakerState(success: success)
            return
        }
        if action == "updateCaller",
           let caller = body["caller"] as? String {
            VaultlixCallManager.shared.updateCallerName(caller)
            return
        }
        if action == "provisionRoom",
           let handle = body["roomHandle"] as? String,
           let code = body["code"] as? String,
           let token = body["token"] as? String,
           let keyString = body["key"] as? String,
           handle.range(of: "^[A-Za-z0-9_-]{16,64}$", options: .regularExpression) != nil,
           code.count <= 128,
           token.count <= 256,
           let key = Data(base64Encoded: keyString), key.count == 32 {
            let saved = NativeCallRoomStore.shared.save(
                NativeCallRoom(handle: handle, code: code, token: token, aesKey: key)
            )
            print("VXCALL scene provision saved=\(saved)")
            return
        }
        if action == "answer",
           let code = body["code"] as? String,
           code.count <= 128 {
            VaultlixCallManager.shared.answerCallFromWeb(roomCode: code)
            return
        }
        guard action == "end",
              let code = body["code"] as? String,
              code.count <= 128 else { return }
        VaultlixCallManager.shared.endCallFromWeb(roomCode: code)
        VaultlixCallManager.shared.releaseOutgoingWebAudio()
    }

    deinit {
        (window?.rootViewController as? CAPBridgeViewController)?
            .webView?.configuration.userContentController.removeScriptMessageHandler(forName: "vaultlixCall")
        observers.forEach(NotificationCenter.default.removeObserver)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
        if userActivity.activityType == NSUserActivityTypeBrowsingWeb,
           let url = userActivity.webpageURL,
           isVaultlixInvite(url) {
            pendingUniversalLink = url
            flushPendingUniversalLink()
        }
    }

    private func isVaultlixInvite(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "https",
              url.host?.lowercased() == "vaultlix.com" else { return false }
        return url.path.range(of: "^/join/[A-Za-z0-9-]+/?$", options: .regularExpression) != nil
    }

    private func flushPendingUniversalLink() {
        guard webReady,
              let url = pendingUniversalLink,
              let controller = window?.rootViewController as? CAPBridgeViewController,
              let webView = controller.webView else { return }
        pendingUniversalLink = nil
        let encodedURL = String(reflecting: url.absoluteString)
        webView.evaluateJavaScript(
            "window.vaultlixOpenInviteURL&&window.vaultlixOpenInviteURL(\(encodedURL));"
        )
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        if webReady,
           let token = VaultlixCallManager.shared.voIPToken
                ?? UserDefaults.standard.string(forKey: "vaultlix.voipToken") {
            let environment = UserDefaults.standard.string(forKey: "vaultlix.voipEnvironment") ?? "production"
            emit(name: "vaultlix:voip-token", detail: ["token": token, "environment": environment])
        }
        flushPendingCallActions()
        flushPendingUniversalLink()
    }
}
