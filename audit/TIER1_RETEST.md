# Vaultlix Tier 1 Security Retest

Date: 2026-08-21

Scope: R1, R2, and R4 from `REMEDIATION_PLAN.md`.

## Results

- **R1 — TURN credential rate limiting: PASS.** Authenticated room members are limited to six credential requests per token per 60 seconds. The seventh request returns HTTP 429 and the automated mock verifies that the blocked request does not reach the TURN credential provider.
- **R2 — Third-party QR script removal: PASS.** `/install` loads `/vendor/qrcode.min.js` from Vaultlix, the MIT license is retained in `/vendor/qrcode.LICENSE`, and the page no longer references cdnjs. A page-specific Content Security Policy restricts scripts to the same origin.
- **R4 — Admin authentication lockout: PASS.** Ten failed guesses create a blocked bucket. A correct key submitted as attempt eleven receives the same empty HTTP 404 before comparison. The bucket expires with its configured window, and repeated successful requests do not increment the failure counter.

## Verification performed

- `node --check server/index.js`
- `node --check server/security-remediation.test.js`
- `git diff --check`
- `npm test`: 6 tests passed, 0 failed
- `npm audit --omit=dev`: reported eight moderate transitive `uuid` findings under `firebase-admin`; npm only offers a breaking forced downgrade. No forced dependency change was applied.

## Files added or changed for this remediation

- `server/index.js`
- `server/security-remediation.test.js`
- `client/install.html`
- `client/vendor/qrcode.min.js`
- `client/vendor/qrcode.LICENSE`

The working tree also contains pre-existing application and build changes outside this remediation. Those were preserved and were not intentionally modified as part of this retest.
