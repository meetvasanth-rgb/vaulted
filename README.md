# Vaulted — Anonymous Private Messenger

Two people. One conversation. Disappears when you leave.

## What this is
- Anonymous text chat — no phone number or email required; guest access plus optional encrypted anonymous-ID sync
- Secret room codes — share a 3-word code, connect instantly
- Server memory with an atomic encrypted-room checkpoint on persistent storage for crash and backup recovery
- Auto-erases — room closes when either person leaves

## Tech
- Node.js WebSocket server (ws library)
- Single HTML file frontend — no React, no build step
- Zero database — active encrypted room state is checkpointed to the attached persistent volume

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
