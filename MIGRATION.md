# Moving from Netlify to Cloudflare

The app moves from `*.netlify.app` to https://moneyinorder.cristianbagrin.com. Two things have to move:

- **The synced data on the server** (encrypted vaults, their change logs, account markers): copied from Netlify Blobs
  to the R2 bucket `moneyinorder-data` by `scripts/migrate-from-netlify.mjs`.
- **The budget on each device**: browsers keep data per address, so nothing on the old address is visible on the new
  one. A device gets its budget back by signing in on the new address, which downloads everything the account has
  synced. Anything a device hasn't synced yet would stay behind, which is what the steps below prevent.

## 1. Set up Cloudflare (no data yet)

```sh
npm ci
npx wrangler login                                  # account 1da66eb742220c8ae068a08cdeeaade3
npx wrangler r2 bucket create moneyinorder-data
npm run deploy                                      # typecheck, tests, build, wrangler deploy
```

`wrangler deploy` attaches the custom domain from `wrangler.jsonc`. The zone `cristianbagrin.com` must be on this
account, and an existing DNS record for `moneyinorder` (say, a CNAME to Netlify) has to be removed first.
Check that https://moneyinorder.cristianbagrin.com shows the welcome screen.

## 2. Tell the old address the app moved

Deploy commit "The old Netlify address says the app moved…" (the first commit on this branch, still a full Netlify
build with both functions) to the Netlify site once. Each device then shows a yellow note: where the app moved, and
whether this device still has something to do (sign in, or wait for sync).

## 3. Chris, on each device, on the old address

1. Open the app the way you always do (the Home Screen icon on the phone).
2. Read the yellow note at the top. Wait until it says **Everything here is synced**.
   If it says to sign in instead, stop and ask: that device has data that isn't in your account yet.
3. Settings → Your data → **Save backup**. Keep the file somewhere private. It's the safety net.
4. From now on, don't log anything on the old address.

## 4. Copy the server data (after step 3 on every device)

```sh
npm install --no-save @netlify/blobs@11.1.4
NETLIFY_TOKEN=… node scripts/migrate-from-netlify.mjs export netlify-dump-YYYY-MM-DD
node scripts/migrate-from-netlify.mjs import netlify-dump-YYYY-MM-DD --remote
node scripts/migrate-from-netlify.mjs verify netlify-dump-YYYY-MM-DD --remote
```

`import` also reads a backup made by hand in the same layout (`<store>/_manifest.json` + one file per blob).
Verify must end with "Verified: everything in the dump is in R2". Every step can be run again: import never overwrites,
and a vault that changed on either side is merged, not replaced. If anything was logged on the old address after the
export, export into a new folder and import + verify that one too.

## 5. Chris, on the new address

**Laptop first:**

1. Open https://moneyinorder.cristianbagrin.com.
2. Tap **I already have an account** and sign in with the same email and password.
3. Check it matches the old one: Ready to assign, this month's Plan, the last few transactions in History.

**Then the phone:**

1. In Safari, open https://moneyinorder.cristianbagrin.com.
2. Share → **Add to Home Screen**. Open the app from the new icon (the Home Screen app keeps its own data, separate from Safari).
3. Sign in there, and check the same numbers.
4. Once it matches, delete the old icon.

What doesn't come along: the sound setting, an amount typed on Today but not logged, and which Review view you last
picked. Set those again if you care.

There is no password reset (the server can't decrypt anything). If the password doesn't work, stop: the backup from
step 3 still has everything.

## 6. Afterwards

Keep the Netlify site and its Blobs for a few weeks as a fallback. Only when both devices work on the new address,
redirect the old one or take it down.
