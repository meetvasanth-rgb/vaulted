# Vaultlix (vaultlix.com)

Anonymous, end-to-end encrypted 1:1 messenger PWA. Node.js HTTP-polling/WebSocket
server + a single-file vanilla JS SPA client. Deployed on Railway, auto-deploys on
push to the GitHub repo `meetvasanth-rgb/vaulted`.

## Layout

- `client/index.html` — the entire client: markup, CSS, and one large inline
  `<script>` block. No build step, no bundler. Deliberately kept as a single file.
- `client/sw.js` — service worker (push notifications, offline shell).
- `client/manifest.json`, `client/icons/*` — PWA manifest and icons.
- `client/install.html` — dedicated install-instructions page.
- `server/index.js` — the entire server: HTTP API (`/api/*`), WebSocket signaling
  for calls, static file serving with an SPA catch-all fallback (any unrecognized
  path falls through to serving `index.html` — this is why routes like
  `/join/<code>` need zero backend routing of their own).

No test suite. No package manager beyond `ws` as the one server dependency.
Verification is manual (see "Verification ritual" below) — there is no CI.

## Architecture essentials

- **Rooms, not accounts.** Everything is a 2-member room identified by a code.
  No login, no persistent identity beyond what's stored in the room.
- **Two room types**: "Temporary chat room" (24h TTL, auto-expires) and
  "Permanent chat room" (`room.persistent = true`, never auto-expires, only
  removable via explicit revoke or Close & erase). The UI merged "named room"
  and "permanent" into one concept — creating a named room always makes it
  permanent now; there's no toggle. Don't reintroduce one without checking why
  it was removed (see git history / this file's terminology section).
- **E2E encryption**: ECDH P-256 keypair per device per room (`room.myKeyPair`),
  derived into a shared AES-GCM-256 key (`room.sharedKey`) once both peers'
  public keys are known. Keypair is exported/imported as JWK to/from
  localStorage so history stays decryptable across reloads. **Losing the
  stored keypair permanently loses access to all history encrypted under
  it — there is no recovery.**
- **Multi-room client**: the client can have several rooms open at once
  (`rooms` Map, `code -> Room` object, capped at `MAX_ROOMS`). `activeRoomCode`
  tracks which one is currently on screen. Most render/update functions take a
  `room` argument rather than operating on implicit global state.
- **Server keeps rooms in memory** (a `Map`), with periodic snapshotting to
  disk so a restart doesn't wipe active rooms. Message history per room is
  capped (see `room.msgs`, trimmed to the last ~100).

## The one rule that matters most: localStorage writes

`persistRoom(room)` does a **full, non-merging overwrite** of a room's
localStorage blob, including `exportKeyPairForStorage(room)` — which silently
returns `{}` if `room.myKeyPair` is null. This already caused a real,
shipped bug: a lightweight reconnect counter was persisted via a raw
`persistRoom()` call that ran *before* `importKeyPairFromStorage()` had
populated `room.myKeyPair` on reload, which silently wiped the stored
keypair on the first reload of every room, then kept regenerating a new one
every reload after (since nothing was saving it), permanently breaking
decryption of prior history on two different user devices before it was
caught and fixed.

**Rule going forward: any lightweight/frequent localStorage write (counters,
dismiss-state, shown-state, sync positions) must use a read-modify-write
pattern that patches only its own field(s), never a raw `persistRoom()`
call** — especially not anywhere that might run before key import completes
in the reload flow. Look at `persistRoomSeq()`, `persistReconnectMeta()`,
`persistDeleteLedger()` for the established pattern. For anything that isn't
really "room state" at all (feature dismiss-flags, milestone-shown flags,
etc.), prefer a completely separate, dedicated localStorage key instead of
touching the room's blob at all — see `vaultlix_nudge_dismissed` and
`vaultlix_milestones_shown` for examples.

## Terminology (already settled — don't re-litigate without reason)

- "Temporary chat room" / "Permanent chat room" — not "named room," not
  "standing link," not "permanent link." Went through several renames based
  on user testing; "Permanent Room" is the current, final term for the
  persistent-room feature and its UI (Settings, badges, etc.).
- Settings panel: sections are labeled "App-wide" vs "This room" — chosen
  specifically to resolve confusion about whether a given settings toggle
  applies to one room or globally.

## Verification ritual (run this after every change — no CI to catch mistakes)

1. `node -c server/index.js` — syntax check.
2. Extract the large inline `<script>` from `client/index.html` and run
   `node --check` on it (regex it out, e.g. via a small Python script) —
   the HTML itself won't tell you about JS syntax errors.
3. Count `<div` vs `</div>` and `<svg` vs `</svg>` occurrences to catch
   unbalanced markup from an edit (`grep -c` or a quick regex count).
4. Targeted `grep -n`/`grep -c` sanity checks that new function/id names are
   actually wired up where expected, and that nothing referencing a removed
   element/function was left behind.
5. For anything touching server logic, localStorage semantics, or timing/
   ordering (e.g. the key-mismatch bug class above), write a small isolated
   Node.js script that simulates the logic in question and asserts on it,
   rather than trusting a read-through alone.

## Deploy

Railway auto-deploys on push to the connected GitHub repo. The workflow is
just: edit files in the actual repo → run the verification steps above →
`git add -A && git commit -m "..." && git push`.
