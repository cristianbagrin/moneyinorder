# Money in Order

Personal zero-based budgeting PWA (Preact + Vite + TypeScript), hosted on one Cloudflare Worker (`moneyinorder`) at
https://moneyinorder.cristianbagrin.com: the built app as static assets plus an encrypted sync API over R2 (`worker/`).

## Workflow rules

- Always merge finished work into `main` and push it. `main` is what's deployed.
- Deploy once per session: push `main` and deploy when the session's work is done (or when the user asks), not after
  each milestone or fix, so his phone and laptop don't update mid-task. Commit locally as often as you like and batch
  several tasks into one push. This overrides any general "push after each milestone" rule.
- Deploy with `npm run deploy` (typecheck, tests, build, then `wrangler deploy`; Wrangler must be logged in to Cloudflare
  account `1da66eb742220c8ae068a08cdeeaade3`). Everything the Worker needs is in `wrangler.jsonc`.
- Before pushing: `npm run typecheck && npm test && npm run build`.
- The app must stay at one address: browser data (the budget on each device) belongs to the address, so a new domain
  means every device has to sign in again there. The old Netlify site and the move are covered in `MIGRATION.md`.
- The repo is public: never commit real financial data (amounts, balances, exports).

## Product principles

- Less is more. Show only what the moment needs; no eyebrow labels, helper footers or explanatory text that restates the obvious.
- Same visual language everywhere: round pill pickers instead of selects and tables, one-tap choices, inline editing.
- Phone first, but every feature must also work well with mouse and keyboard on a laptop.
- Light, neutral background; key numbers get the yellow marker highlight.

## Autonomous Execution & Token Efficiency Rules

- **Zero sleep-polling loops**: never run `sleep N; cat /tmp/...` loops to check on background sub-agents. Wait for background tasks synchronously or via completion notifications so the main thread does not wake up repeatedly.
- **Clean sub-agent isolation**: use parallel sub-agents when they speed up work, but always branch worktrees from current `HEAD`, assign strict non-overlapping file boundaries to prevent duplicate edits, and keep worktrees outside `tests/` (or exclude them in the test config) so `npm test` never runs duplicate suites.
- **Hybrid model routing**: use Opus where deep reasoning matters (architecture, design and math audits, root-cause debugging) and route implementation fixers, flow tests, and git/deploy orchestration to Sonnet.
- **Uninterrupted autonomous runs with git checkpoints**: do not pause to ask for human review between milestones unless genuinely blocked. Commit after each completed milestone so progress is crash-safe, but push and deploy `main` only once at the end (see Workflow rules).
- **Signal-only test logs**: run the full test and typecheck suites after merging a batch, and suppress verbose passing output so only failures enter the context window.
