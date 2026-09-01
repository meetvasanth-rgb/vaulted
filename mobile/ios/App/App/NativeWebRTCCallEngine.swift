import Foundation
import AVFoundation
import CryptoKit
import OSLog
import WebRTC

/// Owns media and encrypted signaling for iOS CallKit calls. The
/// Vaultlix server relays only AES-GCM envelopes; SDP and ICE never leave the
/// two endpoints in plaintext. Browser/PWA calls continue using the web engine.
final class NativeWebRTCCallEngine: NSObject {
    static let shared = NativeWebRTCCallEngine()

    private let factory: RTCPeerConnectionFactory
    private let queue = DispatchQueue(label: "com.vaultlix.native-call")
    private var room: NativeCallRoom?
    private var callID: UUID?
    private var socket: URLSessionWebSocketTask?
    private var peer: RTCPeerConnection?
    private var audioSource: RTCAudioSource?
    private var audioTrack: RTCAudioTrack?
    private var pendingOffer: [String: Any]?
    private var pendingCandidates: [[String: Any]] = []
    private var sequenceOut = 0
    private var sequenceIn = 0
    private var peerSessionID: String?
    private let sessionID = UUID().uuidString
    private var answered = false
    private var signalingReady = false
    private var queuedSignals: [(type: String, payload: [String: Any])] = []
    private var reconnectAttempt = 0
    private var reconnectGeneration = 0
    private var turnRequestInFlight = false
    private var turnAttempt = 0
    private var offerReceived = false
    private var outgoing = false
    private var outgoingCaller = "Someone"
    private var inviteRetryGeneration = 0
    private var acceptRetryGeneration = 0
    private let logger = Logger(subsystem: "com.vaultlix.app", category: "NativeCall")

    private func trace(_ message: String) {
        logger.info("\(message, privacy: .public)")
#if DEBUG
        print("VXCALL engine \(message)")
#endif
    }

    private override init() {
        RTCInitializeSSL()
        factory = RTCPeerConnectionFactory()
        super.init()
        // CallKit—not libwebrtc—owns AVAudioSession activation. Keeping the
        // audio device manual avoids capture starting against a stale or
        // playback-only session while the system answer transaction runs.
        RTCAudioSession.sharedInstance().useManualAudio = true
        RTCAudioSession.sharedInstance().isAudioEnabled = false
    }

    @discardableResult
    func prepareIncoming(callID: UUID, roomHandle: String) -> Bool {
        guard let stored = NativeCallRoomStore.shared.room(handle: roomHandle) else {
            trace("prepare missing-room")
            return false
        }
        trace("prepare room-found")
        queue.async {
            self.resetLocked()
            self.room = stored
            self.callID = callID
            self.connectSignalingLocked()
            // PushKit wakes us before the user answers. Use that ring time to
            // prepare TURN/RTCPeerConnection; CallKit keeps media disabled and
            // no answer is sent until the user explicitly accepts.
            self.fetchTurnAndCreatePeerLocked()
        }
        return true
    }

    @discardableResult
    func prepareOutgoing(callID: UUID, roomHandle: String, caller: String) -> Bool {
        guard let stored = NativeCallRoomStore.shared.room(handle: roomHandle) else {
            trace("prepare-outgoing missing-room")
            return false
        }
        trace("prepare-outgoing room-found")
        queue.async {
            self.resetLocked()
            self.room = stored
            self.callID = callID
            self.outgoing = true
            self.outgoingCaller = String(caller.prefix(80))
            self.connectSignalingLocked()
        }
        return true
    }

    func startOutgoing(callID: UUID) {
        queue.async {
            guard self.callID == callID, self.outgoing, self.room != nil else {
                self.trace("start-outgoing rejected-state")
                return
            }
            self.trace("start-outgoing accepted-state")
            // Prepare the relay and peer while CallKit is ringing. Media is
            // still disabled by CallKit and no offer is sent until the
            // encrypted call-accept arrives, but this removes TURN setup
            // from the post-answer critical path.
            self.fetchTurnAndCreatePeerLocked()
            self.sendOutgoingInviteLocked()
            self.scheduleInviteRetryLocked()
        }
    }

    func answer(callID: UUID) {
        queue.async {
            guard self.callID == callID, self.room != nil else {
                self.trace("answer rejected-state")
                return
            }
            self.trace("answer accepted-state")
            self.answered = true
            self.sendSignalLocked(type: "call-accept", payload: [:])
            self.scheduleAcceptRetryLocked()
            self.fetchTurnAndCreatePeerLocked()
        }
    }

    func callKitDidActivate(_ audioSession: AVAudioSession) {
        queue.async {
            self.trace("audio activated")
            self.prepareAudioTrackLocked()
            RTCAudioSession.sharedInstance().audioSessionDidActivate(audioSession)
            RTCAudioSession.sharedInstance().isAudioEnabled = true
            self.audioTrack?.isEnabled = true
        }
    }

    func callKitDidDeactivate(_ audioSession: AVAudioSession) {
        queue.async {
            self.trace("audio deactivated")
            RTCAudioSession.sharedInstance().isAudioEnabled = false
            RTCAudioSession.sharedInstance().audioSessionDidDeactivate(audioSession)
        }
    }

    func end(callID: UUID, notifyPeer: Bool) {
        queue.async {
            guard self.callID == callID else { return }
            if notifyPeer { self.sendSignalLocked(type: "call-hangup", payload: [:]) }
            self.resetLocked()
        }
    }

    func reset() { queue.async { self.resetLocked() } }

    private func connectSignalingLocked() {
        guard socket == nil, let url = URL(string: "wss://vaultlix.com/ws/signal"), let room else {
            trace("signal connect skipped")
            return
        }
        trace("signal connecting")
        signalingReady = false
        let task = URLSession(configuration: .default).webSocketTask(with: url)
        socket = task
        task.resume()
        sendRawLocked(["type": "auth", "code": room.code, "token": room.token, "nativeCall": true])
        receiveLocked(task)
    }

    private func receiveLocked(_ task: URLSessionWebSocketTask) {
        task.receive { [weak self, weak task] result in
            guard let self, let task else { return }
            self.queue.async {
                guard self.socket === task else { return }
                if case .success(let message) = result {
                    self.trace("signal received")
                    let text: String?
                    switch message { case .string(let value): text = value; case .data(let data): text = String(data: data, encoding: .utf8); @unknown default: text = nil }
                    if let text { self.handleSocketTextLocked(text) }
                    self.receiveLocked(task)
                } else {
                    self.trace("signal receive-failed")
                    self.socket = nil
                    self.signalingReady = false
                    self.scheduleSignalReconnectLocked()
                }
            }
        }
    }

    private func handleSocketTextLocked(_ text: String) {
        guard let data = text.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = object["type"] as? String else {
            trace("signal ignored-envelope")
            return
        }
        if type == "ready" {
            trace("signal ready")
            signalingReady = true
            reconnectAttempt = 0
            flushQueuedSignalsLocked()
            return
        }
        // Android can decline from its native notification before its
        // encrypted WebView socket exists. The server authenticates this
        // socket as the matching caller and sends a content-free terminal
        // control frame. Handle it before requiring an encrypted envelope;
        // otherwise an outgoing iOS CallKit call keeps ringing indefinitely.
        if type == "native-call-declined" {
            trace("signal type=native-call-declined")
            if outgoing, let callID {
                DispatchQueue.main.async {
                    VaultlixCallManager.shared.nativeCallDidEnd(
                        callID: callID,
                        action: "nativeDeclined"
                    )
                }
            }
            resetLocked()
            return
        }
        if type == "native-call-answering" {
            trace("signal type=native-call-answering")
            if outgoing, let callID {
                DispatchQueue.main.async {
                    VaultlixCallManager.shared.nativeOutgoingIsAnswering(callID: callID)
                }
            }
            return
        }
        guard let envelope = object["envelope"] as? String else {
            trace("signal ignored-envelope")
            return
        }
        if let remoteSession = object["sessionId"] as? String, remoteSession != peerSessionID {
            peerSessionID = remoteSession
            sequenceIn = 0
        }
        guard let payload = decryptEnvelopeLocked(envelope) else {
            trace("signal decrypt-failed type=\(type)")
            return
        }
        trace("signal type=\(type)")
        switch type {
        case "call-invite":
            guard !outgoing else { return }
            sendSignalLocked(type: "call-ringing", payload: [:])
            if answered { sendSignalLocked(type: "call-accept", payload: [:]) }
        case "call-ringing":
            guard outgoing, let callID else { return }
            DispatchQueue.main.async { VaultlixCallManager.shared.nativeOutgoingDidRing(callID: callID) }
        case "call-accept":
            guard outgoing else { return }
            inviteRetryGeneration += 1
            answered = true
            if peer == nil { fetchTurnAndCreatePeerLocked() }
            else { createAndSendOfferLocked() }
        case "offer":
            guard answered, !outgoing else { return }
            offerReceived = true
            acceptRetryGeneration += 1
            if peer == nil { pendingOffer = payload; fetchTurnAndCreatePeerLocked() }
            else { processOfferLocked(payload) }
        case "ice-candidate":
            guard let candidate = payload["candidate"] as? [String: Any] else { return }
            if peer?.remoteDescription == nil { pendingCandidates.append(candidate) }
            else { addCandidateLocked(candidate) }
        case "answer":
            guard outgoing else { return }
            processAnswerLocked(payload)
        case "call-hangup", "call-decline", "call-busy":
            // CXProvider and the manager's call collections are main-thread
            // owned. A remote hang-up arrives on this engine's serial queue;
            // hand it to the main queue so CallKit and the in-app state end
            // together instead of leaving a live system call behind.
            if let callID {
                DispatchQueue.main.async {
                    VaultlixCallManager.shared.nativeCallDidEnd(
                        callID: callID,
                        action: type == "call-decline" ? "nativeDeclined" :
                            (type == "call-busy" ? "nativeBusy" : "ended")
                    )
                }
            }
            resetLocked()
        default: break
        }
    }

    private func fetchTurnAndCreatePeerLocked() {
        guard peer == nil, !turnRequestInFlight, let room else { return }
        turnRequestInFlight = true
        turnAttempt += 1
        trace("turn requesting")
        var request = URLRequest(url: URL(string: "https://vaultlix.com/api/turn-credentials")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["code": room.code, "token": room.token])
        URLSession.shared.dataTask(with: request) { [weak self] data, _, _ in
            guard let self, let data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let servers = json["iceServers"] as? [[String: Any]] else {
                self?.trace("turn failed")
                self?.queue.async {
                    guard let self else { return }
                    self.turnRequestInFlight = false
                    self.scheduleTurnRetryLocked()
                }
                return
            }
            self.trace("turn received count=\(servers.count)")
            self.queue.async {
                self.turnRequestInFlight = false
                self.turnAttempt = 0
                self.createPeerLocked(servers)
            }
        }.resume()
    }

    private func createPeerLocked(_ servers: [[String: Any]]) {
        guard peer == nil else { return }
        trace("peer creating")
        let config = RTCConfiguration()
        config.iceTransportPolicy = .relay
        config.sdpSemantics = .unifiedPlan
        config.iceServers = servers.compactMap { entry in
            let urls = (entry["urls"] as? [String]) ?? (entry["urls"] as? String).map { [$0] } ?? []
            guard !urls.isEmpty else { return nil }
            return RTCIceServer(urlStrings: urls, username: entry["username"] as? String, credential: entry["credential"] as? String)
        }
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        guard let pc = factory.peerConnection(with: config, constraints: constraints, delegate: self) else {
            trace("peer create-failed")
            return
        }
        trace("peer created")
        peer = pc
        prepareAudioTrackLocked()
        if let audioTrack { _ = pc.add(audioTrack, streamIds: ["vaultlix-native-stream"]) }
        if outgoing && answered { createAndSendOfferLocked() }
        else if let offer = pendingOffer { pendingOffer = nil; processOfferLocked(offer) }
    }

    private func createAndSendOfferLocked() {
        guard let pc = peer, outgoing else { return }
        pc.offer(for: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)) { [weak self, weak pc] offer, error in
            guard let self, let pc, let offer, error == nil else {
                self?.trace("offer create-failed")
                return
            }
            pc.setLocalDescription(offer) { error in
                guard error == nil else { self.trace("offer local-description-failed"); return }
                self.trace("offer sending")
                self.queue.async { self.sendSignalLocked(type: "offer", payload: ["type": "offer", "sdp": offer.sdp]) }
            }
        }
    }

    private func processAnswerLocked(_ payload: [String: Any]) {
        guard let pc = peer, let sdp = payload["sdp"] as? String else {
            trace("answer missing-state")
            return
        }
        pc.setRemoteDescription(RTCSessionDescription(type: .answer, sdp: sdp)) { [weak self, weak pc] error in
            guard let self, let pc, error == nil else { self?.trace("answer remote-description-failed"); return }
            self.queue.async {
                self.pendingCandidates.forEach { self.addCandidateLocked($0) }
                self.pendingCandidates.removeAll()
            }
        }
    }

    private func processOfferLocked(_ payload: [String: Any]) {
        guard let pc = peer, let sdp = payload["sdp"] as? String else {
            trace("offer missing-state")
            return
        }
        trace("offer processing")
        pc.setRemoteDescription(RTCSessionDescription(type: .offer, sdp: sdp)) { [weak self, weak pc] error in
            guard let self, let pc, error == nil else {
                self?.trace("offer remote-description-failed")
                return
            }
            self.queue.async {
                self.pendingCandidates.forEach { self.addCandidateLocked($0) }
                self.pendingCandidates.removeAll()
                pc.answer(for: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)) { answer, error in
                    guard let answer, error == nil else {
                        self.trace("answer create-failed")
                        return
                    }
                    pc.setLocalDescription(answer) { error in
                        guard error == nil else {
                            self.trace("answer local-description-failed")
                            return
                        }
                        self.trace("answer sending")
                        self.queue.async { self.sendSignalLocked(type: "answer", payload: ["type": "answer", "sdp": answer.sdp]) }
                    }
                }
            }
        }
    }

    private func addCandidateLocked(_ value: [String: Any]) {
        guard let pc = peer, let sdp = value["candidate"] as? String else { return }
        let mid = value["sdpMid"] as? String
        let index = (value["sdpMLineIndex"] as? NSNumber)?.int32Value ?? 0
        pc.add(RTCIceCandidate(sdp: sdp, sdpMLineIndex: index, sdpMid: mid))
    }

    private func prepareAudioTrackLocked() {
        guard audioTrack == nil else { return }
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: [
            "googEchoCancellation": "true", "googAutoGainControl": "true", "googNoiseSuppression": "true"
        ])
        let source = factory.audioSource(with: constraints)
        audioSource = source
        audioTrack = factory.audioTrack(with: source, trackId: "vaultlix-native-audio")
    }

    private func sendSignalLocked(type: String, payload: [String: Any]) {
        guard signalingReady, socket != nil else {
            enqueueSignalLocked(type: type, payload: payload)
            trace("signal queued type=\(type)")
            if socket == nil { scheduleSignalReconnectLocked() }
            return
        }
        guard let envelope = encryptEnvelopeLocked(payload) else {
            trace("signal encrypt-failed type=\(type)")
            return
        }
        trace("signal sending type=\(type)")
        sendRawLocked(["type": type, "sessionId": sessionID, "envelope": envelope])
    }

    private func sendRawLocked(_ object: [String: Any]) {
        guard let socket, let data = try? JSONSerialization.data(withJSONObject: object), let text = String(data: data, encoding: .utf8) else { return }
        socket.send(.string(text)) { _ in }
    }

    private func enqueueSignalLocked(type: String, payload: [String: Any]) {
        // Acceptance is idempotent and should have only one queued copy.
        if type == "call-accept" { queuedSignals.removeAll { $0.type == type } }
        guard queuedSignals.count < 128 else {
            trace("signal queue-full type=\(type)")
            return
        }
        queuedSignals.append((type, payload))
    }

    private func flushQueuedSignalsLocked() {
        guard signalingReady else { return }
        let pending = queuedSignals
        queuedSignals.removeAll()
        for signal in pending { sendSignalLocked(type: signal.type, payload: signal.payload) }
    }

    private func scheduleSignalReconnectLocked() {
        guard room != nil, callID != nil, socket == nil, reconnectAttempt < 6 else { return }
        reconnectAttempt += 1
        let generation = reconnectGeneration
        let delay = min(4.0, pow(2.0, Double(reconnectAttempt - 1)) * 0.5)
        trace("signal reconnect-scheduled attempt=\(reconnectAttempt)")
        queue.asyncAfter(deadline: .now() + delay) {
            guard generation == self.reconnectGeneration,
                  self.room != nil, self.callID != nil, self.socket == nil else { return }
            self.connectSignalingLocked()
        }
    }

    private func scheduleTurnRetryLocked() {
        guard answered, peer == nil, room != nil, turnAttempt < 4 else { return }
        let generation = reconnectGeneration
        let delay = min(4.0, pow(2.0, Double(max(0, turnAttempt - 1))))
        trace("turn retry-scheduled attempt=\(turnAttempt)")
        queue.asyncAfter(deadline: .now() + delay) {
            guard generation == self.reconnectGeneration,
                  self.answered, self.peer == nil, self.room != nil else { return }
            self.fetchTurnAndCreatePeerLocked()
        }
    }

    private func scheduleAcceptRetryLocked() {
        acceptRetryGeneration += 1
        let generation = acceptRetryGeneration
        func retry(_ remaining: Int) {
            guard remaining > 0, generation == acceptRetryGeneration,
                  answered, !offerReceived, room != nil else { return }
            sendSignalLocked(type: "call-accept", payload: [:])
            queue.asyncAfter(deadline: .now() + 1.5) { retry(remaining - 1) }
        }
        queue.asyncAfter(deadline: .now() + 1.5) { retry(12) }
    }

    private func sendOutgoingInviteLocked() {
        sendSignalLocked(type: "call-invite", payload: ["from": outgoingCaller])
    }

    private func scheduleInviteRetryLocked() {
        inviteRetryGeneration += 1
        let generation = inviteRetryGeneration
        func retry(_ remaining: Int) {
            guard remaining > 0, generation == inviteRetryGeneration,
                  outgoing, !answered, room != nil else { return }
            sendOutgoingInviteLocked()
            queue.asyncAfter(deadline: .now() + 3) { retry(remaining - 1) }
        }
        queue.asyncAfter(deadline: .now() + 3) { retry(9) }
    }

    private func encryptEnvelopeLocked(_ payload: [String: Any]) -> String? {
        guard let room else { return nil }
        sequenceOut += 1
        let wrapped: [String: Any] = ["seq": sequenceOut, "ts": Date().timeIntervalSince1970 * 1000, "payload": payload]
        guard let plaintext = try? JSONSerialization.data(withJSONObject: wrapped),
              let box = try? AES.GCM.seal(plaintext, using: SymmetricKey(data: room.aesKey)),
              let combined = box.combined else { return nil }
        return "v:" + combined.base64EncodedString()
    }

    private func decryptEnvelopeLocked(_ envelope: String) -> [String: Any]? {
        guard envelope.hasPrefix("v:"), let room, let combined = Data(base64Encoded: String(envelope.dropFirst(2))),
              let box = try? AES.GCM.SealedBox(combined: combined),
              let clear = try? AES.GCM.open(box, using: SymmetricKey(data: room.aesKey)),
              let wrapped = try? JSONSerialization.jsonObject(with: clear) as? [String: Any],
              let seq = (wrapped["seq"] as? NSNumber)?.intValue, seq > sequenceIn,
              let payload = wrapped["payload"] as? [String: Any] else { return nil }
        sequenceIn = seq
        return payload
    }

    private func resetLocked() {
        reconnectGeneration += 1
        acceptRetryGeneration += 1
        inviteRetryGeneration += 1
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        signalingReady = false
        peer?.close()
        peer = nil
        audioTrack?.isEnabled = false
        audioTrack = nil
        audioSource = nil
        room = nil
        callID = nil
        pendingOffer = nil
        pendingCandidates.removeAll()
        sequenceOut = 0
        sequenceIn = 0
        peerSessionID = nil
        answered = false
        queuedSignals.removeAll()
        reconnectAttempt = 0
        turnRequestInFlight = false
        turnAttempt = 0
        offerReceived = false
        outgoing = false
        outgoingCaller = "Someone"
    }
}

extension NativeWebRTCCallEngine: RTCPeerConnectionDelegate {
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        trace("ice state=\(newState.rawValue)")
        if newState == .connected || newState == .completed {
            queue.async {
                guard self.peer === peerConnection, let callID = self.callID else { return }
                VaultlixCallManager.shared.nativeCallDidConnect(callID: callID)
            }
            return
        }
        guard newState == .failed || newState == .closed else { return }
        queue.async {
            guard self.peer === peerConnection, let callID = self.callID else { return }
            VaultlixCallManager.shared.endCall(callID: callID)
        }
    }
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        let mid: Any = candidate.sdpMid ?? NSNull()
        queue.async { self.sendSignalLocked(type: "ice-candidate", payload: ["candidate": ["candidate": candidate.sdp, "sdpMid": mid, "sdpMLineIndex": candidate.sdpMLineIndex]]) }
    }
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
}
