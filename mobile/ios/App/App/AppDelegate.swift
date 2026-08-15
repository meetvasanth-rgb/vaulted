import UIKit
import Capacitor
import PushKit
import CallKit
import AVFoundation
import UserNotifications

extension Notification.Name {
    static let vaultlixVoIPToken = Notification.Name("VaultlixVoIPToken")
    static let vaultlixCallAction = Notification.Name("VaultlixCallAction")
}

/// Owns PushKit and CallKit for genuine Vaultlix WebRTC call invitations.
/// The web layer receives token/answer events through SceneDelegate and
/// remains responsible for authenticated room subscription and E2E signaling.
final class VaultlixCallManager: NSObject, PKPushRegistryDelegate, CXProviderDelegate {
    static let shared = VaultlixCallManager()

    private let provider: CXProvider
    private let callController = CXCallController()
    private var registry: PKPushRegistry?
    private var calls: [UUID: [String: Any]] = [:]
    private var answeredCalls: Set<UUID> = []
    private var nativeMediaCalls: Set<UUID> = []
    private var connectedCalls: Set<UUID> = []
    private var outgoingWebAudioSessionActive = false
    private var pendingActions: [[String: Any]] = []
    private(set) var voIPToken: String?

    private override init() {
        let configuration = CXProviderConfiguration(localizedName: "Vaultlix")
        configuration.supportsVideo = true
        configuration.maximumCallGroups = 1
        configuration.maximumCallsPerCallGroup = 1
        configuration.supportedHandleTypes = [.generic]
        configuration.includesCallsInRecents = false
        provider = CXProvider(configuration: configuration)
        super.init()
        provider.setDelegate(self, queue: nil)
    }

    func start() {
        guard registry == nil else { return }
        let registry = PKPushRegistry(queue: .main)
        registry.delegate = self
        registry.desiredPushTypes = [.voIP]
        self.registry = registry
    }

    func pushRegistry(_ registry: PKPushRegistry,
                      didUpdate pushCredentials: PKPushCredentials,
                      for type: PKPushType) {
        guard type == .voIP else { return }
        let token = pushCredentials.token.map { String(format: "%02x", $0) }.joined()
        voIPToken = token
        UserDefaults.standard.set(token, forKey: "vaultlix.voipToken")
        #if DEBUG
        let environment = "sandbox"
        #else
        let environment = "production"
        #endif
        UserDefaults.standard.set(environment, forKey: "vaultlix.voipEnvironment")
        NotificationCenter.default.post(name: .vaultlixVoIPToken, object: nil,
                                        userInfo: ["token": token, "environment": environment])
    }

    func pushRegistry(_ registry: PKPushRegistry,
                      didInvalidatePushTokenFor type: PKPushType) {
        guard type == .voIP else { return }
        voIPToken = nil
        UserDefaults.standard.removeObject(forKey: "vaultlix.voipToken")
        NotificationCenter.default.post(name: .vaultlixVoIPToken, object: nil,
                                        userInfo: ["token": NSNull()])
    }

    func pushRegistry(_ registry: PKPushRegistry,
                      didReceiveIncomingPushWith payload: PKPushPayload,
                      for type: PKPushType,
                      completion: @escaping () -> Void) {
        guard type == .voIP else { completion(); return }
        let data = payload.dictionaryPayload.reduce(into: [String: Any]()) { result, item in
            if let key = item.key as? String { result[key] = item.value }
        }
        let action = data["action"] as? String ?? "incoming"
        guard let rawCallID = data["callId"] as? String,
              let callID = UUID(uuidString: rawCallID) else {
            completion()
            return
        }

        // Accept the corrected PushKit action and the legacy spelling so an
        // end push already in flight during a rolling server deploy cannot
        // strand a CXCall on the device.
        if action == "end" || action == "endCall" {
            endCall(callID: callID)
            completion()
            return
        }

        let caller = (data["caller"] as? String)?.prefix(80) ?? "Someone"
        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: String(caller))
        update.localizedCallerName = String(caller)
        update.hasVideo = data["hasVideo"] as? Bool ?? false
        update.supportsHolding = false
        update.supportsGrouping = false
        update.supportsUngrouping = false
        update.supportsDTMF = false
        calls[callID] = data
        if let roomHandle = data["roomHandle"] as? String,
           NativeWebRTCCallEngine.shared.prepareIncoming(callID: callID, roomHandle: roomHandle) {
            nativeMediaCalls.insert(callID)
            print("VXCALL manager incoming native-ready")
        } else {
            print("VXCALL manager incoming web-fallback")
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) { [weak self] in
            guard let self,
                  self.calls[callID] != nil,
                  !self.answeredCalls.contains(callID) else { return }
            self.provider.reportCall(with: callID, endedAt: Date(), reason: .unanswered)
            self.calls.removeValue(forKey: callID)
            NativeWebRTCCallEngine.shared.end(callID: callID, notifyPeer: false)
            self.nativeMediaCalls.remove(callID)
        }

        // iOS requires every VoIP push to be reported to CallKit promptly.
        provider.reportNewIncomingCall(with: callID, update: update) { [weak self] error in
            if error != nil { self?.calls.removeValue(forKey: callID) }
            completion()
        }
    }

    private func postAction(_ action: String, callID: UUID, payload: [String: Any]) {
        var detail: [String: Any] = ["action": action, "callId": callID.uuidString]
        if let code = payload["code"] as? String { detail["code"] = code }
        // APNs receives only this opaque device-local handle. Passing it on
        // to the already-provisioned WebView lets the foreground UI select
        // the right vault without exposing or reconstructing the vault code.
        if let roomHandle = payload["roomHandle"] as? String { detail["roomHandle"] = roomHandle }
        if let caller = payload["caller"] as? String { detail["caller"] = String(caller.prefix(80)) }
        pendingActions.append(detail)
        NotificationCenter.default.post(name: .vaultlixCallAction, object: nil,
                                        userInfo: detail)
    }

    func consumePendingActions() -> [[String: Any]] {
        let actions = pendingActions
        pendingActions.removeAll()
        return actions
    }

    func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        print("VXCALL manager answer requested")
        guard let payload = calls[action.callUUID] else { action.fail(); return }
        do {
            // CallKit owns activation/deactivation, but the application must
            // still describe the session it needs. Without playAndRecord +
            // voiceChat, the system call can connect while WKWebView's WebRTC
            // microphone remains silent or routes as playback-only.
            try AVAudioSession.sharedInstance().setCategory(
                .playAndRecord,
                mode: .voiceChat,
                options: [.allowBluetooth]
            )
        } catch {
            action.fail()
            return
        }
        answeredCalls.insert(action.callUUID)
        if nativeMediaCalls.contains(action.callUUID) {
            print("VXCALL manager answer native")
            NativeWebRTCCallEngine.shared.answer(callID: action.callUUID)
        } else {
            print("VXCALL manager answer web-fallback")
        }
        // A PushKit wake grants the app background execution time. Forward the
        // answer immediately so the web signalling layer can acknowledge the
        // caller while CallKit activates the audio session. Ending CallKit here
        // used to display "Call Failed", leave Android ringing, and generate a
        // second "Open Vaultlix" notification even though the user had answered.
        // A provisioned native call must have exactly one media owner. Do not
        // also tell WKWebView to create a second peer connection/audio track.
        if !nativeMediaCalls.contains(action.callUUID) {
            postAction("answer", callID: action.callUUID, payload: payload)
        }
        action.fulfill()
    }

    func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        let payload = calls.removeValue(forKey: action.callUUID) ?? [:]
        answeredCalls.remove(action.callUUID)
        connectedCalls.remove(action.callUUID)
        NativeWebRTCCallEngine.shared.end(callID: action.callUUID, notifyPeer: true)
        nativeMediaCalls.remove(action.callUUID)
        postAction("declineOrEnd", callID: action.callUUID, payload: payload)
        action.fulfill()
    }

    func providerDidReset(_ provider: CXProvider) {
        calls.removeAll()
        answeredCalls.removeAll()
        nativeMediaCalls.removeAll()
        connectedCalls.removeAll()
        NativeWebRTCCallEngine.shared.reset()
    }

    func endCallFromWeb(roomCode: String) {
        guard let match = calls.first(where: { ($0.value["code"] as? String) == roomCode }) ?? calls.first else { return }
        provider.reportCall(with: match.key, endedAt: Date(), reason: .remoteEnded)
        calls.removeValue(forKey: match.key)
        answeredCalls.remove(match.key)
    }

    func answerCallFromWeb(roomCode: String) {
        guard let match = calls.first(where: { ($0.value["code"] as? String) == roomCode }) ?? calls.first,
              !answeredCalls.contains(match.key) else { return }
        // Route an answer made in Vaultlix's own UI through CallKit too.
        // Otherwise the WebRTC timer starts while iOS continues presenting
        // the native incoming-call banner with Answer/Decline controls.
        let transaction = CXTransaction(action: CXAnswerCallAction(call: match.key))
        callController.request(transaction) { error in
            if let error { print("CallKit web-answer transaction failed: \(error.localizedDescription)") }
        }
    }

    func updateCallerName(_ name: String) {
        guard let callID = calls.keys.first else { return }
        let cleanName = String(name.prefix(80))
        guard !cleanName.isEmpty else { return }
        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: cleanName)
        update.localizedCallerName = cleanName
        update.hasVideo = false
        provider.reportCall(with: callID, updated: update)
    }

    func endCall(callID: UUID) {
        guard let payload = calls[callID] else { return }
        let wasAnswered = answeredCalls.contains(callID)
        NativeWebRTCCallEngine.shared.end(callID: callID, notifyPeer: false)
        provider.reportCall(with: callID, endedAt: Date(), reason: .remoteEnded)
        calls.removeValue(forKey: callID)
        answeredCalls.remove(callID)
        nativeMediaCalls.remove(callID)
        connectedCalls.remove(callID)
        // CallKit and native WebRTC are only two of the three call-state
        // owners. Tell the embedded web UI as well, otherwise its call screen
        // and duration timer remain live after the remote peer has hung up.
        postAction(wasAnswered ? "ended" : "missed", callID: callID, payload: payload)
    }

    /// Called only after libwebrtc reports an established ICE path. The web
    /// layer uses this event for presentation only; native remains the sole
    /// signaling and media owner for the call.
    func nativeCallDidConnect(callID: UUID) {
        DispatchQueue.main.async {
            guard let payload = self.calls[callID],
                  self.nativeMediaCalls.contains(callID),
                  !self.connectedCalls.contains(callID) else { return }
            self.connectedCalls.insert(callID)
            var connectedPayload = payload
            connectedPayload["connectedAt"] = Date().timeIntervalSince1970 * 1000
            self.postAction("nativeConnected", callID: callID, payload: connectedPayload)
        }
    }

    func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        print("VXCALL manager didActivate")
        NativeWebRTCCallEngine.shared.callKitDidActivate(audioSession)
        // Queue this just like answer/end. A plain NotificationCenter event
        // was previously discarded by SceneDelegate's observer, so the web
        // layer never learned that CallKit had made microphone capture legal.
        if let match = calls.first {
            postAction("audioActivated", callID: match.key, payload: match.value)
        }
    }

    func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        NativeWebRTCCallEngine.shared.callKitDidDeactivate(audioSession)
        if let match = calls.first {
            postAction("audioDeactivated", callID: match.key, payload: match.value)
        }
    }

    /// Native incoming calls are owned by CallKit/libwebrtc rather than the
    /// WKWebView, so the browser cannot use setSinkId to select the receiver
    /// or loudspeaker. Keep the route change in the same AVAudioSession that
    /// CallKit activated and let `.none` restore the system-selected route
    /// (earpiece or a connected Bluetooth device).
    @discardableResult
    func prepareOutgoingWebAudio() -> Bool {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth])
            try session.setActive(true, options: .notifyOthersOnDeactivation)
            try session.overrideOutputAudioPort(.none)
            outgoingWebAudioSessionActive = true
            return true
        } catch {
            print("VXCALL manager outgoing audio activation failed: \(error.localizedDescription)")
            return false
        }
    }

    func releaseOutgoingWebAudio() {
        guard outgoingWebAudioSessionActive else { return }
        outgoingWebAudioSessionActive = false
        do {
            let session = AVAudioSession.sharedInstance()
            try session.overrideOutputAudioPort(.none)
            try session.setActive(false, options: .notifyOthersOnDeactivation)
        } catch {
            print("VXCALL manager outgoing audio deactivation failed: \(error.localizedDescription)")
        }
    }

    @discardableResult
    func setSpeakerEnabled(_ enabled: Bool, activateSession: Bool = false) -> Bool {
        do {
            let session = AVAudioSession.sharedInstance()
            // Outgoing calls are WebView-owned and therefore do not pass
            // through CXAnswerCallAction, which configures this category for
            // native incoming calls. Configure the same voice route here so
            // `.none` genuinely returns to the receiver/Bluetooth instead of
            // leaving WKWebView's playback route on the loudspeaker.
            try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth])
            if activateSession && !outgoingWebAudioSessionActive {
                try session.setActive(true, options: .notifyOthersOnDeactivation)
                outgoingWebAudioSessionActive = true
            }
            try session.overrideOutputAudioPort(enabled ? .speaker : .none)
            return true
        } catch {
            print("VXCALL manager speaker route failed: \(error.localizedDescription)")
            return false
        }
    }

    func isSpeakerEnabled() -> Bool {
        AVAudioSession.sharedInstance().currentRoute.outputs.contains { $0.portType == .builtInSpeaker }
    }
}

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        VaultlixCallManager.shared.start()
        return true
    }

    func application(_ application: UIApplication,
                     didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(
            name: .capacitorDidRegisterForRemoteNotifications,
            object: deviceToken
        )
    }

    func application(_ application: UIApplication,
                     didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(
            name: .capacitorDidFailToRegisterForRemoteNotifications,
            object: error
        )
    }

    func application(_ application: UIApplication,
                     didReceiveRemoteNotification userInfo: [AnyHashable: Any],
                     fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
        let action = userInfo["action"] as? String
        if (action == "end" || action == "endCall"),
           let rawCallID = userInfo["callId"] as? String,
           let callID = UUID(uuidString: rawCallID) {
            VaultlixCallManager.shared.endCall(callID: callID)
            completionHandler(.newData)
            return
        }
        completionHandler(.noData)
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}
