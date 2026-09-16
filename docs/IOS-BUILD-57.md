# iOS build 57 — local photo safety

Replaces the unshipped external moderation proposal with a bundled Core ML image classifier. The iOS app checks supported photo content locally without uploading it for screening. The hosted web client activates the new checks only in build 57's native capability; older clients keep their previous behavior.

- Core ML model and BSD attribution bundled; model pin/hash in mobile/ios/App/App/Models/README.md.
- Background inference; bounded decoding and animation-frame checks; fail-closed image display/sharing on native errors.
- Sender photos/albums/profile changes and recipient photo records/profile display protected. Existing text filtering, reporting, blocking and 24-hour human response remain.
- No new provider consent prompt, no cloud image-screening endpoint, no unencrypted chat-media upload.
- Voice notes, video, whole documents and remote GIF URLs are not comprehensively classified.
- New native version requires the accompanying hosted client changes to be deployed.

Validation: simulator compilation succeeded; all 241 existing tests passed and five additional local-image tests passed. Real Core ML inference on the Mac accepted a synthetic app icon and rejected invalid image data as unavailable. This does not establish accuracy or performance on a physical iPhone. Physical-device checks and representative false-positive/false-negative evaluation remain required before public release.
