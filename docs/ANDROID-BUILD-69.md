# Android build 69 — offline photo safety

Build 69 brings the iOS photo-sharing/display safety workflow to Android using a bundled Yahoo-derived NSFW model and LiteRT. Ordinary chat photos are checked locally before encryption and after recipient decryption; photos and scores are not sent to a moderation provider. The existing Daily Look service keeps its separate consent flow.

Coverage: outgoing photos, albums, profile-photo changes; received/cached photo display; displayed profile photos; reply/PDF thumbnails. PDFs themselves, video, voice and remote GIF URLs are not comprehensively classified. Unsupported animated uploads stay withheld rather than scanning just their first frame. The shared hosted client continues to support iOS build 57; older Android versions retain their existing controls.

Model license, revision, preprocessing and checksum are recorded in mobile/android/app/src/main/assets/models/README.md. Expect a larger app than iOS because Android's independent model is approximately 22 MB. No claim of identical scores or performance is made.

Validation: all 247 application tests passed. Local real-model inference accepted the app icon and synthetic solid-color fixture with valid probability outputs. Native unit tests cover BGR mean subtraction, score validation, threshold blocking and APNG first-frame bypass protection. No Android phone was connected, so on-phone UI behavior, model accuracy and latency remain for device testing.

The release lint check initially found two pre-existing missing call-label translations. Both labels were supplied for Arabic, Hindi, Armenian, Russian and Chinese.

Outputs produced: a signed APK for device testing and a signed Android App Bundle for Play Console. No Play Store publication is part of this build request.


## Verified release evidence

- Source commit: 5cde93c; release tag: android-build-69.
- Final Android unit tests and release lint passed. Existing non-blocking warnings remain; no new scanner lint warnings remain.
- Signed APK: releases/android-69/Vaultlix-1.0-69.apk (approximately 107 MB, universal).
- Signed App Bundle: releases/android-69/Vaultlix-1.0-69.aab (approximately 67 MB; Play distributes device-specific packages).
- APK signature verification passed; AAB JAR signature verified. Version 1.0, code 69, min SDK 28, target SDK 36.
- Model bytes matched the pinned source inside the APK; license and native capability marker were included.
- APK 16 KB zip alignment passed. Every packaged arm64 native library, including LiteRT, has at least 16 KB ELF load-segment alignment.
- Production index.html and media-safety.js matched committed sources after the deployment.
- APK SHA-256: 03d8eb52befd4e80d0c815a7ad792dcf4ad59ae9e5246be4126060048a520922.
- AAB SHA-256: 6039c4c80fd2637bed576fe52f1a45c16aa8886f3d20368986841d558c5b10de.
- No Play Console upload or publication was performed. Native device interaction and accuracy/performance testing remain for a physical Android phone.
