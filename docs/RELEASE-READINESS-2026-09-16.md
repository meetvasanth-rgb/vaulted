# Release readiness — 16 September 2026

## Source and native build

- Task started on detached `ff85053`, an obsolete checkout (iOS build 20).
- Remote `codex/scalable-v2` was verified at `7efe76d2267be3582c4fe5cb1b6356f7589227d1`.
- Work continues on `codex/release-readiness`, based on that commit. The original release worktree and its user-owned `mobile/ios/build/` directory were not modified or staged.
- Existing build 55 was uploaded on 14 September and its local archive was created on that date. It predates the 15 September iPad orientation change and must not be reused for that fix.
- Build 56 includes the orientation change and the preceding native App Lock/call UI change. Both Xcode build configurations now use 56.
- Removed the unverified `ITSAppUsesNonExemptEncryption=false` declaration. Its absence deliberately requires answering Apple's export questionnaire for the uploaded build; it does not mean that encryption is absent.
- Signed archive and App Store IPA were produced successfully under ignored `releases/`. Upload was explicitly authorized and Xcode reported success.
- IPA: `releases/Vaultlix-56-export/App.ipa` (8,785,139 bytes), SHA-256 `a3d85cdc0d87881b7297196455f5737bb0419634c9806edf806b043bc5426939`.
- Non-blocking upload warning: the third-party WebRTC framework does not include its matching dSYM. This limits symbolication of crashes inside that framework.

## Verification

Release archive, local export, and upload succeeded using Xcode 26.6. The archived app reports build 56 and iPad portrait/landscape-left/landscape-right support. System signature verification passed outside the sandbox. Property-list validation, whitespace checks, server/client JavaScript syntax checks and JSON-LD parsing passed. HTML div and SVG counts balance. Five existing encryption-disclosure/app-switcher tests passed. No new device call or rotation interaction test was run in this task.

## Live deployment

Railway production service `450037dc-2e2b-41ec-b5ff-bc8f0084343a` is ACTIVE with deployment `9a8b65a4-5e4f-49a4-90f1-dff53815ce80`, commit `9609fa3` (verified-copy cleanup and safety workflow). Railway displayed Deployment successful. PostgreSQL account/conversation stores, Redis and object storage initialized successfully. The safety migration logged `0 source reports`; no legacy report records needed copying. The owner explicitly approved cleanup, GitHub push and production deployment.

Live verification: `https://vaultlix.com` returned 200 and included both safety scripts. The public filter, dictionary and admin JavaScript matched the committed files byte-for-byte. Unauthenticated access to `/api/admin/safety` returned 404. No real user reports or conversations were created, moderated or deleted as a deployment test. Build 56 uses the hosted client and therefore receives the deployed web safety changes when refreshed; no new native binary was uploaded.

## App Store findings and changes

- Version 1.0 was Prepare for Submission with build 54 selected at the start. Build 56 is now processed, its encryption questionnaire is complete, and the draft was saved with build 56 selected. Review notes now reference build 56.
- Five iPhone screenshots were present. Existing six-iPad-screenshot inventory came from the handoff and requires fresh visual verification if edited.
- Reviewer account and contact fields looked empty in accessibility/DOM output but were visibly populated in a screenshot and persisted after reload. Do not diagnose these sensitive fields from the redacted text output. Credentials are intentionally excluded from this report.
- Support and privacy-policy URLs are `https://vaultlix.com`. The privacy policy is accessible inside the site rather than as a dedicated document URL.
- Privacy labels corrected and published on 16 September: photos/videos (including profile photos/Daily Look), emails/text messages, audio and other user content are linked to identity, for App Functionality. Product Interaction is linked and includes App Functionality (account-level Daily Look usage) alongside Analytics. User ID and Device ID remain linked. No tracking purposes were enabled. App Store Connect displayed the updated publication and linked categories.
- Content rights already declared as obtained. DSA status is non-trader; the owner must ensure this matches their actual commercial activity.
- Age questionnaire already disclosed messaging and user-generated content, but the computed store rating was 4+. Raised the override to 18+ to match the existing published under-18 exclusion. Apple showed 18+ after saving.
- Owner confirmed no French encryption declaration and explicitly authorized excluding France. Availability was changed from 175 to 174 territories; France showed Not Available.
- No Add for Review, Submit for Review, or public release action was taken.

## Encryption assessment

The app uses standard cryptography: Web Crypto ECDH/AES-GCM/PBKDF2, CryptoKit AES-GCM, SQLCipher 4.18.0, and native WebRTC 150.0.0 with DTLS-SRTP. The native WebRTC binary contains standard SRTP cipher identifiers, including AES_CM_128_HMAC_SHA1 and AEAD_AES_GCM. It is incorrect to describe this app as using only HTTPS or only Apple's built-in cryptography. No proprietary encryption algorithm was identified in the reviewed code.

For Apple's questionnaire, the supported answer is standard encryption implemented in addition to Apple's operating system. These answers were saved for build 56: standard encryption; distribution in France: No. Apple changed build 56 from Missing Compliance to Ready to Submit. France is now excluded. Apple's documentation says the French declaration for this category is required when distributing in France. Do not restore the automatic exemption flag solely because the app uses standard algorithms, or equate App Store questionnaire acceptance with satisfaction of all export laws.

US mass-market classification/self-classification and any annual reporting obligations remain separate. A consumer end-user app using standard cryptography appears consistent with the mass-market route, but no CCATS, prior self-classification record, or reporting evidence was supplied. This report is a technical inventory, not an official BIS classification or filing. Confirm applicable obligations before public release.

Sources checked on 16 September 2026:

- [Apple encryption documentation requirements](https://developer.apple.com/help/app-store-connect/reference/app-information/export-compliance-documentation-for-encryption)
- [Apple export-compliance overview](https://developer.apple.com/help/app-store-connect/manage-app-information/overview-of-export-compliance)
- [BIS mass-market guidance](https://www.bis.gov/learn-support/encryption-controls/mass-market)
- [BIS ENC 740.17(b)(1)](https://www.bis.gov/learn-support/encryption-controls/license-exception-enc-740.17-b-1)
- [WebRTC SRTP documentation](https://webrtc.googlesource.com/src/+/HEAD/pc/g3doc/srtp.md)

## User-generated-content review risk

Do not claim full Guideline 1.2 compliance yet. Apple requires filtering, reporting with timely responses, blocking, and published contact information. Exact-number invitations and recipient consent reduce exposure but do not replace those requirements.

Implemented local text filtering with a pinned multilingual dictionary, threat/exploitation checks and basic obfuscation normalization; incoming text and inbox previews are screened, and incoming attachments are hidden until explicitly revealed. Account-level blocking is durable and prevents new connections in both directions. Reports require authenticated membership and explicit consent for excerpts.

The protected admin queue now has 24-hour deadlines, overdue indicators, review notes, conversation closure, suspension of new connections and appeal restoration. The owner committed to daily review and action within 24 hours. See [Safety operations](SAFETY-OPERATIONS.md) for the review process, retention, tests and known limitations. All 241 tests pass. Synthetic browser validation confirmed the queue and saved review state.

These changes reduce the previously identified gaps; they do not establish guaranteed Guideline 1.2 approval. Text filters are imperfect, media reveal controls do not classify image/audio content, and the operator must actively monitor the queue. No claim of comprehensive moderation or completed native-device acceptance testing is made.

Reference: [Apple Guideline 1.2](https://developer.apple.com/app-store/review/guidelines/#user-generated-content).

## Google Play

Latest internal release is 68 (1.0), available to internal testers, full rollout, updated 15 September 2026. Production is inactive. The dashboard reports 0 of 11 setup tasks complete and 0 closed-test users. Required setup includes privacy policy, app access, ads, content rating, target audience, data safety, government/financial/health declarations, category/contact details and store listing.

The account requires at least 12 opted-in closed testers for 14 continuous days before applying for production access. Internal testing does not satisfy this displayed requirement. Tester recruitment and the elapsed test period cannot be replaced with a configuration change. No Google Play publication was performed.
