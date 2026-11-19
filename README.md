# Money in Order

A zero-based budget (YNAB-style) for one person, built around two habits:

- **Every day:** type the amount, tap where it went. The app tells you what's left for today.
- **Every month:** count your money, log income, fund your targets, write two lines about last month.

It runs on the iPhone (Add to Home Screen) and on a laptop in the browser, works offline, and keeps
devices in sync with end-to-end encryption.

## How it works

| Screen | What it's for |
| --- | --- |
| **Today** | What's left for today, and the register: type the amount, tap where it went (every category, plus Income). Each bubble shows what the category will have *after* this purchase. Phones get a keypad; on a laptop you just type, arrow to a category and press Enter. |
| **Plan** | Ready to assign, and every category with an Assigned field (type sums like `6000+500`, ↑/↓ to move), Spent and Available. Click a name or note to edit it, hold and drag to reorder, tap Available for details (Cover overspending, assign suggestions, target). |
| **History** | Every transaction by day, searchable, filterable by category and period; edit with the same pills as everywhere else. |
| **Review** | A month in plain words against its usual: your usual day and month, what stands out, where it went (categories or groups), net worth over time, income by source, goals, and **Copy for Claude**. |

Everything important can be undone for a few seconds (and with ⌘Z on a laptop). Sounds are kept for moments that mean something (logging, a finished plan, mistakes, deletes); they can be switched off in Settings.

### The rules the math follows

- Money is one pool, kept in your **budget currency** (e.g. TWD). Anything entered in another currency
  is converted at the day's rate (fetched automatically, at most twice a day). You can switch the budget currency any time; everything converts.
- `Ready to assign = everything that came in − everything assigned` (money assigned to future months is held aside).
- A category's `available = last month's available + assigned + activity`. Leftovers roll over; overspending rolls over as a negative until you cover it.
- **Targets:** *Monthly* (set aside X every month), *Top up* (bring the category up to X), *Goal* (reach X, optionally by a month, spread evenly).
- **Daily allowance:** for categories marked *daily*, `available at the start of today ÷ days left (incl. today)`.
- **Savings rate:** money assigned to *savings* categories in a month ÷ that month's income.
- **Counting money:** you type each account's real balance. The difference from what the budget expected is split into
  exchange-rate drift (from the previous count's foreign balances) and the rest (usually unlogged spending), and booked so the plan matches reality.
  Accounts only exist for counting; you don't pick an account when you log spending.

## Sync and privacy

Sync works with the one account for all of Chris's apps (Chinese Brain, At Peace, Money in Order, Ten Dollar Words) at
[account.cristianbagrin.com](https://account.cristianbagrin.com): an email and a password (Settings → Sync).

- The password goes only to the account service, to be checked at sign-in. It stores a salted hash of it, never the
  password, and never goes to Money in Order's server.
- The budget is end-to-end encrypted. Each budget has a **data key**: 32 random bytes made on the first device.
  The vault id (`SHA-256(HKDF(key, "mio/vault-id"))`) and the AES-256-GCM key that encrypts it (`HKDF(key, "mio/vault-key")`)
  come from it, so neither server can read the budget.
- The account keeps only wrapped keys. Its **master key** (the synced item `@account/keyring`, shared by every app
  that encrypts) is encrypted under the password (`PBKDF2-SHA256`, a random salt, 600,000 rounds) and under the
  account's one **recovery key** (128 random bits, shown once as 26 characters). This budget's data key is encrypted
  under the master key (`@mio/keyring`, `HKDF(master key, "mio/dk-wrap")`). Neither the account service nor this app's
  server has a key to the data. The scheme is defined in the account service's repo (`site/public/acct/keyring.js`).
- Each signed-in device keeps the data key and the master key. If the password changes (reset or changed elsewhere),
  those devices keep syncing, and the next sign-in wraps the master key under the new password. A new device then
  needs the recovery key once. **Settings → Sync → Recovery key** makes a new one for the whole account (the old one
  stops working in every app; the account page can do the same).
- Budgets synced before the account had a master key had Money in Order's own recovery key. The first sign-in (or
  Settings → Sync → Switch) moves the data key under the master key, without changing it, and only then drops the old
  wraps; the account's recovery key is shown then if no app made one before.
- With no password, no recovery key and no signed-in device, the synced data can't be opened by anyone. Each device
  still has its full local data, and **Settings → Your data → Save backup** saves a file.

The server (`worker/vault.ts`, a Cloudflare Worker over an R2 bucket) stores a gzip-then-encrypted snapshot per vault plus a short log of encrypted changes, and only ever sees ciphertext.
An edit uploads only the records written since the device's last upload (a change of a few hundred bytes), and a device that syncs downloads only the changes it lacks.
Merging is commutative and idempotent, so changes are appended without any locking; once 30 have piled up, the next device to upload folds them into a new snapshot.
Every snapshot write must name the revision it was based on, so two devices can't silently overwrite each other: the loser gets `412`, pulls, merges and retries.
Records carry an update timestamp and tombstones, and merging keeps the newest version of each record, so devices converge whatever order they sync in.

**Moving from the old Money in Order accounts.** Before the shared account, the app had its own: the password,
stretched with PBKDF2 (the email as salt), was the budget's secret. Signing in with the old email and password
(or, on a device still signed in, the shared account's password) moves the budget: the old vault is read and decrypted,
merged with this device's unsent edits, encrypted under a new data key into a new vault and **read back to check every
record is there**. Only then is the old vault retired: a note beside it (`moved/<id>`, the new key encrypted under the
old secret) makes it refuse writes (`410`) and tells the account's other devices where the budget went, so they move on
their own with their own unsent edits. The old data stays on the server (`worker/account.ts` still answers whether an
email had an old account). If the shared account already exists with another password, the app asks for it.
Devices that synced with a 20-character code before accounts existed keep syncing until they sign in.

## Development

```sh
npm install
npm run dev          # UI only, no sync endpoint
npm test             # budget math, targets, counting, merge, tabs and sync, and a randomized stress test
STRESS_SEEDS=80 STRESS_STEPS=400 npm test   # the stress test, much harder
npm run serve        # build + wrangler dev (the real Worker, local R2): sync works between tabs on http://localhost:4174
MIO_API=http://127.0.0.1:4174 npm run dev   # the UI with sync against that Worker
```

On `localhost`, `localStorage['mio-account-api'] = 'http://127.0.0.1:8791/api'` points sign-in at a local copy of the
account service (`npx wrangler dev --port 8791` in the chinesebrain repo's `site/`). The end-to-end test runs both:

```sh
npx wrangler dev --port 8791 --var MAIL_API:http://127.0.0.1:8792/emails --var RESEND_API_KEY:test   # in chinesebrain site/
E2E_APP=http://127.0.0.1:4174 E2E_ACCOUNT=http://127.0.0.1:8791/api E2E_MAIL_PORT=8792 npx vitest run tests/e2e
```

Code map:

- `src/lib/budget.ts`: all budget math (pure functions over an index of the data)
- `src/lib/plan.ts`: the planner (suggestions, Fill in, how far ahead the money goes)
- `src/lib/accounts.ts`: balances, investments and net worth
- `src/lib/compare.ts`, `src/lib/insights.ts`: Review's figures (a month against its usual, savings, goals)
- `src/lib/store.ts`: data, undo and every mutation; `src/lib/persist.ts`: IndexedDB, safe across tabs and reloads
- `src/lib/sync.ts`: encryption and the pull/merge/push loop; `src/lib/merge.ts`: the record merge
- `src/lib/keys.ts`: the data key and its keyring; `src/lib/account-keyring.ts`: the account's master key and recovery key; `src/lib/account.ts`: the shared account; `src/lib/signin.ts`: sign-in, recovery and the move from the old accounts
- `src/lib/export.ts`: the Claude summary and CSV
- `src/views/*`: screens; `src/styles.css`: the whole design system

## Deploying

One Cloudflare Worker, configured in `wrangler.jsonc`: `dist/` as static assets (headers in `public/_headers`),
`/api/*` handled by `worker/index.ts`, data in the R2 bucket `moneyinorder-data`, and the same rate limits as before
(120 vault and 30 account requests a minute per IP).

```sh
npx wrangler login
npx wrangler r2 bucket create moneyinorder-data   # once
npm run deploy                                     # typecheck, test, build, wrangler deploy
```

Moving the data over from the old Netlify site: see `MIGRATION.md`.
