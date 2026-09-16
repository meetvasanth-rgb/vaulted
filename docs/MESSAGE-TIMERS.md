# Disappearing-message rules

The server captures `deleteTimerSeconds` when it accepts a message. Zero means
that message has no disappearing timer. Enabling, disabling, or changing the
room timer affects subsequent messages only. Previously timed messages retain
their original duration, including when the room timer is later turned off.

The countdown begins when the recipient confirms reading, not on delivery.
The sender uses the server's read timestamp, so a delayed receipt does not
extend the lifetime. Repeat read confirmations do not restart a countdown.
View-once opening rules and manual deletion remain independent.

Poll/history envelopes and sender receipts carry each message's duration.
Pending decryption preserves it, and encrypted native cache records include
it. PostgreSQL stores it on `encrypted_messages`; both the in-memory and
database expiry sweeps use it. Tombstones synchronize server deletions.

Timer changes show a confirmation toast to the changer and a notification to
the other peer when their open chat receives the updated setting. They are
setting notifications, not encrypted chat-history records.

## Upgrade from room-wide timers

Earlier clients incorrectly applied the latest room setting to old messages.
The database upgrade fills missing per-message durations using the previous
server rule: only messages on or after the last timer-setting boundary qualify.
In-memory legacy messages are frozen under that rule before any new setting
change. Existing known durations are never overwritten. Already deleted local
content is not restored by this change. Both peers should reopen the app to
load the corrected client.

## Verification

A two-peer local HTTP test sends messages before enabling, while enabled, and
after disabling the timer. After reading and a server expiry sweep, only the
message sent while enabled disappears. Client tests cover older untimed
messages, duplicate reads, delayed receipts, and setting confirmation. Database
adapter tests cover duration serialization and restoration. No live user's
conversation is used for these tests.
