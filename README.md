# Vaultlix — Private Number Messenger

One private number. One private inbox. No SIM required.

## What this is
- Private-number identities without exposing a phone number or email
- One-to-one encrypted inbox conversations with messaging and calls
- PostgreSQL-backed identity, membership, metadata and encrypted history
- Redis-backed presence, call state, routing, counters and cache invalidation

## Tech
- Node.js HTTP/WebSocket server (`ws`)
- PostgreSQL for durable identity and encrypted conversation state
- Redis coordination for multi-replica WebSocket delivery, calls, presence and counters
- Single HTML file frontend — no React, no build step
- Native Capacitor shells for iOS and Android

## Realtime scaling configuration

Set `REDIS_URL` to a private Redis connection URL before running more than one
application replica. Redis carries only short-lived coordination events and
one-way hashes of account/member routing credentials; call SDP and ICE remain
opaque client-encrypted envelopes. If `REDIS_URL` is absent,
Vaultlix deliberately retains its current single-replica behaviour.

Signal-socket and presence leases expire automatically after 60 seconds and
are refreshed by the existing 25-second WebSocket heartbeat. The admin health
response reports either `Redis connected` or `Single-replica mode`.

## Daily Look configuration

Daily Look uses an authenticated server endpoint; the provider key must never be placed in the client or mobile apps. Configure these Railway variables:

- `OPENAI_API_KEY` — recommended variable name for the provider key
- `OPENAI_API` — accepted as a backwards-compatible Railway alias
- `OPENAI_IMAGE_MODEL` — optional model override (defaults to `gpt-image-2.5-sunburst` for precise portrait editing)
- `OPENAI_IMAGE_QUALITY` — optional quality override (defaults to `medium`)
Daily Look currently permits five successful creations per account per calendar day, resetting at 12:00 AM India Standard Time, and allows only one generation to run at a time per account. Failed or refused requests do not consume an attempt.

---

## Deploy to Railway (5 steps)

### Step 1 — Push to GitHub
```bash
cd vaulted-anon
git init
git add .
git commit -m "Vaulted v1"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/vaulted.git
git push -u origin main
```

### Step 2 — Railway setup
1. Go to railway.app → New Project
2. "Deploy from GitHub repo" → select your repo
3. Railway auto-detects Node.js and deploys
4. Click "Generate Domain" to get a temporary URL

### Step 3 — Test it
Open the Railway URL in two different browser tabs.
Create a room in one, join with the code in the other.

### Step 4 — Point vaulted.in
In Hostinger DNS settings:
- Add CNAME record: `@` → your Railway domain
- Add CNAME record: `www` → your Railway domain

In Railway:
- Settings → Domains → Add custom domain → vaulted.in

### Step 5 — Done
Open vaulted.in in two tabs. It works.

---

## Files
```
vaulted-anon/
├── server/index.js     # WebSocket server — 120 lines
├── client/index.html   # Entire frontend — single file
├── package.json        # ws dependency only
├── railway.json        # Railway config
└── Procfile            # Start command
```

## How rooms work
1. Person A opens vaulted.in → "Create a room" → enters codename
2. Server generates 3-word code (e.g. `amber-frost-42`)
3. Person A shares the code with Person B (via WhatsApp, call, anything)
4. Person B opens vaulted.in → "Join a room" → enters code + codename
5. Both connected — messages flow through server memory only
6. Either person clicks "Close & erase" → room gone, messages gone

## What is NEVER stored
- Plaintext messages (the server only receives encrypted ciphertext; active encrypted room state is checkpointed for recovery)
- Real-world identities (chosen display names and room codes exist for the vault lifetime and in retained recovery backups)
- IP addresses (not logged)
- Readable message content (timestamps and encrypted room metadata are included in recovery checkpoints)
- Any metadata beyond the above — public keys and push-subscription details ARE kept for the room's lifetime (both required for encryption and notifications to work at all), and anonymous aggregate usage counts (vaults created, temporary vs. permanent) persist indefinitely as running totals, never linked to a specific vault, code, or IP
