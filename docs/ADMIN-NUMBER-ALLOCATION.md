# Gifted number allocation

Admin → Allocate a number reserves an exact available 6–10 digit number
starting with 2–9. The reservation is recorded as `admin-gift`; its token is
stored as a SHA-256 hash, with creation/expiry times and the eventual owner.
It is independent of billing and Plus. Existing number retention policies
still apply. PostgreSQL is required for reservations to survive server restarts;
the development in-memory fallback is ephemeral.

The returned claim URL expires after seven days. Its bearer token is in the URL
fragment, which is not sent in the initial HTTP request. The client removes the
fragment from history, validates it through POST, and keeps it in memory during
signup. Anyone with the link can redeem it; share it privately. No email is sent.
Refreshing before completing signup requires reopening the original link.
The admin must copy the link when issued; plaintext tokens are not recoverable.

Signup on an existing signed-in account is refused by the UI: this feature
creates new identities and never renumbers existing users. The friend chooses
their own password and recovery credentials. Gift signup uses the existing
client-side encrypted account creation flow.

Database registration locks and validates the reservation, checks account and
retired-number conflicts, creates the account and marks the reservation used
within one transaction. Valid live reservations cannot be bypassed through the
legacy tokenless registration path. The local fallback rechecks ownership and
expiry after password hashing to prevent concurrent claims.

Not included: renumbering, reservation revocation UI, gifting to a verified
email/person, or recovering an allocation link after a lost network response.
