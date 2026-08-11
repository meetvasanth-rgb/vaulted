# Vaultlix canonical workspace

This folder is the canonical local workspace for Vaultlix from 11 August 2026 onward.

## Structure

- `client/` — production web client and PWA.
- `server/` — Node.js API, account storage, notifications, and call signalling.
- `mobile/android/` — Android native wrapper and call/notification integration.
- `mobile/ios/` — iOS native wrapper, PushKit, CallKit, and native WebRTC integration.
- `releases/` — local Android release artifacts; intentionally ignored by Git.
- `local-archive/` — historical source/build copies; intentionally ignored by Git.
- `docs/` — architecture, release, security, and operational documentation.

## Source of truth

The Git repository in this folder is the source of truth. New Vaultlix work must be performed here. The existing `origin` remote is the private GitHub repository used by Railway deployments.

The former folders under `Downloads/vaulted-anon` and `Documents/Codex` are retained temporarily as migration backups. Do not edit them. They may be archived or removed only after web, Android, iOS, deployment, and signing verification is complete.

## Credentials

Credentials are deliberately not copied into this repository.

The current local secure-material directory is:

`/Users/vasanthkumars/.vaultlix-keys/`

It contains Android signing material, Apple push credentials, and Firebase administration credentials. Keep an encrypted backup in a password manager or encrypted offline volume. Never commit these files, their passwords, recovery codes, or production environment-variable values.

Production secrets remain in their respective providers: Railway, Cloudflare, Firebase, Apple Developer/App Store Connect, and Google Play Console.

## Working rules

1. Start all future Vaultlix work from this folder.
2. Commit source changes before producing store builds.
3. Tag the Git commit used for every Android and iOS release.
4. Never edit production directly on Railway.
5. Never copy credentials into `client/`, `server/`, or `mobile/`.
6. Treat `releases/` and `local-archive/` as local evidence, not source code.
