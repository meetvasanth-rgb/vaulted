# Safety operations

Owner: Vasanthkumar Sarveswaran. On 16 September 2026 the owner committed to reviewing reports daily and responding within 24 hours.

## Daily review

1. Open https://vaultlix.com/admin using the existing admin access key. Keep the key private; it stays in tab memory. Check at least twice daily so a report arriving just after a check does not miss the 24-hour deadline.
2. Read the safety queue, starting with overdue and oldest open reports. The dashboard displays receipt time, deadline, reason, reporter's details and only the text excerpts explicitly shared by the reporter. Treat all excerpts as allegations requiring assessment, not authenticated proof of authorship.
3. Set **In review** and record an assessment and next action. For substantiated abuse, select **Resolved** and close the reported conversation if needed. Closure is permanent for both participants. **Suspend new connections** also prevents the reported account from sending or receiving new requests; it is not a device ban and does not automatically close unrelated existing conversations.
4. Use **Dismissed with explanation** for unsupported or non-actionable reports. Record the reason. Do not paste credentials, encryption keys or unrelated personal information into review notes.
5. Monitor privacy@vaultlix.com and legal@vaultlix.com for follow-up and appeals. The in-app flow confirms receipt; there is no automatic email delivery or notification to the reporter when a review status changes. Respond to follow-ups within the same 24-hour commitment. Restore new-connection access after an accepted appeal, recording the reason. Restoration does not recover erased conversations or override a participant's personal block.
6. Sign out when finished. If the queue reports an error, resolve the service issue promptly and use the published contact channels while access is restored. Overdue alerts are visible in the dashboard; no unattended email or push alert delivery is configured.

## Storage and access

Reports and account blocks are persisted in PostgreSQL in production, with a mode-0600 atomic JSON fallback for local development. Legacy JSONL reports are imported once. Duplicate source files are currently retained; cleanup after verified import requires the owner approval requested during this task. Deployment of the revised retention promise is pending that cleanup decision. Invalid legacy JSON causes startup to fail rather than silently losing evidence. Legacy reports without account/conversation references cannot use automated account actions.

Admin routes use the existing timing-safe bearer-key authorization and failed-guess limit, and return no-store responses. New reports require both an account session and matching conversation membership. Submitted excerpts are limited to five text messages of 500 characters each; the server discards excerpts unless includeMessages is explicitly true. Ordinary ciphertext is not decrypted by the service.

Unresolved reports remain until handled. Resolved/dismissed reports are pruned 90 days after their latest review update, on startup, hourly, and when the queue is opened. Database report updates and moderation changes share a transaction and row lock. Blocks and account restrictions remain until no longer needed for enforcement; an account restriction can be restored through the report queue while the report exists. After report expiry, any later appeal requires an operator database change with the account identity verified.

## Filtering and limits

Text checks run locally before encryption and on incoming messages and inbox previews. The self-hosted dictionary is pinned to @2toad/profanity 3.3.0 (MIT), covering 12 languages, plus explicit threat/exploitation patterns and basic Unicode/leet normalization. The original dictionary tarball SHA-1 is b634a677cc60b5aea5501afb5954328f5e5678cb. Attribution is in client/vendor/safety-words.LICENSE.txt. Single-letter entries and short Latin abbreviations are excluded to reduce false positives.

Incoming media/attachments require an explicit reveal. This is an exposure control, not an image/audio classifier. No private text or attachment is sent to an external moderation provider. Existing Daily Look and GIF service safety controls still apply. The filter can miss context, novel evasion and unsupported languages, and can have false positives. Profile photos and arbitrary media are not comprehensively classified. Report handling and user blocking remain essential. Do not claim guaranteed Apple approval or comprehensive automated moderation.

## Verification

The 240-test suite passes, including account/membership authorization, explicit excerpt consent, unauthorized admin access, stale review rejection, bidirectional blocks, persisted blocks/restrictions, appeal restoration, deadlines, legacy retention, and hidden-message/attachment rendering. The protected queue and saved review status were checked in a browser using synthetic local data. Production PostgreSQL initialization and public asset availability must also be verified after deployment; local tests do not exercise a real production database or native devices.
