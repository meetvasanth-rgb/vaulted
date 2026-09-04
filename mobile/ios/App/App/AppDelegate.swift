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
    private var outgoingCalls: Set<UUID> = []
    private var outgoingWebAudioSessionActive = false
    private var callKitAudioSessionActive = false
    private var ringbackCallID: UUID?
    private var ringbackEngine: AVAudioEngine?
    private var ringbackPlayer: AVAudioPlayerNode?
    private var pendingActions: [[String: Any]] = []
    private(set) var voIPToken: String?

    private override init() {
        let configuration = CXProviderConfiguration(localizedName: NSLocalizedString("call_service_name", comment: "CallKit service name"))
        configuration.supportsVideo = true
        configuration.maximumCallGroups = 1
        configuration.maximumCallsPerCallGroup = 1
        configuration.supportedHandleTypes = [.generic]
        configuration.includesCallsInRecents = false
        provider = CXProvider(configuration: configuration)
        super.init()
        provider.setDelegate(self, queue: nil)
    }

    /// CallKit presents above Vaultlix but does not automatically clear a
    /// focused HTML control. UIKit's `endEditing` alone only detaches InputUI
    /// temporarily; WebKit can restore the DOM-focused textarea during the
    /// scene transition. Blur and briefly lock the composer in the DOM first,
    /// then clear every native responder before reporting the call.
    private func dismissAppKeyboard() {
        let script = """
        (() => {
          const active = document.activeElement;
          if (active && typeof active.blur === 'function') active.blur();
          const input = document.getElementById('msg-input');
          if (input) {
            input.blur();
            input.readOnly = true;
            input.dataset.vaultlixCallKeyboardGuard = '1';
            window.setTimeout(() => {
              if (input.dataset.vaultlixCallKeyboardGuard === '1') {
                delete input.dataset.vaultlixCallKeyboardGuard;
                input.readOnly = false;
              }
            }, 1500);
          }
          return active ? active.id || active.tagName : 'none';
        })();
        """
        var webViewCount = 0
        var nativeDismissed = false
        for case let scene as UIWindowScene in UIApplication.shared.connectedScenes {
            for window in scene.windows {
                if let controller = window.rootViewController as? CAPBridgeViewController,
                   let webView = controller.webView {
                    webViewCount += 1
                    webView.evaluateJavaScript(script) { value, error in
                        print("VXCALL keyboard DOM blur value=\(String(describing: value)) error=\(String(describing: error))")
                    }
                }
                nativeDismissed = window.endEditing(true) || nativeDismissed
            }
        }
        UIApplication.shared.sendAction(
            #selector(UIResponder.resignFirstResponder),
            to: nil,
            from: nil,
            for: nil
        )
        print("VXCALL keyboard dismiss webViews=\(webViewCount) native=\(nativeDismissed)")
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

        // The native media engine intentionally owns one encrypted call at a
        // time. A second PushKit invitation must still be reported to CallKit,
        // but it must never replace/reset the engine backing the active call.
        if calls.keys.contains(where: { $0 != callID }) {
            dismissAppKeyboard()
            provider.reportNewIncomingCall(with: callID, update: update) { [weak self] error in
                if error == nil {
                    self?.provider.reportCall(with: callID, endedAt: Date(), reason: .declinedElsewhere)
                }
                self?.declineCompetingCall(callID: callID)
                completion()
            }
            return
        }

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
        dismissAppKeyboard()
        // One short main-run-loop window lets WebKit commit the DOM blur before
        // InCallService takes over. This remains well inside PushKit's prompt
        // reporting requirement and has no perceptible effect on ringing.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.18) { [weak self] in
            guard let self else { completion(); return }
            self.provider.reportNewIncomingCall(with: callID, update: update) { [weak self] error in
                if error != nil { self?.calls.removeValue(forKey: callID) }
                completion()
            }
        }
    }

    private func declineCompetingCall(callID: UUID) {
        guard let url = URL(string: "https://vaultlix.com/api/native-call/decline") else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 5
        request.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["callId": callID.uuidString])
        URLSession.shared.dataTask(with: request).resume()
    }

    private func postAction(_ action: String, callID: UUID, payload: [String: Any]) {
        var detail: [String: Any] = [
            "action": action,
            "callId": callID.uuidString,
            "occurredAt": Date().timeIntervalSince1970 * 1000,
        ]
        if let code = payload["code"] as? String { detail["code"] = code }
        // APNs receives only this opaque device-local handle. Passing it on
        // to the already-provisioned WebView lets the foreground UI select
        // the right vault without exposing or reconstructing the vault code.
        if let roomHandle = payload["roomHandle"] as? String { detail["roomHandle"] = roomHandle }
        if let caller = payload["caller"] as? String { detail["caller"] = String(caller.prefix(80)) }
        // When iOS keeps the WebView suspended behind the lock screen, it can
        // queue connected/audio events and the later terminal event together.
        // Replaying that history on the next foreground used to resurrect the
        // call UI only to play its ending animation minutes after the call.
        // A terminal action supersedes every earlier presentation action for
        // the same call; the encrypted call-history message remains canonical.
        let terminalActions: Set<String> = [
            "ended", "missed", "declineOrEnd", "nativeDeclined", "nativeBusy", "nativeFailed",
        ]
        if terminalActions.contains(action) {
            pendingActions.removeAll { ($0["callId"] as? String) == callID.uuidString }
        }
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

    func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        guard calls[action.callUUID] != nil,
              nativeMediaCalls.contains(action.callUUID) else { action.fail(); return }
        do {
            try AVAudioSession.sharedInstance().setCategory(
                .playAndRecord,
                mode: .voiceChat,
                options: [.allowBluetooth]
            )
        } catch {
            action.fail()
            return
        }
        provider.reportOutgoingCall(with: action.callUUID, startedConnectingAt: Date())
        ringbackCallID = action.callUUID
        NativeWebRTCCallEngine.shared.startOutgoing(callID: action.callUUID)
        action.fulfill()
    }

    func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        stopRingback(callID: action.callUUID)
        let payload = calls.removeValue(forKey: action.callUUID) ?? [:]
        answeredCalls.remove(action.callUUID)
        connectedCalls.remove(action.callUUID)
        outgoingCalls.remove(action.callUUID)
        NativeWebRTCCallEngine.shared.end(callID: action.callUUID, notifyPeer: true)
        nativeMediaCalls.remove(action.callUUID)
        postAction("declineOrEnd", callID: action.callUUID, payload: payload)
        action.fulfill()
    }

    func providerDidReset(_ provider: CXProvider) {
        stopRingback()
        calls.removeAll()
        answeredCalls.removeAll()
        nativeMediaCalls.removeAll()
        connectedCalls.removeAll()
        outgoingCalls.removeAll()
        NativeWebRTCCallEngine.shared.reset()
    }

    func endCallFromWeb(roomCode: String) {
        guard let match = calls.first(where: { ($0.value["code"] as? String) == roomCode }) ?? calls.first else { return }
        stopRingback(callID: match.key)
        NativeWebRTCCallEngine.shared.end(callID: match.key, notifyPeer: true)
        provider.reportCall(with: match.key, endedAt: Date(), reason: .remoteEnded)
        calls.removeValue(forKey: match.key)
        answeredCalls.remove(match.key)
        nativeMediaCalls.remove(match.key)
        connectedCalls.remove(match.key)
        outgoingCalls.remove(match.key)
    }

    func endAllCalls() {
        stopRingback()
        for callID in Array(calls.keys) {
            NativeWebRTCCallEngine.shared.end(callID: callID, notifyPeer: true)
            provider.reportCall(with: callID, endedAt: Date(), reason: .remoteEnded)
        }
        calls.removeAll()
        answeredCalls.removeAll()
        nativeMediaCalls.removeAll()
        connectedCalls.removeAll()
        outgoingCalls.removeAll()
        outgoingWebAudioSessionActive = false
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

    func startOutgoingCall(roomHandle: String, code: String, caller: String, peer: String) -> Bool {
        dismissAppKeyboard()
        let callID = UUID()
        let payload: [String: Any] = [
            "callId": callID.uuidString,
            "roomHandle": roomHandle,
            "code": code,
            "caller": String(peer.prefix(80)),
        ]
        guard NativeWebRTCCallEngine.shared.prepareOutgoing(
            callID: callID,
            roomHandle: roomHandle,
            caller: caller
        ) else { return false }
        calls[callID] = payload
        nativeMediaCalls.insert(callID)
        outgoingCalls.insert(callID)
        let handle = CXHandle(type: .generic, value: String(peer.prefix(80)))
        let action = CXStartCallAction(call: callID, handle: handle)
        action.isVideo = false
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.18) { [weak self] in
            self?.callController.request(CXTransaction(action: action)) { [weak self] error in
                guard let error else { return }
                print("VXCALL manager outgoing transaction failed: \(error.localizedDescription)")
                DispatchQueue.main.async {
                    self?.calls.removeValue(forKey: callID)
                    self?.nativeMediaCalls.remove(callID)
                    self?.outgoingCalls.remove(callID)
                    NativeWebRTCCallEngine.shared.end(callID: callID, notifyPeer: false)
                    self?.postAction("nativeFailed", callID: callID, payload: payload)
                }
            }
        }
        return true
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
        stopRingback(callID: callID)
        let wasAnswered = answeredCalls.contains(callID)
        NativeWebRTCCallEngine.shared.end(callID: callID, notifyPeer: false)
        provider.reportCall(with: callID, endedAt: Date(), reason: .remoteEnded)
        calls.removeValue(forKey: callID)
        answeredCalls.remove(callID)
        nativeMediaCalls.remove(callID)
        connectedCalls.remove(callID)
        outgoingCalls.remove(callID)
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
            self.stopRingback(callID: callID)
            if self.outgoingCalls.contains(callID) {
                self.provider.reportOutgoingCall(with: callID, connectedAt: Date())
            }
            var connectedPayload = payload
            connectedPayload["connectedAt"] = Date().timeIntervalSince1970 * 1000
            self.postAction("nativeConnected", callID: callID, payload: connectedPayload)
        }
    }

    func nativeOutgoingDidRing(callID: UUID) {
        DispatchQueue.main.async {
            guard let payload = self.calls[callID], self.nativeMediaCalls.contains(callID) else { return }
            self.postAction("nativeRinging", callID: callID, payload: payload)
        }
    }

    func nativeOutgoingIsAnswering(callID: UUID) {
        DispatchQueue.main.async {
            guard let payload = self.calls[callID],
                  self.nativeMediaCalls.contains(callID),
                  self.outgoingCalls.contains(callID) else { return }
            self.postAction("nativeAnswering", callID: callID, payload: payload)
        }
    }

    func nativeCallDidEnd(callID: UUID, action: String) {
        DispatchQueue.main.async {
            guard let payload = self.calls[callID] else { return }
            self.stopRingback(callID: callID)
            NativeWebRTCCallEngine.shared.end(callID: callID, notifyPeer: false)
            self.provider.reportCall(with: callID, endedAt: Date(), reason: .remoteEnded)
            self.calls.removeValue(forKey: callID)
            self.answeredCalls.remove(callID)
            self.nativeMediaCalls.remove(callID)
            self.connectedCalls.remove(callID)
            self.outgoingCalls.remove(callID)
            self.postAction(action, callID: callID, payload: payload)
        }
    }

    func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        print("VXCALL manager didActivate")
        callKitAudioSessionActive = true
        NativeWebRTCCallEngine.shared.callKitDidActivate(audioSession)
        // CallKit owns the VoIP audio session. Starting a player before this
        // callback creates an apparently running engine whose route is replaced
        // during activation, producing silent ringback. Let libwebrtc attach to
        // the newly active session first, then add the local caller tone.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
            self?.startRingbackIfPossible()
        }
        // Queue this just like answer/end. A plain NotificationCenter event
        // was previously discarded by SceneDelegate's observer, so the web
        // layer never learned that CallKit had made microphone capture legal.
        if let match = calls.first {
            postAction("audioActivated", callID: match.key, payload: match.value)
        }
    }

    func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        callKitAudioSessionActive = false
        stopRingback()
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

    /// iOS does not synthesize ringback for app-provided VoIP calls. Play it
    /// through CallKit's active communication route while the peer is ringing.
    private func startRingbackIfPossible() {
        guard let callID = ringbackCallID,
              callKitAudioSessionActive,
              outgoingCalls.contains(callID),
              !connectedCalls.contains(callID),
              ringbackEngine == nil else { return }
        let engine = AVAudioEngine()
        let player = AVAudioPlayerNode()
        engine.attach(player)
        let format = AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1)!
        engine.connect(player, to: engine.mainMixerNode, format: format)

        // 1.8 seconds of dual-frequency ringback and 2.2 seconds of silence.
        let frameCount = AVAudioFrameCount(16_000 * 4)
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount),
              let channel = buffer.floatChannelData?[0] else { return }
        buffer.frameLength = frameCount
        let audibleFrames = 16_000 * 18 / 10
        let fadeFrames = 160
        for frame in 0..<Int(frameCount) {
            guard frame < audibleFrames else { channel[frame] = 0; continue }
            let envelope: Float
            if frame < fadeFrames { envelope = Float(frame) / Float(fadeFrames) }
            else if frame > audibleFrames - fadeFrames {
                envelope = Float(audibleFrames - frame) / Float(fadeFrames)
            } else { envelope = 1 }
            let seconds = Double(frame) / 16_000.0
            channel[frame] = Float(
                (sin(2 * Double.pi * 440 * seconds) + sin(2 * Double.pi * 480 * seconds)) * 0.12
            ) * envelope
        }
        player.scheduleBuffer(buffer, at: nil, options: .loops)
        do {
            try engine.start()
            player.play()
            ringbackEngine = engine
            ringbackPlayer = player
            print("VXCALL manager ringback started route=\(AVAudioSession.sharedInstance().currentRoute.outputs.map(\.portType.rawValue))")
        } catch {
            engine.stop()
            print("VXCALL manager ringback start failed: \(error.localizedDescription)")
        }
    }

    private func stopRingback(callID: UUID? = nil) {
        if let callID, ringbackCallID != callID { return }
        ringbackPlayer?.stop()
        ringbackEngine?.stop()
        ringbackPlayer = nil
        ringbackEngine = nil
        ringbackCallID = nil
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
