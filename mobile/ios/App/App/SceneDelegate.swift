import UIKit
import Capacitor
import WebKit
import AVFoundation
import UserNotifications
import LocalAuthentication
import WebRTC

class SceneDelegate: UIResponder, UIWindowSceneDelegate, WKScriptMessageHandler, UIDocumentPickerDelegate, UIDocumentInteractionControllerDelegate {
    var window: UIWindow?
    private var observers: [NSObjectProtocol] = []
    private var audioRouteSettlesAt: Date?
    private var webReady = false
    private var pendingUniversalLink: URL?
    private var appSwitcherPrivacyCover: UIView?
    private var preparedShareImageURL: URL?
    private var pendingDocumentExportURL: URL?
    private var pendingOpenFileURL: URL?
    private var documentInteractionController: UIDocumentInteractionController?
    private let nativeRemoteVideoView = RTCMTLVideoView(frame: .zero)
    private let nativeLocalVideoView = RTCMTLVideoView(frame: .zero)
    private let nativeVideoBackdropView = UIView(frame: .zero)
    private let nativeVideoPausedView = UIView(frame: .zero)
    private let nativeVideoPausedIcon = UIImageView(frame: .zero)
    private let nativeVideoPausedLabel = UILabel(frame: .zero)
    private let nativeVideoControlsView = UIVisualEffectView(effect: UIBlurEffect(style: .systemUltraThinMaterialDark))
    private let nativeMuteButton = UIButton(type: .system)
    private let nativeRouteButton = UIButton(type: .system)
    private let nativeCameraButton = UIButton(type: .system)
    private let nativeFlipButton = UIButton(type: .system)
    private let nativeEndButton = UIButton(type: .system)
    private weak var nativeRemoteVideoTrack: RTCVideoTrack?
    private weak var nativeLocalVideoTrack: RTCVideoTrack?
    private var nativeVideoMuted = false
    private var nativeLocalVideoEnabled = false
    private var nativeVideoSessionActive = false
    private weak var nativeVideoConsentAlert: UIAlertController?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        let bridgeController = CAPBridgeViewController()
        window?.rootViewController = bridgeController
        window?.makeKeyAndVisible()
        bridgeController.webView?.configuration.userContentController.add(self, name: "vaultlixCall")
        bridgeController.webView?.configuration.userContentController.addUserScript(WKUserScript(
            source: "window.__vaultlixLocalImageSafety = true; window.__vaultlixNativeVideo = true; window.__vaultlixNativeMediaCompression = true;", injectionTime: .atDocumentStart, forMainFrameOnly: true))

        observers.append(NotificationCenter.default.addObserver(
            forName: .vaultlixVoIPToken, object: nil, queue: .main
        ) { [weak self] note in self?.emit(name: "vaultlix:voip-token", detail: note.userInfo) })
        observers.append(NotificationCenter.default.addObserver(
            forName: .vaultlixCallAction, object: nil, queue: .main
        ) { [weak self] _ in self?.flushPendingCallActions() })
        observers.append(NotificationCenter.default.addObserver(
            forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            VaultlixCallManager.shared.audioRouteDidChange()
            // While iOS is still applying a route the user just chose it
            // reports transient routes (e.g. the headset again mid-switch to
            // Phone), which made the button jump back. The settled route is
            // reported once when the window closes.
            if let until = self?.audioRouteSettlesAt, Date() < until { return }
            self?.emitSpeakerState(success: true)
        })
        observers.append(NotificationCenter.default.addObserver(
            forName: .vaultlixRemoteVideoTrack, object: nil, queue: .main
        ) { [weak self] note in
            guard let self, let track = note.object as? RTCVideoTrack else { return }
            self.nativeRemoteVideoTrack?.remove(self.nativeRemoteVideoView)
            self.nativeRemoteVideoTrack = track
            track.add(self.nativeRemoteVideoView)
        })
        observers.append(NotificationCenter.default.addObserver(
            forName: .vaultlixLocalVideoTrack, object: nil, queue: .main
        ) { [weak self] note in
            guard let self, let track = note.object as? RTCVideoTrack else { return }
            self.nativeLocalVideoTrack?.remove(self.nativeLocalVideoView)
            self.nativeLocalVideoTrack = track
            track.add(self.nativeLocalVideoView)
        })
        observers.append(NotificationCenter.default.addObserver(
            forName: .vaultlixVideoState, object: nil, queue: .main
        ) { [weak self] note in
            let enabled = note.userInfo?["enabled"] as? Bool ?? false
            let remoteOn = note.userInfo?["remoteOn"] as? Bool ?? false
            let waiting = note.userInfo?["waiting"] as? Bool ?? false
            let requested = note.userInfo?["request"] as? Bool ?? false
            let declined = note.userInfo?["declined"] as? Bool ?? false
            if declined {
                self?.hideNativeVideoViews()
                self?.emit(name: "vaultlix:native-video-state", detail: note.userInfo)
                return
            }
            if requested {
                self?.nativeVideoSessionActive = true
                self?.updateNativeVideoPlaceholder(waiting: true)
                self?.showNativeVideoViews(remote: false)
                self?.presentNativeVideoConsentPrompt()
                return
            }
            self?.nativeLocalVideoEnabled = enabled
            if enabled || remoteOn || waiting { self?.nativeVideoSessionActive = true }
            self?.updateNativeVideoPlaceholder(waiting: waiting)
            if self?.nativeVideoSessionActive == true { self?.showNativeVideoViews(remote: remoteOn) }
            self?.nativeLocalVideoView.isHidden = !enabled
            self?.nativeRemoteVideoView.isHidden = !remoteOn
            self?.nativeVideoPausedView.isHidden = remoteOn || self?.nativeVideoSessionActive != true
            self?.updateNativeVideoControls()
            self?.emit(name: "vaultlix:native-video-state", detail: note.userInfo)
        })
        observers.append(NotificationCenter.default.addObserver(
            forName: .vaultlixVideoEnded, object: nil, queue: .main
        ) { [weak self] _ in self?.hideNativeVideoViews() })

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
        }), let url = activity.webpageURL, isVaultlixLink(url) {
            pendingUniversalLink = url
        }
        if let customURL = connectionOptions.urlContexts.first?.url,
           let translated = translatedVaultlixConnectURL(customURL) {
            pendingUniversalLink = translated
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

    private func emitVideoCompression(requestId: String, data: Data? = nil, mime: String? = nil) {
        DispatchQueue.main.async { [weak self] in
            var detail: [String: Any] = ["requestId": requestId, "ok": data != nil]
            if let data, let mime {
                detail["base64"] = data.base64EncodedString()
                detail["mime"] = mime
            }
            self?.emit(name: "vaultlix:video-compression-result", detail: detail)
        }
    }

    private func compressVideoForMessaging(requestId: String, dataURL: String, filename: String) {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self,
                  dataURL.count <= 36_000_000,
                  dataURL.hasPrefix("data:video/"),
                  let marker = dataURL.range(of: ";base64,"),
                  let sourceData = Data(base64Encoded: String(dataURL[marker.upperBound...])),
                  !sourceData.isEmpty, sourceData.count <= 25 * 1024 * 1024 else {
                self?.emitVideoCompression(requestId: requestId)
                return
            }
            let extensionSource = (filename as NSString).pathExtension.lowercased()
            let inputExtension = ["mov", "mp4", "m4v"].contains(extensionSource) ? extensionSource : "mov"
            let inputURL = FileManager.default.temporaryDirectory.appendingPathComponent("vaultlix-compress-\(UUID().uuidString).\(inputExtension)")
            let outputURL = FileManager.default.temporaryDirectory.appendingPathComponent("vaultlix-compress-\(UUID().uuidString).mp4")
            do { try sourceData.write(to: inputURL, options: .atomic) }
            catch { self.emitVideoCompression(requestId: requestId); return }

            let asset = AVURLAsset(url: inputURL)
            let compatible = AVAssetExportSession.exportPresets(compatibleWith: asset)
            let preset = compatible.contains(AVAssetExportPreset1280x720)
                ? AVAssetExportPreset1280x720
                : AVAssetExportPresetMediumQuality
            guard let exporter = AVAssetExportSession(asset: asset, presetName: preset),
                  exporter.supportedFileTypes.contains(.mp4) else {
                try? FileManager.default.removeItem(at: inputURL)
                self.emitVideoCompression(requestId: requestId)
                return
            }
            exporter.outputURL = outputURL
            exporter.outputFileType = .mp4
            exporter.shouldOptimizeForNetworkUse = true
            exporter.exportAsynchronously { [weak self] in
                defer {
                    try? FileManager.default.removeItem(at: inputURL)
                    try? FileManager.default.removeItem(at: outputURL)
                }
                guard exporter.status == .completed,
                      let compressed = try? Data(contentsOf: outputURL),
                      !compressed.isEmpty,
                      compressed.count < sourceData.count,
                      compressed.count <= 25 * 1024 * 1024 else {
                    self?.emitVideoCompression(requestId: requestId)
                    return
                }
                self?.emitVideoCompression(requestId: requestId, data: compressed, mime: "video/mp4")
            }
        }
    }

    private func showNativeVideoViews(remote: Bool) {
        guard let root = window?.rootViewController?.view else { return }
        // Video owns an opaque native canvas. A transparent WebView above the
        // renderer exposed the chat and matrix while video started or paused.
        if nativeVideoBackdropView.superview == nil {
            nativeVideoBackdropView.frame = root.bounds
            nativeVideoBackdropView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            nativeVideoBackdropView.backgroundColor = UIColor(red: 0.12, green: 0.06, blue: 0.09, alpha: 1)
            nativeVideoBackdropView.isUserInteractionEnabled = false
            root.addSubview(nativeVideoBackdropView)
        }
        if nativeRemoteVideoView.superview == nil {
            nativeRemoteVideoView.videoContentMode = .scaleAspectFill
            nativeRemoteVideoView.backgroundColor = .black
            nativeRemoteVideoView.layer.cornerRadius = 0
            nativeRemoteVideoView.clipsToBounds = true
            nativeRemoteVideoView.isUserInteractionEnabled = false
            root.addSubview(nativeRemoteVideoView)
        }
        if nativeLocalVideoView.superview == nil {
            nativeLocalVideoView.videoContentMode = .scaleAspectFill
            nativeLocalVideoView.backgroundColor = UIColor(white: 0.08, alpha: 1)
            nativeLocalVideoView.layer.cornerRadius = 13
            nativeLocalVideoView.clipsToBounds = true
            nativeLocalVideoView.isUserInteractionEnabled = false
            root.addSubview(nativeLocalVideoView)
        }
        installNativeVideoPausedViewIfNeeded(in: root)
        installNativeVideoControlsIfNeeded(in: root)
        let safe = root.safeAreaInsets
        // Remote video is the full call canvas; local video remains a native PiP.
        nativeRemoteVideoView.frame = root.bounds
        nativeLocalVideoView.frame = CGRect(x: root.bounds.width - 112, y: safe.top + 64, width: 96, height: 136)
        nativeRemoteVideoView.isHidden = !remote
        nativeLocalVideoView.isHidden = nativeLocalVideoTrack == nil
        root.bringSubviewToFront(nativeVideoBackdropView)
        root.bringSubviewToFront(nativeRemoteVideoView)
        nativeVideoPausedView.isHidden = remote
        if !remote { root.bringSubviewToFront(nativeVideoPausedView) }
        root.bringSubviewToFront(nativeLocalVideoView)
        root.bringSubviewToFront(nativeVideoControlsView)
        updateNativeVideoControls()
    }

    private func installNativeVideoPausedViewIfNeeded(in root: UIView) {
        guard nativeVideoPausedView.superview == nil else { return }
        nativeVideoPausedView.frame = root.bounds
        nativeVideoPausedView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        nativeVideoPausedView.backgroundColor = UIColor(red: 0.12, green: 0.06, blue: 0.09, alpha: 1)
        nativeVideoPausedView.isUserInteractionEnabled = false

        nativeVideoPausedIcon.image = UIImage(systemName: "video.slash.fill")
        nativeVideoPausedIcon.tintColor = UIColor.white.withAlphaComponent(0.82)
        nativeVideoPausedIcon.contentMode = .scaleAspectFit
        nativeVideoPausedIcon.translatesAutoresizingMaskIntoConstraints = false
        nativeVideoPausedIcon.widthAnchor.constraint(equalToConstant: 42).isActive = true
        nativeVideoPausedIcon.heightAnchor.constraint(equalToConstant: 42).isActive = true

        nativeVideoPausedLabel.text = "Video paused"
        nativeVideoPausedLabel.textColor = UIColor.white.withAlphaComponent(0.9)
        nativeVideoPausedLabel.font = .systemFont(ofSize: 17, weight: .semibold)
        nativeVideoPausedLabel.textAlignment = .center

        let stack = UIStackView(arrangedSubviews: [nativeVideoPausedIcon, nativeVideoPausedLabel])
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        nativeVideoPausedView.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: nativeVideoPausedView.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: nativeVideoPausedView.centerYAnchor, constant: -20),
        ])
        root.addSubview(nativeVideoPausedView)
    }

    private func updateNativeVideoPlaceholder(waiting: Bool) {
        nativeVideoPausedIcon.image = UIImage(systemName: waiting ? "video.fill" : "video.slash.fill")
        nativeVideoPausedLabel.text = waiting ? "Connecting video…" : "Video paused"
    }

    private func presentNativeVideoConsentPrompt() {
        guard nativeVideoConsentAlert == nil,
              let root = window?.rootViewController else { return }
        let alert = UIAlertController(
            title: "Switch to video?",
            message: "Your contact wants to turn on video. Turn on your camera?",
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "Not now", style: .cancel) { [weak self] _ in
            self?.nativeVideoConsentAlert = nil
            VaultlixCallManager.shared.respondToVideoRequestFromWeb(roomCode: "", accepted: false) { _ in }
            self?.hideNativeVideoViews()
        })
        alert.addAction(UIAlertAction(title: "Turn on camera", style: .default) { [weak self] _ in
            self?.nativeVideoConsentAlert = nil
            VaultlixCallManager.shared.respondToVideoRequestFromWeb(roomCode: "", accepted: true) { success in
                guard !success else { return }
                self?.hideNativeVideoViews()
                self?.emit(name: "vaultlix:native-video-state", detail: ["success": false])
            }
        })
        nativeVideoConsentAlert = alert
        var presenter = root
        while let presented = presenter.presentedViewController { presenter = presented }
        presenter.present(alert, animated: true)
    }

    private func installNativeVideoControlsIfNeeded(in root: UIView) {
        guard nativeVideoControlsView.superview == nil else { return }
        nativeVideoControlsView.layer.cornerRadius = 30
        nativeVideoControlsView.clipsToBounds = true
        nativeVideoControlsView.autoresizingMask = [.flexibleWidth, .flexibleTopMargin]
        nativeVideoControlsView.frame = CGRect(
            x: 14,
            y: root.bounds.height - root.safeAreaInsets.bottom - 82,
            width: root.bounds.width - 28,
            height: 66
        )

        configureNativeVideoButton(nativeMuteButton, title: "Mute", symbol: "mic.fill", action: #selector(toggleNativeVideoMute))
        configureNativeVideoButton(nativeRouteButton, title: "Audio", symbol: "speaker.wave.2.fill", action: #selector(cycleNativeVideoRoute))
        configureNativeVideoButton(nativeCameraButton, title: "Video", symbol: "video.fill", action: #selector(toggleNativeVideoCamera))
        configureNativeVideoButton(nativeFlipButton, title: "Flip", symbol: "arrow.triangle.2.circlepath.camera.fill", action: #selector(flipNativeVideoCamera))
        configureNativeVideoButton(nativeEndButton, title: "End", symbol: "phone.down.fill", action: #selector(endNativeVideoCall))
        nativeEndButton.tintColor = UIColor(red: 0.95, green: 0.30, blue: 0.40, alpha: 1)

        let stack = UIStackView(arrangedSubviews: [
            nativeMuteButton, nativeRouteButton, nativeCameraButton, nativeFlipButton, nativeEndButton,
        ])
        stack.axis = .horizontal
        stack.alignment = .fill
        stack.distribution = .fillEqually
        stack.translatesAutoresizingMaskIntoConstraints = false
        nativeVideoControlsView.contentView.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: nativeVideoControlsView.contentView.leadingAnchor, constant: 6),
            stack.trailingAnchor.constraint(equalTo: nativeVideoControlsView.contentView.trailingAnchor, constant: -6),
            stack.topAnchor.constraint(equalTo: nativeVideoControlsView.contentView.topAnchor, constant: 4),
            stack.bottomAnchor.constraint(equalTo: nativeVideoControlsView.contentView.bottomAnchor, constant: -4),
        ])
        root.addSubview(nativeVideoControlsView)
    }

    private func configureNativeVideoButton(_ button: UIButton, title: String, symbol: String, action: Selector) {
        var configuration = UIButton.Configuration.plain()
        configuration.image = UIImage(systemName: symbol)
        configuration.title = title
        configuration.imagePlacement = .top
        configuration.imagePadding = 3
        configuration.baseForegroundColor = .white
        configuration.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { incoming in
            var outgoing = incoming
            outgoing.font = .systemFont(ofSize: 10, weight: .medium)
            return outgoing
        }
        button.configuration = configuration
        button.addTarget(self, action: action, for: .touchUpInside)
    }

    private func updateNativeVideoControls() {
        let muteSymbol = nativeVideoMuted ? "mic.slash.fill" : "mic.fill"
        nativeMuteButton.configuration?.image = UIImage(systemName: muteSymbol)
        nativeMuteButton.configuration?.title = nativeVideoMuted ? "Unmute" : "Mute"
        nativeCameraButton.configuration?.image = UIImage(systemName: nativeLocalVideoEnabled ? "video.slash.fill" : "video.fill")
        nativeCameraButton.configuration?.title = nativeLocalVideoEnabled ? "Stop" : "Video"
        let route = VaultlixCallManager.shared.currentAudioRoute()
        nativeRouteButton.configuration?.image = UIImage(systemName:
            route == "bluetooth" ? "airpodspro" : (route == "speaker" ? "speaker.wave.3.fill" : "iphone"))
        nativeRouteButton.configuration?.title = route == "bluetooth" ? "Bluetooth" : (route == "speaker" ? "Speaker" : "Phone")
    }

    @objc private func toggleNativeVideoMute() {
        nativeVideoMuted.toggle()
        VaultlixCallManager.shared.setMutedFromWeb(roomCode: "", muted: nativeVideoMuted)
        updateNativeVideoControls()
    }

    @objc private func cycleNativeVideoRoute() {
        let manager = VaultlixCallManager.shared
        let current = manager.currentAudioRoute()
        let next: String
        if manager.isBluetoothAudioAvailable() {
            next = current == "bluetooth" ? "speaker" : (current == "speaker" ? "phone" : "bluetooth")
        } else {
            next = current == "speaker" ? "phone" : "speaker"
        }
        _ = manager.setAudioRoute(next)
        updateNativeVideoControls()
    }

    @objc private func toggleNativeVideoCamera() {
        let desired = !nativeLocalVideoEnabled
        // The engine publishes the authoritative state after consent and
        // camera startup complete. Do not optimistically flip the button:
        // a request that is still waiting for the peer is not yet live video.
        VaultlixCallManager.shared.setVideoFromWeb(roomCode: "", enabled: desired) { _ in }
    }

    @objc private func flipNativeVideoCamera() {
        VaultlixCallManager.shared.switchCameraFromWeb(roomCode: "") { _ in }
    }

    @objc private func endNativeVideoCall() {
        VaultlixCallManager.shared.endActiveNativeCall()
    }

    private func hideNativeVideoViews() {
        nativeVideoConsentAlert?.dismiss(animated: false)
        nativeVideoConsentAlert = nil
        if let track = nativeRemoteVideoTrack { track.remove(nativeRemoteVideoView) }
        if let track = nativeLocalVideoTrack { track.remove(nativeLocalVideoView) }
        nativeRemoteVideoTrack = nil
        nativeLocalVideoTrack = nil
        nativeRemoteVideoView.removeFromSuperview()
        nativeLocalVideoView.removeFromSuperview()
        nativeVideoBackdropView.removeFromSuperview()
        nativeVideoPausedView.removeFromSuperview()
        nativeVideoControlsView.removeFromSuperview()
        nativeVideoMuted = false
        nativeLocalVideoEnabled = false
        nativeVideoSessionActive = false
    }

    private func flushPendingCallActions() {
        // NativeWebRTCCallEngine sends answer/decline/hang-up acknowledgements
        // itself while the device is locked. These queued actions are only
        // for mirroring native state into the WebView UI. Evaluating JS while
        // WKWebView is background-suspended can report no useful error yet
        // discard the event; consuming it here permanently loses rows such as
        // "Missed call". Keep the queue intact until the scene is foreground.
        guard webReady,
              window?.windowScene?.activationState == .foregroundActive else { return }
        for action in VaultlixCallManager.shared.consumePendingActions() {
            emit(name: "vaultlix:call-action", detail: action)
            // A locked/background call can activate the scene before the
            // encrypted room list is restored. Missed events are additive and
            // carry a stable call ID, so replay only those across the short
            // startup window. The web client deduplicates the history row.
            if (action["action"] as? String) == "missed" {
                for delay in [2.0, 5.0, 9.0] {
                    DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                        guard let self,
                              self.window?.windowScene?.activationState == .foregroundActive else { return }
                        self.emit(name: "vaultlix:call-action", detail: action)
                    }
                }
            }
        }
    }

    /// `routeOverride` is the route just requested. Choosing a Bluetooth or
    /// phone input moves the output a moment after the call returns, so the
    /// immediate reading can still show the old one; the route-change
    /// notification emits again with the real route once it settles.
    private func emitSpeakerState(success: Bool, routeOverride: String? = nil) {
        let manager = VaultlixCallManager.shared
        let route = (success ? routeOverride : nil) ?? manager.currentAudioRoute()
        emit(name: "vaultlix:call-audio-route", detail: [
            "available": true,
            "speakerOn": route == "speaker",
            "route": route,
            "bluetoothAvailable": manager.isBluetoothAudioAvailable(),
            "success": success,
        ])
    }

    private func topViewController(from controller: UIViewController?) -> UIViewController? {
        if let navigation = controller as? UINavigationController {
            return topViewController(from: navigation.visibleViewController)
        }
        if let tabs = controller as? UITabBarController {
            return topViewController(from: tabs.selectedViewController)
        }
        if let presented = controller?.presentedViewController {
            return topViewController(from: presented)
        }
        return controller
    }

    private func presentShareImage(_ fileURL: URL) {
        guard let presenter = topViewController(from: window?.rootViewController),
              presenter.viewIfLoaded?.window != nil else {
            emit(name: "vaultlix:share-image-failed", detail: [:])
            return
        }
        if presenter is UIActivityViewController {
            emit(name: "vaultlix:share-image-presented", detail: [:])
            return
        }
        let sheet = UIActivityViewController(activityItems: [fileURL], applicationActivities: nil)
        sheet.completionWithItemsHandler = { [weak self] _, _, _, _ in
            // The prepared private-number card is deliberately retained for
            // instant repeat sharing. Conversation media uses unique URLs and
            // must be removed as soon as the receiving activity finishes.
            guard self?.preparedShareImageURL != fileURL else { return }
            try? FileManager.default.removeItem(at: fileURL)
        }
        if let popover = sheet.popoverPresentationController {
            popover.sourceView = presenter.view
            popover.sourceRect = CGRect(x: presenter.view.bounds.midX, y: presenter.view.bounds.midY, width: 1, height: 1)
        }
        presenter.present(sheet, animated: true) { [weak self] in
            self?.emit(name: "vaultlix:share-image-presented", detail: [:])
        }
    }

    private func presentSaveFile(_ fileURL: URL) {
        guard let presenter = topViewController(from: window?.rootViewController),
              presenter.viewIfLoaded?.window != nil else {
            try? FileManager.default.removeItem(at: fileURL)
            emit(name: "vaultlix:share-image-failed", detail: [:])
            return
        }
        let picker = UIDocumentPickerViewController(forExporting: [fileURL], asCopy: true)
        picker.delegate = self
        pendingDocumentExportURL = fileURL
        presenter.present(picker, animated: true)
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        clearPendingDocumentExport()
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        clearPendingDocumentExport()
    }

    private func clearPendingDocumentExport() {
        guard let fileURL = pendingDocumentExportURL else { return }
        pendingDocumentExportURL = nil
        try? FileManager.default.removeItem(at: fileURL)
    }

    private func presentOpenFile(_ fileURL: URL) {
        guard let presenter = topViewController(from: window?.rootViewController),
              presenter.viewIfLoaded?.window != nil else {
            try? FileManager.default.removeItem(at: fileURL)
            emit(name: "vaultlix:share-image-failed", detail: [:])
            return
        }
        let controller = UIDocumentInteractionController(url: fileURL)
        controller.delegate = self
        documentInteractionController = controller
        pendingOpenFileURL = fileURL
        if !controller.presentOpenInMenu(from: presenter.view.bounds, in: presenter.view, animated: true) {
            clearPendingOpenFile()
        }
    }

    func documentInteractionControllerDidDismissOpenInMenu(_ controller: UIDocumentInteractionController) {
        clearPendingOpenFile()
    }

    private func clearPendingOpenFile() {
        if let fileURL = pendingOpenFileURL { try? FileManager.default.removeItem(at: fileURL) }
        pendingOpenFileURL = nil
        documentInteractionController = nil
    }

    private func setDocumentPreviewOpen(_ open: Bool) {
        AppDelegate.allowsDocumentRotation = open
        guard let windowScene = window?.windowScene else { return }
        if #available(iOS 16.0, *) {
            window?.rootViewController?.setNeedsUpdateOfSupportedInterfaceOrientations()
            let orientations: UIInterfaceOrientationMask = (open || UIDevice.current.userInterfaceIdiom == .pad)
                ? [.portrait, .landscapeLeft, .landscapeRight]
                : .portrait
            windowScene.requestGeometryUpdate(.iOS(interfaceOrientations: orientations))
        } else {
            UIViewController.attemptRotationToDeviceOrientation()
        }
    }

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard message.name == "vaultlixCall",
              let body = message.body as? [String: Any],
              let action = body["action"] as? String else { return }
        if action == "screenImage" {
            guard message.frameInfo.isMainFrame,
                  message.frameInfo.securityOrigin.host == "vaultlix.com",
                  let requestId = body["requestId"] as? String, requestId.count <= 80,
                  let base64 = body["base64"] as? String else { return }
            LocalImageSafety.shared.check(base64: base64) { [weak self] status in
                self?.emit(name: "vaultlix:image-safety-result", detail: ["requestId": requestId, "status": status])
            }
            return
        }
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
        if action == "setDocumentPreviewOpen" {
            setDocumentPreviewOpen(body["open"] as? Bool ?? false)
            return
        }
        if action == "compressVideo" {
            guard message.frameInfo.isMainFrame,
                  message.frameInfo.securityOrigin.host == "vaultlix.com",
                  let requestId = body["requestId"] as? String,
                  requestId.count <= 80,
                  let dataURL = body["dataUrl"] as? String else { return }
            compressVideoForMessaging(
                requestId: requestId,
                dataURL: dataURL,
                filename: (body["filename"] as? String) ?? "vaultlix-video.mov"
            )
            return
        }
        if action == "authenticateSensitiveAction" {
            // Acknowledge support before LocalAuthentication presents its
            // system sheet. The web UI uses this to distinguish a real
            // in-progress Face ID/passcode check from an older app build
            // that has the shared bridge but does not know this action.
            emit(name: "vaultlix:device-auth-result", detail: ["pending": true, "available": true])
            let context = LAContext()
            var policyError: NSError?
            guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &policyError) else {
                emit(name: "vaultlix:device-auth-result", detail: ["ok": false, "available": false])
                return
            }
            let reason = (body["reason"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            let promptReason = (reason?.isEmpty == false ? reason : nil) ?? "Open your Vaultlix recovery code"
            context.evaluatePolicy(
                .deviceOwnerAuthentication,
                localizedReason: promptReason
            ) { [weak self] success, _ in
                DispatchQueue.main.async {
                    self?.emit(name: "vaultlix:device-auth-result", detail: ["ok": success, "available": true])
                }
            }
            return
        }
        if action == "prepareShareImage" {
            guard let dataURL = body["dataUrl"] as? String,
                  dataURL.hasPrefix("data:image/png;base64,"),
                  dataURL.count <= 12_000_000,
                  let comma = dataURL.firstIndex(of: ","),
                  let data = Data(base64Encoded: String(dataURL[dataURL.index(after: comma)...])),
                  !data.isEmpty, data.count <= 8_000_000 else {
                emit(name: "vaultlix:share-image-failed", detail: [:])
                return
            }
            let fileURL = FileManager.default.temporaryDirectory.appendingPathComponent("vaultlix-private-number.png")
            do {
                try data.write(to: fileURL, options: .atomic)
                preparedShareImageURL = fileURL
                emit(name: "vaultlix:share-image-ready", detail: [:])
            } catch { emit(name: "vaultlix:share-image-failed", detail: [:]) }
            return
        }
        if action == "sharePreparedImage" {
            guard let fileURL = preparedShareImageURL else {
                emit(name: "vaultlix:share-image-failed", detail: [:])
                return
            }
            presentShareImage(fileURL)
            return
        }
        if action == "shareImage" {
            guard let dataURL = body["dataUrl"] as? String,
                  dataURL.hasPrefix("data:image/png;base64,"),
                  dataURL.count <= 12_000_000,
                  let comma = dataURL.firstIndex(of: ","),
                  let data = Data(base64Encoded: String(dataURL[dataURL.index(after: comma)...])),
                  !data.isEmpty, data.count <= 8_000_000 else {
                emit(name: "vaultlix:share-image-failed", detail: [:])
                return
            }
            let fileURL = FileManager.default.temporaryDirectory.appendingPathComponent("vaultlix-private-number.png")
            do {
                try data.write(to: fileURL, options: .atomic)
                preparedShareImageURL = fileURL
                presentShareImage(fileURL)
            } catch { emit(name: "vaultlix:share-image-failed", detail: [:]) }
            return
        }
        if action == "shareMedia" {
            guard let dataURL = body["dataUrl"] as? String,
                  dataURL.hasPrefix("data:"),
                  dataURL.count <= 36_000_000,
                  let marker = dataURL.range(of: ";base64,"),
                  marker.lowerBound > dataURL.index(dataURL.startIndex, offsetBy: 5),
                  let data = Data(base64Encoded: String(dataURL[marker.upperBound...])),
                  !data.isEmpty, data.count <= 25 * 1024 * 1024 else {
                emit(name: "vaultlix:share-image-failed", detail: [:])
                return
            }
            let requested = (body["filename"] as? String) ?? "vaultlix-file"
            let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "._- "))
            let safeName = requested.unicodeScalars.map { allowed.contains($0) ? String($0) : "_" }.joined()
            let filename = safeName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "vaultlix-file" : safeName
            let fileURL = FileManager.default.temporaryDirectory
                .appendingPathComponent("vaultlix-\(UUID().uuidString)-\(filename)")
            do {
                try data.write(to: fileURL, options: .atomic)
                presentShareImage(fileURL)
            } catch { emit(name: "vaultlix:share-image-failed", detail: [:]) }
            return
        }
        if action == "saveMedia" {
            guard let dataURL = body["dataUrl"] as? String,
                  dataURL.hasPrefix("data:"),
                  dataURL.count <= 36_000_000,
                  let marker = dataURL.range(of: ";base64,"),
                  marker.lowerBound > dataURL.index(dataURL.startIndex, offsetBy: 5),
                  let data = Data(base64Encoded: String(dataURL[marker.upperBound...])),
                  !data.isEmpty, data.count <= 25 * 1024 * 1024 else {
                emit(name: "vaultlix:share-image-failed", detail: [:])
                return
            }
            let requested = (body["filename"] as? String) ?? "vaultlix-file"
            let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "._- "))
            let safeName = requested.unicodeScalars.map { allowed.contains($0) ? String($0) : "_" }.joined()
            let filename = safeName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "vaultlix-file" : safeName
            let fileURL = FileManager.default.temporaryDirectory
                .appendingPathComponent("vaultlix-save-\(UUID().uuidString)-\(filename)")
            do {
                try data.write(to: fileURL, options: .atomic)
                presentSaveFile(fileURL)
            } catch { emit(name: "vaultlix:share-image-failed", detail: [:]) }
            return
        }
        if action == "openMedia" {
            guard let dataURL = body["dataUrl"] as? String,
                  dataURL.hasPrefix("data:"),
                  dataURL.count <= 36_000_000,
                  let marker = dataURL.range(of: ";base64,"),
                  marker.lowerBound > dataURL.index(dataURL.startIndex, offsetBy: 5),
                  let data = Data(base64Encoded: String(dataURL[marker.upperBound...])),
                  !data.isEmpty, data.count <= 25 * 1024 * 1024 else {
                emit(name: "vaultlix:share-image-failed", detail: [:])
                return
            }
            let requested = (body["filename"] as? String) ?? "vaultlix-file"
            let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "._- "))
            let safeName = requested.unicodeScalars.map { allowed.contains($0) ? String($0) : "_" }.joined()
            let filename = safeName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "vaultlix-file" : safeName
            let fileURL = FileManager.default.temporaryDirectory
                .appendingPathComponent("vaultlix-open-\(UUID().uuidString)-\(filename)")
            do {
                try data.write(to: fileURL, options: .atomic)
                presentOpenFile(fileURL)
            } catch { emit(name: "vaultlix:share-image-failed", detail: [:]) }
            return
        }
        if action == "emergencyReset" {
            UNUserNotificationCenter.current().removeAllDeliveredNotifications()
            UNUserNotificationCenter.current().removeAllPendingNotificationRequests()
            VaultlixCallManager.shared.endAllCalls()
            _ = SecureMessageStore.shared.clearAll()
            clearPendingDocumentExport()
            clearPendingOpenFile()
            return
        }
        if action == "secureStoreMessage",
           let conversationID = body["conversationId"] as? String,
           let messageID = body["messageId"] as? String,
           let plaintext = body["plaintext"] as? String {
            _ = SecureMessageStore.shared.put(conversationID: conversationID, messageID: messageID,
                                              plaintext: plaintext, createdAt: body["createdAt"] as? Int64 ?? Int64(Date().timeIntervalSince1970 * 1000))
            return
        }
        if action == "secureDeleteMessage",
           let conversationID = body["conversationId"] as? String,
           let messageID = body["messageId"] as? String {
            _ = SecureMessageStore.shared.delete(conversationID: conversationID, messageID: messageID)
            return
        }
        if action == "secureClearConversation",
           let conversationID = body["conversationId"] as? String {
            _ = SecureMessageStore.shared.clear(conversationID: conversationID)
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
           let inviteID = body["inviteId"] as? String,
           roomHandle.range(of: "^[A-Za-z0-9_-]{16,64}$", options: .regularExpression) != nil,
           inviteID.range(of: "^[A-Za-z0-9-]{16,64}$", options: .regularExpression) != nil,
           code.count <= 128 {
            // A JavaScript blur is not sufficient on every iOS release: the
            // system InputUI process can remain attached while CallKit takes
            // its first snapshot, leaving the message keyboard over the call
            // screen. End editing at the native window/WebView boundary and
            // give UIKit one dismissal animation window before presentation.
            window?.endEditing(true)
            (window?.rootViewController as? CAPBridgeViewController)?.webView?.endEditing(true)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in
                VaultlixCallManager.shared.startOutgoingCall(
                    roomHandle: roomHandle, code: code, caller: caller, peer: peer,
                    inviteID: inviteID, video: body["video"] as? Bool ?? false
                ) { success in
                    if !success {
                        self?.emit(name: "vaultlix:call-action", detail: [
                            "action": "microphoneDenied", "code": code,
                        ])
                    }
                }
            }
            return
        }
        if action == "setMuted",
           let code = body["code"] as? String,
           let muted = body["muted"] as? Bool, code.count <= 128 {
            VaultlixCallManager.shared.setMutedFromWeb(roomCode: code, muted: muted)
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
        if action == "setAudioRoute",
           let route = body["route"] as? String,
           ["phone", "bluetooth", "speaker"].contains(route) {
            let success = VaultlixCallManager.shared.setAudioRoute(
                route,
                activateSession: body["outgoing"] as? Bool ?? false
            )
            emitSpeakerState(success: success, routeOverride: route)
            let settleDelay = 0.7
            audioRouteSettlesAt = Date().addingTimeInterval(settleDelay)
            DispatchQueue.main.asyncAfter(deadline: .now() + settleDelay + 0.05) { [weak self] in
                self?.emitSpeakerState(success: true)
            }
            return
        }
        if action == "setVideo",
           let code = body["code"] as? String,
           let enabled = body["enabled"] as? Bool {
            VaultlixCallManager.shared.setVideoFromWeb(roomCode: code, enabled: enabled) { [weak self] success in
                self?.emit(name: "vaultlix:native-video-state", detail: ["enabled": enabled && success, "success": success])
            }
            return
        }
        if action == "switchCamera",
           let code = body["code"] as? String {
            VaultlixCallManager.shared.switchCameraFromWeb(roomCode: code) { [weak self] success in
                self?.emit(name: "vaultlix:native-camera-switched", detail: ["success": success])
            }
            return
        }
        if action == "respondVideo",
           let code = body["code"] as? String,
           let accepted = body["accepted"] as? Bool {
            VaultlixCallManager.shared.respondToVideoRequestFromWeb(roomCode: code, accepted: accepted) { [weak self] success in
                if !success { self?.emit(name: "vaultlix:native-video-state", detail: ["success": false]) }
            }
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
        VaultlixCallManager.shared.endCallFromWeb(
            roomCode: code,
            outcome: body["reason"] as? String ?? "ended"
        )
        VaultlixCallManager.shared.releaseOutgoingWebAudio()
    }

    deinit {
        (window?.rootViewController as? CAPBridgeViewController)?
            .webView?.configuration.userContentController.removeScriptMessageHandler(forName: "vaultlixCall")
        observers.forEach(NotificationCenter.default.removeObserver)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
        if let url = URLContexts.first?.url,
           let translated = translatedVaultlixConnectURL(url) {
            pendingUniversalLink = translated
            flushPendingUniversalLink()
        }
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
        if userActivity.activityType == NSUserActivityTypeBrowsingWeb,
           let url = userActivity.webpageURL,
           isVaultlixLink(url) {
            pendingUniversalLink = url
            flushPendingUniversalLink()
        }
    }

    private func isVaultlixLink(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "https",
              url.host?.lowercased() == "vaultlix.com" else { return false }
        return url.path.range(of: "^/join/[A-Za-z0-9-]+/?$", options: .regularExpression) != nil
            || url.path.range(of: "^/p/[A-HJ-NP-Za-hj-np-z2-9]{6}/?$", options: .regularExpression) != nil
            || url.path.range(of: "^/[A-Za-z0-9][A-Za-z0-9._-]{2,30}[A-Za-z0-9]/?$", options: .regularExpression) != nil
    }

    private func translatedVaultlixConnectURL(_ url: URL) -> URL? {
        guard url.scheme?.lowercased() == "vaultlix",
              url.path.range(of: "^/[2-9][0-9]{5,9}/?$", options: .regularExpression) != nil else { return nil }
        if url.host?.lowercased() == "connect" {
            return URL(string: "https://vaultlix.com\(url.path)?ref=qr")
        }
        if url.host?.lowercased() == "recover",
           let fragment = url.fragment,
           fragment.range(of: "^k=[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil {
            let privateNumber = url.path.replacingOccurrences(of: "/", with: "")
            return URL(string: "https://vaultlix.com/?recover=\(privateNumber)#\(fragment)")
        }
        return nil
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

    private func showAppSwitcherPrivacyCover() {
        guard appSwitcherPrivacyCover == nil, let window else { return }

        let cover = UIView(frame: window.bounds)
        cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        cover.backgroundColor = UIColor(red: 36 / 255, green: 27 / 255, blue: 30 / 255, alpha: 1)
        cover.isAccessibilityElement = true
        cover.accessibilityLabel = "Vaultlix content hidden"

        let wordmark = UILabel()
        wordmark.translatesAutoresizingMaskIntoConstraints = false
        wordmark.text = "Vaultlix"
        wordmark.textColor = UIColor(red: 248 / 255, green: 241 / 255, blue: 234 / 255, alpha: 1)
        wordmark.font = UIFont(name: "Georgia", size: 30) ?? .systemFont(ofSize: 30, weight: .light)
        wordmark.textAlignment = .center
        cover.addSubview(wordmark)
        NSLayoutConstraint.activate([
            wordmark.centerXAnchor.constraint(equalTo: cover.centerXAnchor),
            wordmark.centerYAnchor.constraint(equalTo: cover.centerYAnchor),
        ])

        window.addSubview(cover)
        window.bringSubviewToFront(cover)
        appSwitcherPrivacyCover = cover
    }

    private func hideAppSwitcherPrivacyCover() {
        appSwitcherPrivacyCover?.removeFromSuperview()
        appSwitcherPrivacyCover = nil
    }

    func sceneWillResignActive(_ scene: UIScene) {
        showAppSwitcherPrivacyCover()
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        hideAppSwitcherPrivacyCover()
        VaultlixCallManager.shared.enforceCallKeyboardGuard()
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
