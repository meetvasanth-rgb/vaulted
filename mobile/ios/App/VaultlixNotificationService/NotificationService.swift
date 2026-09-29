import UserNotifications

// Intentionally a pass-through for now — this target exists at this point
// only to register its own App ID (com.vaultlix.app.NotificationService)
// with the already-authenticated developer account during an
// -allowProvisioningUpdates build. The actual "read this push's room token
// and report delivery" logic is a deliberate follow-up, gated on adding a
// shared keychain-access-group entitlement to the main App target — which
// also backs the already-live native-call-answering feature
// (NativeCallRoomStore), so that change needs its own explicit go-ahead
// rather than riding along here.
final class NotificationService: UNNotificationServiceExtension {
    var contentHandler: ((UNNotificationContent) -> Void)?
    var bestAttemptContent: UNMutableNotificationContent?

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        self.contentHandler = contentHandler
        bestAttemptContent = (request.content.mutableCopy() as? UNMutableNotificationContent)
        if let bestAttemptContent {
            contentHandler(bestAttemptContent)
        } else {
            contentHandler(request.content)
        }
    }

    override func serviceExtensionTimeWillExpire() {
        if let contentHandler, let bestAttemptContent {
            contentHandler(bestAttemptContent)
        }
    }
}
