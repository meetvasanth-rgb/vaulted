import UIKit
import UniformTypeIdentifiers
import CryptoKit
import CommonCrypto
import ImageIO
import AVFoundation

final class ShareViewController: UIViewController {
    private struct PreparedAttachment {
        let name: String
        let mime: String
        let data: Data
        let imagePreview: String?
        let videoThumb: String?
        var isImage: Bool { mime.hasPrefix("image/") }
    }
    private struct ProviderInput { let provider: NSItemProvider; let type: UTType; let identifier: String }
    private struct AppLockConfig { let salt: Data; let verifier: Data; let iterations: Int; let passcodeLength: Int }
    private enum ShareFailure: LocalizedError {
        case message(String)
        var errorDescription: String? { if case .message(let value) = self { return value }; return nil }
    }

    private let appGroup = "group.com.vaultlix.app"
    private let appLockKey = "vaultlix.share.app-lock.v1"
    private let appLockFailureKey = "vaultlix.share.app-lock-failures.v1"
    private let maximumSourceBytes = 25 * 1024 * 1024
    private let maximumEncryptedBytes = 48 * 1024 * 1024
    private var started = false
    private var preparedAttachments: [PreparedAttachment] = []
    private var rooms: [NativeCallRoom] = []
    private var selectedRoomIndex: Int?

    private let titleLabel = UILabel()
    private let statusLabel = UILabel()
    private let passcodeField = UITextField()
    private let unlockButton = UIButton(type: .system)
    private let passcodeStack = UIStackView()
    private let recipientsStack = UIStackView()
    private let recipientsScroll = UIScrollView()
    private var recipientsHeightConstraint: NSLayoutConstraint?
    private let sendButton = UIButton(type: .system)
    private let activity = UIActivityIndicatorView(style: .medium)

    override func viewDidLoad() {
        super.viewDidLoad()
        preferredContentSize = UIScreen.main.bounds.size
        buildInterface()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        preferredContentSize = UIScreen.main.bounds.size
        if #available(iOS 15.0, *), let sheet = sheetPresentationController {
            sheet.detents = [.large()]
            sheet.selectedDetentIdentifier = .large
            sheet.prefersGrabberVisible = false
        }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !started else { return }
        started = true
        prepareAttachments()
    }

    private func buildInterface() {
        view.backgroundColor = .systemBackground
        let mark = UILabel()
        mark.text = "🔒"
        mark.font = .systemFont(ofSize: 40)
        mark.textAlignment = .center
        titleLabel.text = "Share with Vaultlix"
        titleLabel.font = .systemFont(ofSize: 24, weight: .bold)
        titleLabel.textAlignment = .center
        statusLabel.text = "Preparing your attachment securely…"
        statusLabel.font = .systemFont(ofSize: 15)
        statusLabel.textColor = .secondaryLabel
        statusLabel.numberOfLines = 0
        statusLabel.textAlignment = .center

        passcodeField.placeholder = "App Lock password"
        passcodeField.isSecureTextEntry = true
        passcodeField.keyboardType = .numberPad
        passcodeField.textContentType = .oneTimeCode
        passcodeField.autocorrectionType = .no
        passcodeField.spellCheckingType = .no
        passcodeField.borderStyle = .roundedRect
        passcodeField.font = .systemFont(ofSize: 19)
        passcodeField.textAlignment = .center
        passcodeField.heightAnchor.constraint(equalToConstant: 48).isActive = true
        passcodeField.addTarget(self, action: #selector(passcodeChanged), for: .editingChanged)

        configurePrimaryButton(unlockButton, title: "Unlock")
        unlockButton.addTarget(self, action: #selector(unlockShare), for: .touchUpInside)
        unlockButton.isEnabled = false
        passcodeStack.axis = .vertical
        passcodeStack.spacing = 12
        passcodeStack.addArrangedSubview(passcodeField)
        passcodeStack.addArrangedSubview(unlockButton)
        passcodeStack.isHidden = true

        recipientsStack.axis = .vertical
        recipientsStack.spacing = 0
        recipientsStack.translatesAutoresizingMaskIntoConstraints = false
        recipientsScroll.addSubview(recipientsStack)
        let recipientsHeightConstraint = recipientsScroll.heightAnchor.constraint(equalToConstant: 58)
        // UIStackView temporarily constrains hidden arranged subviews to zero.
        // Keep this just below required priority so hiding the chooser does not
        // produce an Auto Layout conflict while still giving UIScrollView the
        // explicit visible height it cannot infer from its content layout guide.
        recipientsHeightConstraint.priority = .defaultHigh
        self.recipientsHeightConstraint = recipientsHeightConstraint
        NSLayoutConstraint.activate([
            recipientsStack.leadingAnchor.constraint(equalTo: recipientsScroll.contentLayoutGuide.leadingAnchor),
            recipientsStack.trailingAnchor.constraint(equalTo: recipientsScroll.contentLayoutGuide.trailingAnchor),
            recipientsStack.topAnchor.constraint(equalTo: recipientsScroll.contentLayoutGuide.topAnchor),
            recipientsStack.bottomAnchor.constraint(equalTo: recipientsScroll.contentLayoutGuide.bottomAnchor),
            recipientsStack.widthAnchor.constraint(equalTo: recipientsScroll.frameLayoutGuide.widthAnchor),
            recipientsHeightConstraint,
            recipientsScroll.heightAnchor.constraint(lessThanOrEqualToConstant: max(116, UIScreen.main.bounds.height - 300)),
        ])
        recipientsScroll.layer.borderColor = UIColor.separator.cgColor
        recipientsScroll.layer.borderWidth = 0.5
        recipientsScroll.layer.cornerRadius = 14
        recipientsScroll.isHidden = true

        configurePrimaryButton(sendButton, title: "Send")
        sendButton.addTarget(self, action: #selector(sendToSelectedRecipient), for: .touchUpInside)
        sendButton.isEnabled = false
        sendButton.alpha = 0.45
        sendButton.isHidden = true

        let cancel = UIButton(type: .system)
        cancel.setTitle("Cancel", for: .normal)
        cancel.addTarget(self, action: #selector(cancelShare), for: .touchUpInside)
        activity.hidesWhenStopped = true

        let stack = UIStackView(arrangedSubviews: [mark, titleLabel, statusLabel, activity, passcodeStack, recipientsScroll, sendButton, cancel])
        stack.axis = .vertical
        stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 24),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -18),
        ])
    }

    private func configurePrimaryButton(_ button: UIButton, title: String) {
        button.setTitle(title, for: .normal)
        button.titleLabel?.font = .systemFont(ofSize: 17, weight: .semibold)
        button.backgroundColor = UIColor(red: 104/255, green: 44/255, blue: 67/255, alpha: 1)
        button.tintColor = .white
        button.layer.cornerRadius = 14
        button.heightAnchor.constraint(equalToConstant: 50).isActive = true
    }

    private func prepareAttachments() {
        let providers = Array((extensionContext?.inputItems as? [NSExtensionItem] ?? [])
            .flatMap { $0.attachments ?? [] }
            .compactMap(providerInput)
            .prefix(10))
        guard !providers.isEmpty else { showFailure("No supported photo, video, or file was selected."); return }
        var loaded: [(Int, PreparedAttachment)] = []

        // Share extensions have a much smaller memory budget than the main app.
        // Process one provider at a time so selecting several modern camera
        // photos cannot retain several compressed sources/thumbnails together.
        func loadProvider(at index: Int) {
            guard providers.indices.contains(index) else {
                self.preparedAttachments = loaded.sorted { $0.0 < $1.0 }.map(\.1)
                guard !self.preparedAttachments.isEmpty else { self.showFailure("The selected attachment could not be read or was larger than 25 MB."); return }
                if let config = self.loadAppLockConfig() { self.showAppLock(config) } else { self.showRecipients() }
                return
            }
            let input = providers[index]
            input.provider.loadDataRepresentation(forTypeIdentifier: input.identifier) { data, _ in
                let prepared: PreparedAttachment? = autoreleasepool {
                    guard let data, !data.isEmpty, data.count <= self.maximumSourceBytes else { return nil }
                    if input.type.conforms(to: .image) {
                        return self.optimizedImage(data, sourceName: input.provider.suggestedName, index: index)
                    }
                    return self.preparedFile(data, type: input.type, sourceName: input.provider.suggestedName, index: index)
                }
                DispatchQueue.main.async {
                    if let prepared { loaded.append((index, prepared)) }
                    loadProvider(at: index + 1)
                }
            }
        }
        loadProvider(at: 0)
    }

    private func providerInput(_ provider: NSItemProvider) -> ProviderInput? {
        let registered = provider.registeredTypeIdentifiers.compactMap { identifier -> ProviderInput? in
            guard let type = UTType(identifier), type.conforms(to: .data) || type.conforms(to: .content) else { return nil }
            return ProviderInput(provider: provider, type: type, identifier: identifier)
        }
        return registered.first(where: { $0.type.conforms(to: .image) })
            ?? registered.first(where: { $0.type.conforms(to: .movie) })
            ?? registered.first
    }

    private func safeFilename(_ sourceName: String?, fallback: String, type: UTType) -> String {
        let raw = (sourceName?.isEmpty == false ? sourceName! : fallback).replacingOccurrences(of: "/", with: "_")
        let shortened = String(raw.prefix(120))
        guard (shortened as NSString).pathExtension.isEmpty, let ext = type.preferredFilenameExtension else { return shortened }
        return shortened + "." + ext
    }

    private func preparedFile(_ data: Data, type: UTType, sourceName: String?, index: Int) -> PreparedAttachment {
        let name = safeFilename(sourceName, fallback: "Vaultlix attachment \(index + 1)", type: type)
        let mime = type.preferredMIMEType ?? (type.conforms(to: .movie) ? "video/mp4" : "application/octet-stream")
        let videoThumb = type.conforms(to: .movie) ? videoThumbnail(data: data, filename: name) : nil
        return PreparedAttachment(name: name, mime: mime, data: data, imagePreview: nil, videoThumb: videoThumb)
    }

    private func videoThumbnail(data: Data, filename: String) -> String? {
        let temporary = FileManager.default.temporaryDirectory
            .appendingPathComponent("vaultlix-share-" + UUID().uuidString)
            .appendingPathExtension((filename as NSString).pathExtension.isEmpty ? "mp4" : (filename as NSString).pathExtension)
        defer { try? FileManager.default.removeItem(at: temporary) }
        do {
            try data.write(to: temporary, options: .atomic)
            let generator = AVAssetImageGenerator(asset: AVURLAsset(url: temporary))
            generator.appliesPreferredTrackTransform = true
            generator.maximumSize = CGSize(width: 640, height: 640)
            let image = try generator.copyCGImage(at: CMTime(seconds: 0.1, preferredTimescale: 600), actualTime: nil)
            return UIImage(cgImage: image).jpegData(compressionQuality: 0.72)?.base64EncodedString()
        } catch { return nil }
    }

    private func optimizedImage(_ sourceData: Data, sourceName: String?, index: Int) -> PreparedAttachment? {
        // Direct UIImage decoding may materialize the complete 24/48-MP camera image before
        // drawing the smaller result, which is enough for iOS to terminate a
        // Share Extension. ImageIO decodes only a correctly oriented thumbnail.
        let sourceOptions = [kCGImageSourceShouldCache: false] as CFDictionary
        guard let source = CGImageSourceCreateWithData(sourceData as CFData, sourceOptions) else { return nil }
        let thumbnailOptions: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 2048,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        guard let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, thumbnailOptions as CFDictionary) else { return nil }
        let image = UIImage(cgImage: thumbnail)
        let size = CGSize(width: CGFloat(max(1, thumbnail.width)), height: CGFloat(max(1, thumbnail.height)))
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let rendered = UIGraphicsImageRenderer(size: size, format: format).image { context in
            UIColor.white.setFill(); context.fill(CGRect(origin: .zero, size: size)); image.draw(in: CGRect(origin: .zero, size: size))
        }
        guard let data = rendered.jpegData(compressionQuality: 0.82) else { return nil }
        let sourceFilename = (sourceName ?? "Vaultlix image \(index + 1)").replacingOccurrences(of: "/", with: "_")
        let previewOptions: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 640,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        guard let previewImage = CGImageSourceCreateThumbnailAtIndex(source, 0, previewOptions as CFDictionary),
              let previewData = UIImage(cgImage: previewImage).jpegData(compressionQuality: 0.72) else { return nil }
        let preview = "data:image/jpeg;base64," + previewData.base64EncodedString()
        return PreparedAttachment(name: String((sourceFilename as NSString).deletingPathExtension.prefix(120)) + ".jpg",
            mime: "image/jpeg", data: data, imagePreview: preview, videoThumb: nil)
    }

    private func showAppLock(_ config: AppLockConfig) {
        titleLabel.text = "Unlock Vaultlix"
        statusLabel.text = "Enter your App Lock password to choose an encrypted conversation."
        passcodeField.maxLength = config.passcodeLength
        passcodeStack.isHidden = false
        recipientsScroll.isHidden = true
        sendButton.isHidden = true
        passcodeField.becomeFirstResponder()
    }

    private func showRecipients(message: String? = nil) {
        rooms = NativeCallRoomStore.shared.shareEligibleRooms().sorted {
            ($0.peerName ?? "").localizedCaseInsensitiveCompare($1.peerName ?? "") == .orderedAscending
        }
        passcodeField.resignFirstResponder()
        passcodeStack.isHidden = true
        selectedRoomIndex = nil
        recipientsStack.arrangedSubviews.forEach { recipientsStack.removeArrangedSubview($0); $0.removeFromSuperview() }
        titleLabel.text = "Send to"
        guard !rooms.isEmpty else {
            statusLabel.text = "Open Vaultlix once to prepare your secure contacts, then share the image again."
            recipientsScroll.isHidden = true
            sendButton.isHidden = true
            return
        }
        statusLabel.text = message ?? "Choose who should receive \(preparedAttachments.count == 1 ? "this attachment" : "these attachments")."
        for (index, room) in rooms.enumerated() {
            let button = UIButton(type: .system)
            button.tag = index
            var configuration = UIButton.Configuration.plain()
            configuration.title = displayName(for: room)
            configuration.image = UIImage(systemName: "circle")
            configuration.imagePlacement = .trailing
            configuration.imagePadding = 12
            configuration.titleAlignment = .leading
            configuration.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16)
            configuration.baseForegroundColor = .label
            button.configuration = configuration
            button.contentHorizontalAlignment = .fill
            button.backgroundColor = .secondarySystemBackground
            button.heightAnchor.constraint(equalToConstant: 58).isActive = true
            button.addTarget(self, action: #selector(recipientSelected(_:)), for: .touchUpInside)
            recipientsStack.addArrangedSubview(button)
            if index < rooms.count - 1 {
                let separator = UIView(); separator.backgroundColor = .separator
                separator.heightAnchor.constraint(equalToConstant: 0.5).isActive = true
                recipientsStack.addArrangedSubview(separator)
            }
        }
        let rowHeights = CGFloat(rooms.count) * 58
        let separatorHeights = CGFloat(max(0, rooms.count - 1)) * 0.5
        let availableHeight = max(116, UIScreen.main.bounds.height - 300)
        recipientsHeightConstraint?.constant = min(availableHeight, rowHeights + separatorHeights)
        recipientsScroll.isHidden = false
        sendButton.isHidden = false
        updateRecipientSelection()
    }

    private func displayName(for room: NativeCallRoom) -> String {
        let value = String((room.peerName ?? "").trimmingCharacters(in: .whitespacesAndNewlines).prefix(80))
        return value.isEmpty ? "Encrypted conversation" : value
    }

    @objc private func passcodeChanged() {
        unlockButton.isEnabled = (passcodeField.text?.count ?? 0) >= (loadAppLockConfig()?.passcodeLength ?? 6)
    }

    @objc private func unlockShare() {
        guard let config = loadAppLockConfig(), let passcode = passcodeField.text else { return }
        let defaults = UserDefaults(suiteName: appGroup)
        let failures = defaults?.dictionary(forKey: appLockFailureKey) ?? [:]
        let blockedUntil = (failures["blockedUntil"] as? NSNumber)?.doubleValue ?? 0
        guard blockedUntil <= Date().timeIntervalSince1970 * 1000 else {
            statusLabel.text = "Too many attempts. Please wait before trying again."; return
        }
        unlockButton.isEnabled = false
        activity.startAnimating()
        DispatchQueue.global(qos: .userInitiated).async {
            let valid = self.deriveVerifier(passcode: passcode, config: config).map { self.constantTimeEqual($0, config.verifier) } ?? false
            DispatchQueue.main.async {
                self.activity.stopAnimating()
                if valid {
                    defaults?.removeObject(forKey: self.appLockFailureKey)
                    self.passcodeField.text = ""
                    self.showRecipients()
                } else {
                    let count = ((failures["count"] as? NSNumber)?.intValue ?? 0) + 1
                    let delay: Double = count >= 10 ? 900_000 : (count >= 8 ? 300_000 : (count >= 5 ? 30_000 : 0))
                    defaults?.set(["count": count, "blockedUntil": Date().timeIntervalSince1970 * 1000 + delay], forKey: self.appLockFailureKey)
                    self.passcodeField.text = ""
                    self.statusLabel.text = "Incorrect App Lock password."
                    self.unlockButton.isEnabled = false
                    self.passcodeField.becomeFirstResponder()
                }
            }
        }
    }

    @objc private func recipientSelected(_ sender: UIButton) {
        guard rooms.indices.contains(sender.tag) else { return }
        selectedRoomIndex = sender.tag
        updateRecipientSelection()
    }

    private func updateRecipientSelection() {
        for button in recipientsStack.arrangedSubviews.compactMap({ $0 as? UIButton }) {
            let selected = button.tag == selectedRoomIndex
            guard var configuration = button.configuration else { continue }
            configuration.image = UIImage(systemName: selected ? "checkmark.circle.fill" : "circle")
            configuration.baseForegroundColor = selected
                ? UIColor(red: 104/255, green: 44/255, blue: 67/255, alpha: 1)
                : .label
            button.configuration = configuration
        }
        sendButton.isEnabled = selectedRoomIndex != nil
        sendButton.alpha = sendButton.isEnabled ? 1 : 0.45
    }

    @objc private func sendToSelectedRecipient() {
        guard let selectedRoomIndex, rooms.indices.contains(selectedRoomIndex) else { return }
        let room = rooms[selectedRoomIndex]
        setSending(true, message: "Encrypting for \(displayName(for: room))…")
        Task {
            do {
                try await sendAttachments(to: room)
                await MainActor.run { self.statusLabel.text = "Sent securely."; self.activity.stopAnimating() }
                try? await Task.sleep(nanoseconds: 450_000_000)
                await MainActor.run { self.extensionContext?.completeRequest(returningItems: nil) }
            } catch {
                await MainActor.run { self.setSending(false, message: error.localizedDescription); self.showRecipients(message: error.localizedDescription + " Tap a contact to retry.") }
            }
        }
    }

    @MainActor private func setSending(_ sending: Bool, message: String) {
        statusLabel.text = message
        recipientsStack.arrangedSubviews.compactMap { $0 as? UIButton }.forEach { $0.isEnabled = !sending }
        sendButton.isEnabled = !sending && selectedRoomIndex != nil
        sendButton.alpha = sendButton.isEnabled ? 1 : 0.45
        if sending { activity.startAnimating() } else { activity.stopAnimating() }
    }

    private func sendAttachments(to room: NativeCallRoom) async throws {
        guard room.aesKey.count == 32 else { throw ShareFailure.message("This conversation needs to reconnect in Vaultlix.") }
        for payload in messagePayloads() {
            try await sendPayload(payload, to: room)
        }
    }

    private func sendPayload(_ payload: [String: Any], to room: NativeCallRoom) async throws {
        let plaintext = try JSONSerialization.data(withJSONObject: payload)
        let sealed = try AES.GCM.seal(plaintext, using: SymmetricKey(data: room.aesKey))
        guard let combined = sealed.combined else { throw ShareFailure.message("Could not encrypt the attachment.") }
        let ciphertext = "v:" + combined.base64EncodedString()
        guard let encryptedData = ciphertext.data(using: .utf8), encryptedData.count <= maximumEncryptedBytes else {
            throw ShareFailure.message("The selected attachment is too large to send.")
        }
        let msgId = UUID().uuidString.replacingOccurrences(of: "-", with: "")
        let prepared = try await postJSON(path: "/api/attachment/prepare", body: ["code": room.code, "token": room.token, "msgId": msgId, "size": encryptedData.count])
        guard let attachmentId = prepared["attachmentId"] as? String,
              let uploadValue = prepared["uploadUrl"] as? String,
              let uploadURL = URL(string: uploadValue), uploadURL.scheme == "https" else {
            throw ShareFailure.message(apiError(prepared, fallback: "Could not prepare the encrypted upload."))
        }
        var upload = URLRequest(url: uploadURL)
        upload.httpMethod = "PUT"
        upload.setValue((prepared["contentType"] as? String) ?? "application/octet-stream", forHTTPHeaderField: "Content-Type")
        upload.httpBody = encryptedData
        let (_, uploadResponse) = try await URLSession.shared.data(for: upload)
        guard let uploadHTTP = uploadResponse as? HTTPURLResponse, (200..<300).contains(uploadHTTP.statusCode) else {
            throw ShareFailure.message("Could not upload the encrypted attachment.")
        }
        let content = "obj:v1:\(attachmentId)"
        let sent = try await postJSON(path: "/api/send", body: ["code": room.code, "token": room.token, "content": content, "attachmentId": attachmentId, "msgId": msgId, "viewOnce": false])
        guard sent["ok"] as? Bool == true else { throw ShareFailure.message(apiError(sent, fallback: "Could not send the attachment.")) }
        storeSentHandoff(room: room, msgId: msgId, content: content, response: sent)
    }

    private func storeSentHandoff(room: NativeCallRoom, msgId: String, content: String, response: [String: Any]) {
        guard let defaults = UserDefaults(suiteName: appGroup) else { return }
        let now = Date().timeIntervalSince1970 * 1000
        defaults.set([
            "code": room.code,
            "msgId": msgId,
            "content": content,
            "seq": (response["seq"] as? NSNumber)?.doubleValue ?? 0,
            "sentAt": now,
        ], forKey: "vaultlix.share-sent.v1." + msgId)
    }

    private func filePayload(_ attachment: PreparedAttachment) -> [String: Any] {
        return ["type": "file", "name": attachment.name, "mime": attachment.mime, "size": attachment.data.count,
                "data": attachment.data.base64EncodedString(), "pdfPreview": NSNull(),
                "videoThumb": attachment.videoThumb as Any? ?? NSNull(), "imagePreview": attachment.imagePreview as Any? ?? NSNull(),
                "pageCount": 0, "viewOnce": false, "caption": ""]
    }

    private func messagePayloads() -> [[String: Any]] {
        if preparedAttachments.count == 1, let attachment = preparedAttachments.first {
            return [filePayload(attachment)]
        }
        if preparedAttachments.allSatisfy(\.isImage) {
            return [["type": "album", "viewOnce": false, "caption": "", "images": preparedAttachments.map { image in
                ["name": image.name, "mime": image.mime, "size": image.data.count, "data": image.data.base64EncodedString(),
                 "preview": image.imagePreview as Any? ?? NSNull()] as [String: Any]
            }]]
        }
        return preparedAttachments.map(filePayload)
    }

    private func postJSON(path: String, body: [String: Any]) async throws -> [String: Any] {
        guard let url = URL(string: "https://vaultlix.com" + path) else { throw ShareFailure.message("Invalid Vaultlix address.") }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await URLSession.shared.data(for: request)
        let decoded = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw ShareFailure.message(apiError(decoded, fallback: "Vaultlix could not complete the request."))
        }
        return decoded
    }

    private func apiError(_ response: [String: Any], fallback: String) -> String {
        guard let error = response["error"] as? String, !error.isEmpty else { return fallback }
        return error
    }

    private func loadAppLockConfig() -> AppLockConfig? {
        guard let raw = UserDefaults(suiteName: appGroup)?.dictionary(forKey: appLockKey),
              let saltValue = raw["salt"] as? String, let verifierValue = raw["verifier"] as? String,
              let salt = decodeBase64URL(saltValue), let verifier = decodeBase64URL(verifierValue), verifier.count == 32,
              let iterations = (raw["iterations"] as? NSNumber)?.intValue,
              let length = (raw["passcodeLength"] as? NSNumber)?.intValue,
              (100_000...1_000_000).contains(iterations), (6...32).contains(length) else { return nil }
        return AppLockConfig(salt: salt, verifier: verifier, iterations: iterations, passcodeLength: length)
    }

    private func deriveVerifier(passcode: String, config: AppLockConfig) -> Data? {
        var derived = [UInt8](repeating: 0, count: 32)
        let result = passcode.withCString { passwordPointer in
            config.salt.withUnsafeBytes { saltPointer in
                CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2), passwordPointer, passcode.lengthOfBytes(using: .utf8),
                    saltPointer.bindMemory(to: UInt8.self).baseAddress, config.salt.count,
                    CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), UInt32(config.iterations), &derived, derived.count)
            }
        }
        return result == kCCSuccess ? Data(derived) : nil
    }

    private func decodeBase64URL(_ value: String) -> Data? {
        var base64 = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        return Data(base64Encoded: base64)
    }

    private func constantTimeEqual(_ left: Data, _ right: Data) -> Bool {
        guard left.count == right.count else { return false }
        return zip(left, right).reduce(UInt8(0)) { $0 | ($1.0 ^ $1.1) } == 0
    }

    private func showFailure(_ message: String) {
        activity.stopAnimating(); statusLabel.text = message; passcodeStack.isHidden = true; recipientsScroll.isHidden = true
    }

    @objc private func cancelShare() {
        extensionContext?.cancelRequest(withError: NSError(domain: "VaultlixShare", code: NSUserCancelledError))
    }
}

private extension UITextField {
    var maxLength: Int {
        get { tag }
        set { tag = newValue; addTarget(self, action: #selector(limitLength), for: .editingChanged) }
    }
    @objc func limitLength() {
        guard let text, text.count > maxLength else { return }
        self.text = String(text.prefix(maxLength))
    }
}
