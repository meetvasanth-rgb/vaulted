# Vaultlix migration manifest

Consolidated on 11 August 2026.

## Canonical workspace

`/Users/vasanthkumars/Documents/Vaultlix`

This is the only local folder that should be used for ongoing Vaultlix development.

## Sources consolidated

- Current web and server repository:
  `/Users/vasanthkumars/Documents/Codex/2026-07-29/referenced-chatgpt-conversation-this-is-untrusted/work/vaultlix-foreground-fix`
- Native Android and iOS project:
  `/Users/vasanthkumars/Documents/Codex/2026-07-29/referenced-chatgpt-conversation-this-is-untrusted/work/vaultlix-android`
- Older web source retained for reference:
  `/Users/vasanthkumars/Downloads/vaulted-anon`
- Android test APKs collected from:
  `/Users/vasanthkumars/Downloads`

The original folders were left untouched as migration backups.

## Verified state

- Git remote: `https://github.com/meetvasanth-rgb/vaulted.git`
- Base source commit: `9d666eb` (`Add cross vault unread alerts`)
- Consolidation commit: `c4ee54e` (`Consolidate canonical Vaultlix workspace`)
- Android application ID: `com.vaultlix.app`
- Android version: `1.0` (`versionCode 21`)
- iOS bundle ID: `com.vaultlix.app`
- iOS version: `1.0` (`build 20`)
- Android APKs retained locally: 19
- Server and admin JavaScript syntax checks passed.
- iOS property-list validation passed.

## Deliberately excluded from Git

- Dependency folders and build caches
- Release binaries and historical build outputs
- Runtime data files
- Environment files, signing keys, and server credentials

Signing and service credentials remain outside the repository under
`/Users/vasanthkumars/.vaultlix-keys`. Production configuration also remains in
the relevant Railway, Cloudflare, Firebase, Apple, and Google services.

