# Vaulted — Anonymous Private Messenger

Two people. One conversation. Disappears when you leave.

## What this is
- Anonymous text chat — no accounts, no phone numbers, no emails
- Secret room codes — share a 3-word code, connect instantly
- Zero persistence — nothing ever written to disk
- Auto-erases — room closes when either person leaves

## Tech
- Node.js WebSocket server (ws library)
- Single HTML file frontend — no React, no build step
- Zero database — all in server memory only

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
- Messages (relayed in memory, never written to disk)
- Codenames or room codes (dropped on disconnect)
- IP addresses (not logged)
- Timestamps (not persisted)
- Any metadata
