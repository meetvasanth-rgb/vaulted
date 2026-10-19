import UIKit
import UniformTypeIdentifiers
import CryptoKit
import CommonCrypto

final class ShareViewController: UIViewController {
    private struct PreparedImage { let name: String; let mime: String; let data: Data }
    private struct AppLockConfig { let salt: Data; let verifier: Data; let iterations: Int; let passcodeLength: Int }
    private enum ShareFailure: LocalizedError {
        case message(String)
        var errorDescription: String? { if case .message(let value) = self { return value }; return nil }
    }

    private let appGroup = "group.com.vaultlix.app"
    private let appLockKey = "vaultlix.share.app-lock.v1"
    private let appLockFailureKey = "vaultlix.share.app-lock-failures.v1"
    private let maximumImageBytes = 25 * 1024 * 1024
    private let maximumEncryptedBytes = 48 * 1024 * 1024
    private var started = false
    private var preparedImages: [PreparedImage] = []
    private var rooms: [NativeCallRoom] = []

    private let titleLabel = UILabel()
    private let statusLabel = UILabel()
    private let passcodeField = UITextField()
    private let unlockButton = UIButton(type: .system)
    private let passcodeStack = UIStackView()
    private let recipientsStack = UIStackView()
    private let recipientsScroll = UIScrollView()
    private let activity = UIActivityIndicatorView(style: .medium)

    override func viewDidLoad() {
        super.viewDidLoad()
        buildInterface()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !started else { return }
        started = true
        prepareImages()
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
        statusLabel.text = "Preparing your image securely…"
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
        NSLayoutConstraint.activate([
            recipientsStack.leadingAnchor.constraint(equalTo: recipientsScroll.contentLayoutGuide.leadingAnchor),
            recipientsStack.trailingAnchor.constraint(equalTo: recipientsScroll.contentLayoutGuide.trailingAnchor),
            recipientsStack.topAnchor.constraint(equalTo: recipientsScroll.contentLayoutGuide.topAnchor),
            recipientsStack.bottomAnchor.constraint(equalTo: recipientsScroll.contentLayoutGuide.bottomAnchor),
            recipientsStack.widthAnchor.constraint(equalTo: recipientsScroll.frameLayoutGuide.widthAnchor),
            recipientsScroll.heightAnchor.constraint(lessThanOrEqualToConstant: 340),
        ])
        recipientsScroll.layer.borderColor = UIColor.separator.cgColor
        recipientsScroll.layer.borderWidth = 0.5
        recipientsScroll.layer.cornerRadius = 14
        recipientsScroll.isHidden = true

        let cancel = UIButton(type: .system)
        cancel.setTitle("Cancel", for: .normal)
        cancel.addTarget(self, action: #selector(cancelShare), for: .touchUpInside)
        activity.hidesWhenStopped = true

        let stack = UIStackView(arrangedSubviews: [mark, titleLabel, statusLabel, activity, passcodeStack, recipientsScroll, cancel])
        stack.axis = .vertical
        stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(greaterThanOrEqualTo: view.safeAreaLayoutGuide.topAnchor, constant: 24),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -18),
            stack.centerYAnchor.constraint(equalTo: view.safeAreaLayoutGuide.centerYAnchor),
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

    private func prepareImages() {
        let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? [])
            .flatMap { $0.attachments ?? [] }
            .filter { $0.hasItemConformingToTypeIdentifier(UTType.image.identifier) }
            .prefix(10)
        guard !providers.isEmpty else { showFailure("No supported image was selected."); return }
        let group = DispatchGroup()
        let lock = NSLock()
        var loaded: [(Int, PreparedImage)] = []
        for (index, provider) in providers.enumerated() {
            group.enter()
            provider.loadDataRepresentation(forTypeIdentifier: UTType.image.identifier) { data, _ in
                defer { group.leave() }
                guard let data, !data.isEmpty, data.count <= self.maximumImageBytes,
                      let image = UIImage(data: data),
                      let prepared = self.optimizedImage(image, sourceName: provider.suggestedName, index: index) else { return }
                lock.lock(); loaded.append((index, prepared)); lock.unlock()
            }
        }
        group.notify(queue: .main) {
            self.preparedImages = loaded.sorted { $0.0 < $1.0 }.map(\.1)
            guard !self.preparedImages.isEmpty else { self.showFailure("The selected image could not be read."); return }
            if let config = self.loadAppLockConfig() { self.showAppLock(config) } else { self.showRecipients() }
        }
    }

    private func optimizedImage(_ image: UIImage, sourceName: String?, index: Int) -> PreparedImage? {
        let maxDimension: CGFloat = 2048
        let scale = min(1, maxDimension / max(image.size.width, image.size.height))
        let size = CGSize(width: max(1, image.size.width * scale), height: max(1, image.size.height * scale))
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let rendered = UIGraphicsImageRenderer(size: size, format: format).image { context in
            UIColor.white.setFill(); context.fill(CGRect(origin: .zero, size: size)); image.draw(in: CGRect(origin: .zero, size: size))
        }
        guard let data = rendered.jpegData(compressionQuality: 0.82) else { return nil }
        let source = (sourceName ?? "Vaultlix image \(index + 1)").replacingOccurrences(of: "/", with: "_")
        return PreparedImage(name: String((source as NSString).deletingPathExtension.prefix(120)) + ".jpg", mime: "image/jpeg", data: data)
    }

    private func showAppLock(_ config: AppLockConfig) {
        titleLabel.text = "Unlock Vaultlix"
        statusLabel.text = "Enter your App Lock password to choose an encrypted conversation."
        passcodeField.maxLength = config.passcodeLength
        passcodeStack.isHidden = false
        recipientsScroll.isHidden = true
        passcodeField.becomeFirstResponder()
    }

    private func showRecipients(message: String? = nil) {
        rooms = NativeCallRoomStore.shared.shareEligibleRooms().sorted {
            ($0.peerName ?? "").localizedCaseInsensitiveCompare($1.peerName ?? "") == .orderedAscending
        }
        passcodeField.resignFirstResponder()
        passcodeStack.isHidden = true
        recipientsStack.arrangedSubviews.forEach { recipientsStack.removeArrangedSubview($0); $0.removeFromSuperview() }
        titleLabel.text = "Send securely"
        guard !rooms.isEmpty else {
            statusLabel.text = "Open Vaultlix once to prepare your secure contacts, then share the image again."
            recipientsScroll.isHidden = true
            return
        }
        statusLabel.text = message ?? "Choose who should receive \(preparedImages.count == 1 ? "this image" : "these images")."
        for (index, room) in rooms.enumerated() {
            let button = UIButton(type: .system)
            button.tag = index
            button.contentHorizontalAlignment = .left
            button.setTitle("  " + displayName(for: room), for: .normal)
            button.setTitleColor(.label, for: .normal)
            button.titleLabel?.font = .systemFont(ofSize: 17, weight: .semibold)
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
        recipientsScroll.isHidden = false
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
        let room = rooms[sender.tag]
        setSending(true, message: "Encrypting for \(displayName(for: room))…")
        Task {
            do {
                try await sendImages(to: room)
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
        if sending { activity.startAnimating() } else { activity.stopAnimating() }
    }

    private func sendImages(to room: NativeCallRoom) async throws {
        guard room.aesKey.count == 32 else { throw ShareFailure.message("This conversation needs to reconnect in Vaultlix.") }
        let plaintext = try JSONSerialization.data(withJSONObject: messagePayload())
        let sealed = try AES.GCM.seal(plaintext, using: SymmetricKey(data: room.aesKey))
        guard let combined = sealed.combined else { throw ShareFailure.message("Could not encrypt the image.") }
        let ciphertext = "v:" + combined.base64EncodedString()
        guard let encryptedData = ciphertext.data(using: .utf8), encryptedData.count <= maximumEncryptedBytes else {
            throw ShareFailure.message("The selected images are too large to send together.")
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
            throw ShareFailure.message("Could not upload the encrypted image.")
        }
        let sent = try await postJSON(path: "/api/send", body: ["code": room.code, "token": room.token, "content": "obj:v1:\(attachmentId)", "attachmentId": attachmentId, "msgId": msgId, "viewOnce": false])
        guard sent["ok"] as? Bool == true else { throw ShareFailure.message(apiError(sent, fallback: "Could not send the image.")) }
    }

    private func messagePayload() -> [String: Any] {
        if preparedImages.count == 1, let image = preparedImages.first {
            return ["type": "file", "name": image.name, "mime": image.mime, "size": image.data.count,
                    "data": image.data.base64EncodedString(), "pdfPreview": NSNull(), "videoThumb": NSNull(),
                    "imagePreview": NSNull(), "pageCount": 0, "viewOnce": false, "caption": ""]
        }
        return ["type": "album", "viewOnce": false, "caption": "", "images": preparedImages.map { image in
            ["name": image.name, "mime": image.mime, "size": image.data.count, "data": image.data.base64EncodedString(), "preview": NSNull()] as [String: Any]
        }]
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
