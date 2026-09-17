# iOS build 57 — local photo safety

Replaces the unshipped external moderation proposal with a bundled Core ML image classifier. The iOS app checks supported photo content locally without uploading it for screening. The hosted web client activates the new checks only in build 57's native capability; older clients keep their previous behavior.

- Core ML model and BSD attribution bundled; model pin/hash in mobile/ios/App/App/Models/README.md.
- Background inference; bounded decoding and animation-frame checks; fail-closed image display/sharing on native errors.
- Sender photos/albums/profile changes and recipient photo records/profile display protected. Existing text filtering, reporting, blocking and 24-hour human response remain.
- No new provider consent prompt, no cloud image-screening endpoint, no unencrypted chat-media upload.
- Voice notes, video, whole documents and remote GIF URLs are not comprehensively classified.
- New native version requires the accompanying hosted client changes to be deployed.

Validation: simulator compilation succeeded; all 241 existing tests passed and five additional local-image tests passed. Real Core ML inference on the Mac accepted a synthetic app icon and rejected invalid image data as unavailable. This does not establish accuracy or performance on a physical iPhone. Physical-device checks and representative false-positive/false-negative evaluation remain required before public release.

## Build and deployment evidence

- Source commit: e121656; immutable release tag: ios-build-57.
- All 246 tests passed; JavaScript parsing, Xcode project validation and signature verification passed.
- Signed archive: releases/Vaultlix-57.xcarchive; exported IPA: releases/Vaultlix-57-export/App.ipa (ignored local artifacts).
- Exported IPA SHA-256: dff4abf95c7b2be1406cff421166c2fa3b06861a37b130f68d5b5f9038b19600.
- Railway deployment 26d794dc-b930-4f82-835c-9da207da20ee is ACTIVE / successful. Public index.html and media-safety.js matched the committed sources byte-for-byte.
- Xcode reported successful App Store Connect upload on 16 September 2026. Version 1.0 (57) appeared as Processing in TestFlight. The pre-existing WebRTC framework dSYM warning remains non-blocking; crashes within that framework may have reduced symbolication.
- Apple processing completed. Build ID: 2d3886b0-ed25-47ce-913c-eb883437abdb. The unchanged standard-encryption/outside-France questionnaire was saved using the user's prior release decision.
- The existing Vaultlix internal Testers group lists version 1.0 (57) as Testing, with one internal tester. Physical-device test instructions were saved in What to Test. No external group was added and no App Review submission was made.
