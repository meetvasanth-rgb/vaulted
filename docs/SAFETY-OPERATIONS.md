# Safety operations

Owner: Vasanthkumar Sarveswaran. On 16 September 2026 the owner committed to reviewing reports daily and responding within 24 hours.

## Daily review

1. Open https://vaultlix.com/admin using the existing admin access key. Keep the key private; it stays in tab memory. Check at least twice daily so a report arriving just after a check does not miss the 24-hour deadline.
2. Read the safety queue, starting with overdue and oldest open reports. The dashboard displays receipt time, deadline, reason, reporter's details and only the text excerpts explicitly shared by the reporter. Treat all excerpts as allegations requiring assessment, not authenticated proof of authorship.
3. Set **In review** and record an assessment and next action. For substantiated abuse, select **Resolved** and **Suspend account**. Suspension revokes sign-ins and push registrations, stops access to existing one-to-one chats and groups, removes the account's live statuses, and permanently closes the reported conversation for both participants. Unrelated conversations remain available to the other participants. The server also rejects new connections and group invitations to the suspended account. This is an account restriction, not a device ban.
4. Use **Dismissed with explanation** for unsupported or non-actionable reports. Record the reason. Do not paste credentials, encryption keys or unrelated personal information into review notes.
5. Monitor privacy@vaultlix.com and legal@vaultlix.com for follow-up and appeals. The in-app flow confirms receipt; there is no automatic email delivery or notification to the reporter when a review status changes. Respond to follow-ups within the same 24-hour commitment. Restore account access after an accepted appeal, recording the reason. The user must sign in again. Restoration does not recover removed statuses or the reported conversation, and it does not override a participant's personal block.
6. Sign out when finished. If the queue reports an error, resolve the service issue promptly and use the published contact channels while access is restored. Overdue alerts are visible in the dashboard; no unattended email or push alert delivery is configured.

## Storage and access

Reports and account blocks are persisted in PostgreSQL in production, with a mode-0600 atomic JSON fallback for local development. Legacy JSONL reports are imported once. The owner approved duplicate-source cleanup. Each report is read back from durable storage and its original evidence is verified before the unchanged source file is removed. Failed writes, conflicting records, malformed input or changing source files prevent cleanup. Invalid legacy JSON causes startup to fail rather than silently losing evidence. Legacy reports without account/conversation references cannot use automated account actions.

Admin routes use the existing timing-safe bearer-key authorization and failed-guess limit, and return no-store responses. New reports require both an account session and matching conversation membership. Submitted excerpts are limited to five text messages of 500 characters each; the server discards excerpts unless includeMessages is explicitly true. Ordinary ciphertext is not decrypted by the service.

Unresolved reports remain until handled. Resolved/dismissed reports are pruned 90 days after their latest review update, on startup, hourly, and when the queue is opened. Database report updates and moderation changes share a transaction and row lock. Blocks and account restrictions remain until no longer needed for enforcement; an account restriction can be restored through the report queue while the report exists. After report expiry, any later appeal requires an operator database change with the account identity verified.

## Filtering and limits

Automatic classification of private message text and media is disabled. Text, photos, albums, profile images, statuses and media previews are not blocked by a nudity or abuse model before encryption or after decryption. Users can block participants and submit reports with selected recent text messages for human review.

No private message or attachment is sent to an external moderation provider. Today’s Look remains separate: when a user explicitly invokes it, the selected source image is sent to the image-generation provider and rejected if that provider’s moderation endpoint flags it. File type, size and decoding validation also remain in place. Report handling and user blocking remain essential. Do not describe Vaultlix as comprehensively classifying harmful content.

## Verification

The automated suite covers account/membership authorization, explicit excerpt consent, unauthorized admin access, stale review rejection, bidirectional blocks, suspension of existing sessions, group access and chat tokens, signaling-socket closure, status removal, appeal restoration, deadlines, legacy retention, direct media rendering and retention of Today’s Look moderation. Local tests do not exercise real production reports or native devices.
