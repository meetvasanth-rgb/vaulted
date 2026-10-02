# Vaultlix — project handoff and operations map

Updated: 2 October 2026  
Source snapshot: `0d7539ce2a3175816f993927a2abb7e293c8b944`  
Production deployment branch: `codex/scalable-v2`

This document gives a new Vaultlix worktree enough context to continue web,
server, iOS and Android work safely. It deliberately records provider names,
IDs, variable names and workflows, but never secret values, passwords, private
keys, signing credentials or reviewer-account credentials.

## Start here

1. Read this file, `CLAUDE.md`, `docs/WORKSPACE.md`, and the relevant release
   note before changing code.
2. Confirm the worktree commit and branch before editing. Railway deploys the
   production branch, so an ordinary feature branch is not automatically live.
3. Keep source changes in this repository. Do not edit old copies under
   Downloads or Documents.
4. Run targeted tests while working and `npm test` before a production push.
5. Commit source before creating a mobile store build. Record the exact commit
   used by every iOS or Android release.

## Provider and product map

| Area | Current identity or location | Purpose |
| --- | --- | --- |
| GitHub | `https://github.com/meetvasanth-rgb/vaulted.git` | Canonical source remote |
| Production branch | `codex/scalable-v2` | Branch connected to the Railway production deployment |
| Website | `https://vaultlix.com` | Primary public web app and API origin |
| Legacy domain | `valuted.in` and `www.valuted.in` | Must remain attached to Railway; server redirects to `vaultlix.com` |
| Railway project | `319c360a-73fe-42f4-a5d5-5d16b4db3a96` | Production project |
| Railway service | `450037dc-2e2b-41ec-b5ff-bc8f0084343a` | Node web/API/WebSocket service |
| Railway environment | `d43f3730-449e-45f8-a138-bd776e75ed44` | Production environment seen in the Railway console |
| Cloudflare | Calls/TURN relay, configured through Railway secrets | Relays encrypted WebRTC media when native call engines use relay-only ICE |
| Apple app | App Store ID `6798266989`; bundle `com.vaultlix.app` | iOS App Store and TestFlight |
| Apple team | `3KLX2S84MV` | Xcode signing team recorded in the project |
| App Store Connect team URL ID | `4783ca3c-8282-4f11-9aeb-27640afa6489` | App Store Connect navigation identity |
| Android app | Package `com.vaultlix.app` | Google Play application ID |
| Google Play console | Developer `7722950828330876628`; app `4976154446655982819` | Play Console navigation identities |
| App Store link | `https://apps.apple.com/in/app/vaultlix/id6798266989` | Public iOS download link |
| Play Store link | `https://play.google.com/store/apps/details?id=com.vaultlix.app` | Public Android download link |

“Cloudshare” in conversation usually refers to **Cloudflare**. Attachment
storage is a private **Railway Bucket/S3-compatible service**, not Cloudflare
R2, unless the infrastructure is intentionally changed later.

## Repository layout

- `client/index.html` — main single-file web UI and most client logic; there is
  no frontend build step.
- `client/groups.js` — encrypted private-group client behavior.
- `client/sw.js` — service worker, web push and offline shell.
- `server/index.js` — Node HTTP API, WebSocket signaling, static serving,
  notifications and orchestration.
- `server/postgres-store.js` and adjacent stores — durable server persistence.
- `server/*.test.js` — Node test suite.
- `mobile/android/` — Capacitor Android wrapper, native calling, FCM,
  SQLCipher and media processing.
- `mobile/ios/` — Capacitor iOS wrapper, CallKit, PushKit/APNs, native WebRTC,
  notification extension and App Clip.
- `docs/` — architecture, operations, migrations and historical release notes.
- `releases/` — ignored local build outputs; never a source of truth.

## Runtime architecture

- Node.js 20+ serves the website, REST API and WebSocket signaling.
- PostgreSQL is authoritative for accounts, membership, encrypted history,
  receipts, reactions, deletion tombstones, safety records, groups and status.
- Redis carries short-lived presence, call state, cross-replica routing,
  counters, rate limits and cache invalidation. Without `REDIS_URL`, the server
  deliberately runs in single-replica mode.
- A private Railway Bucket stores opaque, device-encrypted attachment payloads.
  Devices upload using short-lived signed URLs; the server stores object
  references and lifecycle metadata.
- Messages and account bundles are encrypted on-device. Do not add plaintext
  message or display-name logging.
- Native iOS and Android call engines use WebRTC with Cloudflare TURN. The
  server mints short-lived ICE server credentials at `/api/turn-credentials`;
  the Cloudflare API token never leaves Railway.
- iOS push uses APNs/PushKit/CallKit. Android push uses Firebase Cloud
  Messaging. Browser push uses VAPID.
- Daily Look calls OpenAI only after explicit user consent; provider keys stay
  on the server.

## Production configuration inventory

Only variable names belong in documentation. Values stay in Railway or the
provider that issued them.

### Core Railway variables

- `NODE_ENV`, `PORT`
- `DATABASE_URL`
- `REDIS_URL`
- `SNAPSHOT_DIR` — should point to durable mounted storage for legacy rollback
  snapshots; container-local disk does not survive redeployments.
- `ADMIN_KEY` — long shared secret for protected operational/admin endpoints.

### Private attachment bucket

Railway can inject `AWS_*` names; the server also accepts `OBJECT_STORAGE_*`:

- `AWS_ENDPOINT_URL` / `OBJECT_STORAGE_ENDPOINT`
- `AWS_S3_BUCKET_NAME` / `OBJECT_STORAGE_BUCKET`
- `AWS_ACCESS_KEY_ID` / `OBJECT_STORAGE_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY` / `OBJECT_STORAGE_SECRET_ACCESS_KEY`
- `AWS_DEFAULT_REGION` / `OBJECT_STORAGE_REGION`
- `AWS_S3_URL_STYLE` / `OBJECT_STORAGE_URL_STYLE`
- `OBJECT_STORAGE_CORS_ORIGINS`

The CORS allowlist should cover the real app origins, including
`https://vaultlix.com`, `https://www.vaultlix.com`, and the retained legacy
domain if it is still served.

### Cloudflare call relay

- `CF_TURN_KEY_ID`
- `CF_TURN_KEY_API_TOKEN`

The admin health check confirms configuration presence only. It does not prove
live TURN allocation or relay connectivity. For a stuck “Connecting securely”
call, check the `/api/turn-credentials` response using valid app authorization,
then correlate Railway signaling logs with native device logs.

### Notifications

- Browser: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`
- iOS: `APNS_TEAM_ID`, `APNS_KEY_ID`, `APNS_PRIVATE_KEY`, `APNS_BUNDLE_ID`,
  `APNS_ENVIRONMENT`
- Android: `FIREBASE_SERVICE_ACCOUNT_JSON`

TestFlight and App Store builds use production APNs. Keep the public VAPID key
in the client synchronized with the server-side keypair.

### Daily Look

- `OPENAI_API_KEY` (`OPENAI_API` remains a compatibility alias)
- `OPENAI_IMAGE_MODEL`
- `OPENAI_IMAGE_QUALITY`
- `DAILY_LOOK_RESET_OFFSET_MINUTES`

## Secrets and signing material

Never commit `.env` files, provider tokens, private keys, keystores, passwords,
recovery codes, reviewer credentials or exported service-account JSON.

The established local secure-material directory is:

`/Users/vasanthkumars/.vaultlix-keys/`

Android release signing defaults to
`~/.vaultlix-keys/vaultlix-upload-v3.jks` with alias `vaultlix-upload`. Gradle
reads `VAULTLIX_KEYSTORE_PATH`, `VAULTLIX_STORE_PASSWORD`, and
`VAULTLIX_KEY_PASSWORD`; do not store their values in Git.

Production secrets also remain in Railway, Cloudflare, Firebase, Apple
Developer/App Store Connect and Google Play Console.

## Deployment and verification

Railway uses Nixpacks and starts the app with `node server/index.js` according
to `railway.json`. Production deploys automatically when the connected GitHub
branch is pushed.

Typical safe flow:

```text
edit -> targeted tests -> npm test -> commit -> push to codex/scalable-v2
-> Railway deploy -> verify vaultlix.com and /api/admin/health
```

Useful checks:

```bash
node -c server/index.js
npm test
git diff --check
```

For `client/index.html`, also extract/check the main script, confirm new IDs and
functions are wired, and check balanced HTML/SVG tags as described in
`CLAUDE.md`. The health dashboard reports PostgreSQL, Redis, storage and public
Cloudflare status; TURN, APNs and Firebase entries are configuration checks,
not end-to-end delivery tests.

## Mobile release state in this snapshot

- iOS project: marketing version `1.0.2`, build `87`.
- iOS targets: main app `com.vaultlix.app`, App Clip
  `com.vaultlix.app.Clip`, notification service
  `com.vaultlix.app.NotificationService`.
- Android project: version name `1.0`, version code `90`, package
  `com.vaultlix.app`.

These are source values, not proof that a store build is processed, approved or
released. Check App Store Connect and Google Play Console before describing
live store status.

Android debug build:

```bash
cd mobile
npm install
npm run android:sync
npm run android:build:debug
```

Android release bundle after setting signing variables:

```bash
cd mobile/android
./gradlew bundleRelease
```

For iOS, sync Capacitor, open `mobile/ios/App/App.xcodeproj` in Xcode, verify all
three target build numbers, archive, export/upload, answer export-compliance
questions accurately, and test on physical devices. The app uses standard
cryptography beyond Apple-only APIs; do not add an unverified automatic export
exemption.

## Important engineering rules

1. `persistRoom(room)` replaces the full local room blob. Never call it for a
   lightweight counter or flag before the room keypair is hydrated. Use the
   read-modify-write helpers such as `persistRoomSeq()`,
   `persistReconnectMeta()` and `persistDeleteLedger()`.
2. Preserve end-to-end encryption boundaries. Servers may route/store opaque
   ciphertext and operational state; they must not receive message plaintext.
3. Keep single-device session behavior and reviewer account constraints in mind
   when testing across multiple phones.
4. Calls depend on both signaling delivery and working TURN credentials. A
   configured health card alone is insufficient evidence.
5. Group chat is a full-screen layer rather than a normal `.screen`; navigation
   or keyboard changes must account for both the one-to-one screen and group
   layer.
6. Avoid production edits in the Railway UI. Change source, test, commit and
   deploy from GitHub.
7. Do not treat historical documents as current store truth. Verify version,
   build, territories, compliance and review state in the relevant console.

## Operational references

- `CLAUDE.md` — current architecture rules and verification ritual.
- `docs/WORKSPACE.md` — canonical-workspace and credential rules.
- `docs/SYSTEM-HEALTH.md` — what health checks do and do not prove.
- `docs/SAFETY-OPERATIONS.md` — UGC reporting/moderation operations.
- `docs/MESSAGE-TIMERS.md` — disappearing-message behavior.
- `docs/RELEASE-READINESS-2026-09-16.md` — historical Apple/release findings;
  verify anything time-sensitive before reusing it.
- `docs/IOS-BUILD-57.md` and `docs/ANDROID-BUILD-69.md` — historical build
  records, useful for process only.

## First checks in a new session

```bash
git status --short
git branch --show-current
git log -1 --oneline --decorate
git remote -v
node --version
npm test
```

If the task involves a live provider, inspect the current provider state before
acting. Repository documentation captures the architecture and safe workflow;
it does not replace current Railway, Cloudflare, App Store Connect or Play
Console status.
