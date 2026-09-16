# Android build 69 — offline photo safety

Build 69 brings the iOS photo-sharing/display safety workflow to Android using a bundled Yahoo-derived NSFW model and LiteRT. Ordinary chat photos are checked locally before encryption and after recipient decryption; photos and scores are not sent to a moderation provider. The existing Daily Look service keeps its separate consent flow.

Coverage: outgoing photos, albums, profile-photo changes; received/cached photo display; displayed profile photos; reply/PDF thumbnails. PDFs themselves, video, voice and remote GIF URLs are not comprehensively classified. Unsupported animated uploads stay withheld rather than scanning just their first frame. The shared hosted client continues to support iOS build 57; older Android versions retain their existing controls.

Model license, revision, preprocessing and checksum are recorded in mobile/android/app/src/main/assets/models/README.md. Expect a larger app than iOS because Android's independent model is approximately 22 MB. No claim of identical scores or performance is made.

Validation: all 247 application tests passed. Local real-model inference accepted the app icon and synthetic solid-color fixture with valid probability outputs. Native unit tests cover BGR mean subtraction, score validation, threshold blocking and APNG first-frame bypass protection. No Android phone was connected, so on-phone UI behavior, model accuracy and latency remain for device testing.

The release lint check initially found two pre-existing missing call-label translations. Both labels were supplied for Arabic, Hindi, Armenian, Russian and Chinese.

Outputs planned: a signed APK for device testing and a signed Android App Bundle for Play Console. No Play Store publication is part of this build request.
