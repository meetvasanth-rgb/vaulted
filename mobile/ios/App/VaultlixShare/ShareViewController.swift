import UIKit
import UniformTypeIdentifiers

final class ShareViewController: UIViewController {
    private let appGroup = "group.com.vaultlix.app"
    private let maximumImageBytes = 25 * 1024 * 1024
    private var started = false
    private let statusLabel = UILabel()
    private let openButton = UIButton(type: .system)

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground

        let mark = UILabel()
        mark.text = "🔒"
        mark.font = .systemFont(ofSize: 42)
        mark.textAlignment = .center

        let title = UILabel()
        title.text = "Share with Vaultlix"
        title.font = .systemFont(ofSize: 23, weight: .bold)
        title.textAlignment = .center

        statusLabel.text = "Preparing your image securely…"
        statusLabel.font = .systemFont(ofSize: 15)
        statusLabel.textColor = .secondaryLabel
        statusLabel.numberOfLines = 0
        statusLabel.textAlignment = .center

        openButton.setTitle("Done", for: .normal)
        openButton.titleLabel?.font = .systemFont(ofSize: 17, weight: .semibold)
        openButton.backgroundColor = UIColor(red: 104/255, green: 44/255, blue: 67/255, alpha: 1)
        openButton.tintColor = .white
        openButton.layer.cornerRadius = 14
        openButton.heightAnchor.constraint(equalToConstant: 50).isActive = true
        openButton.isHidden = true
        openButton.addTarget(self, action: #selector(finishShare), for: .touchUpInside)

        let cancel = UIButton(type: .system)
        cancel.setTitle("Cancel", for: .normal)
        cancel.addTarget(self, action: #selector(cancelShare), for: .touchUpInside)

        let stack = UIStackView(arrangedSubviews: [mark, title, statusLabel, openButton, cancel])
        stack.axis = .vertical
        stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -24),
            stack.centerYAnchor.constraint(equalTo: view.centerYAnchor),
        ])
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !started else { return }
        started = true
        stageImages()
    }

    private func stageImages() {
        let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? [])
            .flatMap { $0.attachments ?? [] }
            .filter { $0.hasItemConformingToTypeIdentifier(UTType.image.identifier) }
            .prefix(10)
        guard !providers.isEmpty,
              let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) else {
            showFailure("No supported image was selected.")
            return
        }

        let transaction = container.appendingPathComponent("ExternalShares", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        do { try FileManager.default.createDirectory(at: transaction, withIntermediateDirectories: true) }
        catch { showFailure("Vaultlix could not prepare this image."); return }

        let group = DispatchGroup()
        let lock = NSLock()
        var metadata: [[String: String]] = []
        for (index, provider) in providers.enumerated() {
            group.enter()
            provider.loadDataRepresentation(forTypeIdentifier: UTType.image.identifier) { data, _ in
                defer { group.leave() }
                guard let data, !data.isEmpty, data.count <= self.maximumImageBytes else { return }
                let sourceName = (provider.suggestedName ?? "Vaultlix image \(index + 1)")
                    .replacingOccurrences(of: "/", with: "_")
                let mime = self.imageMime(data) ?? "image/jpeg"
                let ext = self.fileExtension(for: mime)
                let storedName = UUID().uuidString + "." + ext
                do {
                    try data.write(to: transaction.appendingPathComponent(storedName), options: .atomic)
                    lock.lock()
                    metadata.append(["file": storedName, "name": sourceName, "mime": mime])
                    lock.unlock()
                } catch { }
            }
        }
        group.notify(queue: .main) {
            guard !metadata.isEmpty,
                  let data = try? JSONSerialization.data(withJSONObject: metadata) else {
                try? FileManager.default.removeItem(at: transaction)
                self.showFailure("The selected image could not be read.")
                return
            }
            do {
                try data.write(to: transaction.appendingPathComponent("manifest.json"), options: .atomic)
                self.statusLabel.text = "Your image is ready. Tap Done, then open Vaultlix. After you unlock, choose the encrypted conversation."
                self.openButton.isHidden = false
            } catch {
                try? FileManager.default.removeItem(at: transaction)
                self.showFailure("Vaultlix could not prepare this image.")
            }
        }
    }

    private func imageMime(_ data: Data) -> String? {
        guard let first = data.first else { return nil }
        if first == 0xFF { return "image/jpeg" }
        if first == 0x89 { return "image/png" }
        if first == 0x47 { return "image/gif" }
        if data.count > 12, String(data: data[8..<12], encoding: .ascii) == "WEBP" { return "image/webp" }
        if data.count > 12, String(data: data[4..<12], encoding: .ascii)?.contains("ftyp") == true { return "image/heic" }
        return nil
    }

    private func fileExtension(for mime: String) -> String {
        switch mime { case "image/png": return "png"; case "image/gif": return "gif"; case "image/webp": return "webp"; case "image/heic": return "heic"; default: return "jpg" }
    }

    private func showFailure(_ message: String) {
        statusLabel.text = message
        openButton.isHidden = true
    }

    @objc private func finishShare() {
        extensionContext?.completeRequest(returningItems: nil)
    }

    @objc private func cancelShare() {
        extensionContext?.cancelRequest(withError: NSError(domain: "VaultlixShare", code: NSUserCancelledError))
    }
}
