import UserNotifications

// Runs on receipt of any push whose aps payload sets mutable-content:1 (see
// sendApnsNotification in server/index.js, scoped there to regular chat
// message pushes) — the one place iOS lets an app run code on a locked
// device before a notification is shown. That's what actually makes
// reporting delivery here possible at all: a plain "alert" push runs zero
// app code on receipt.
final class NotificationService: UNNotificationServiceExtension {
    var contentHandler: ((UNNotificationContent) -> Void)?
    var bestAttemptContent: UNMutableNotificationContent?

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        self.contentHandler = contentHandler
        bestAttemptContent = (request.content.mutableCopy() as? UNMutableNotificationContent)

        let userInfo = request.content.userInfo
        let code = (userInfo["code"] as? String) ?? ""
        let msgId = (userInfo["msgId"] as? String) ?? ""
        guard !code.isEmpty, !msgId.isEmpty else {
            deliver()
            return
        }
        reportDelivered(code: code, msgId: msgId) { [weak self] in
            self?.deliver()
        }
    }

    // The system gives this extension a bounded window (about 30s) to call
    // the content handler before showing the original, unmodified push
    // itself — never leaves the notification stuck pending.
    override func serviceExtensionTimeWillExpire() {
        deliver()
    }

    private func deliver() {
        if let bestAttemptContent {
            contentHandler?(bestAttemptContent)
        }
        contentHandler = nil
        bestAttemptContent = nil
    }

    // Best-effort and silent on any failure — the room's own poll loop (or,
    // on the web, sw.js's push handler) remains the fallback the moment the
    // app is actually opened. The room token comes from NativeCallRoomStore
    // via the shared keychain access group, not the WebView's own storage:
    // that store is populated for every room the moment its E2E key is
    // derived (see provisionRoom in SceneDelegate.swift / provisionAndroidCallRoom
    // in client/index.html), not only rooms that have been called through,
    // and it's readable here even though this extension never loads the
    // WebView at all.
    private func reportDelivered(code: String, msgId: String, completion: @escaping () -> Void) {
        guard let room = NativeCallRoomStore.shared.room(code: code),
              let url = URL(string: "https://vaultlix.com/api/mark-delivered") else {
            completion()
            return
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 8
        guard let body = try? JSONSerialization.data(withJSONObject: [
            "code": code, "token": room.token, "msgId": msgId,
        ]) else {
            completion()
            return
        }
        request.httpBody = body
        let task = URLSession.shared.dataTask(with: request) { _, _, _ in
            completion()
        }
        task.resume()
    }
}
