# Local image approval cache

The hosted native client stores at most 512 SHA-256 fingerprints of approved
base64 image payloads, with approval timestamps, in device-local web storage.
No image bytes, message identifiers, account identifiers or rejected verdicts
are persisted by this cache. Approvals expire after 30 days and are removed on
normal sign-out and session replacement. Storage failure falls back to native
screening. An image must still be available and pass existing attachment and
view-once lifecycle checks; an approval does not restore deleted media.

View-once sends and received records use only the in-memory checker cache,
never the durable approval cache. Other checks retain in-flight deduplication
and serialized native inference. A neutral placeholder covers pending checks;
the explanatory text appears only after 400 ms. Blocked and failed checks keep
the existing protection and recovery UI.

When either native model, preprocessing or decision threshold changes, bump
`policy` in client/media-safety.js as part of the release. It namespaces stored
approvals separately for Android and iOS. Old policy entries cannot approve an
image under the new policy. The current models are the bundled NSFW.mlmodel
and nsfw.tflite with their current platform inference policies.

The v3 script URL and app-shell-v6 service worker refresh older cached clients.
Deployment is required before installed apps loading the hosted client receive
this change. No native binary changes are included.
