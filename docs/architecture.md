# Personal Finance App — Architecture & Build Plan

A personal, Rocket Money–style finance tracker built on Plaid's free Trial plan. Web first, installable on iPhone as a home-screen web app (PWA). Native iOS later, only if needed.

---

## 1. Scope

**In scope (v1)**
- Link bank/credit card accounts via Plaid Link
- Sync balances and transactions
- Auto-categorize + manual re-categorize
- Monthly budgets by category
- Recurring charges / subscriptions list
- Net worth: assets minus liabilities across checking/savings, credit cards, loans, and investments, with a history chart (daily snapshots)
- Loan and credit card detail (balances, APRs, minimum payments, due dates) via Liabilities
- Investment accounts (holdings, values, investment transactions) via Investments
- Manual accounts for things Plaid can't see (home value, car, accounts at unsupported institutions)
- Single-user login

**Out of scope (can't replicate without a company behind it)**
- Bill negotiation
- Canceling subscriptions on your behalf
- Multi-user / public signups

---

## 2. Plaid constraints to design around

Verify all of this in your Plaid Dashboard; plans change.

- **Trial plan:** free, real production data, **10 Production Items max** (an Item = one bank login). US/Canada teams created on or after April 15, 2026, with no existing Production or Limited Production account. Only US and Canadian institutions are available.
- **Approval:** most Trial applications are auto-approved after identity verification (manual review, if flagged, takes 2-3 business days). OAuth access for big banks typically turns on within 6-24 hours of approval, so don't panic if Chase doesn't work right away.
- **API calls on connected Items are uncapped.** Only the Item count is limited.
- **Budget your 10 Items.** One Item = one login at one institution, however many accounts it holds, and several products (Transactions, Liabilities, Investments) can share the same Item. Before linking anything real, list every institution you want (banks, credit cards, brokerage, 401k, student loans, mortgage) and make sure the list fits in 10. Anything beyond that goes in as a manual account.
- **`/item/remove` does NOT free up a slot.** Do all connect/disconnect testing in **Sandbox**. Once you connect a real bank, treat that Item as permanent.
- **Persist every access token.** Losing one means losing that Item *and* its slot.
- **Trial bundle (per Plaid's help center):** Auth, Transactions (incl. Transactions Refresh), Balance, Identity, Assets, Liabilities, Investments (incl. Investments Refresh), and Statements. **Not included:** Identity Verification, Signal, Transfer, Consumer Report Access, Monitor. You don't need any of the excluded ones.
- **Recurring Transactions is the one to verify.** Plaid documents it as an optional add-on to Transactions that you request access to, and it isn't named in the Trial bundle list. Ask Plaid support (dashboard.plaid.com/support/new) or check the product access settings, and build the fallback detector (section 5.5) so you're not blocked.
- **OAuth banks covered on Trial:** Bank of America, Chase, Wells Fargo, Capital One, Citi, Navy Federal, PNC, U.S. Bank, American Express, and Merrill, among others.
- Upgrading to a paid Production plan is one-way, and Transactions is billed per Item per month there. This is a personal tool; it won't scale free to other users.

---

## 3. Recommended stack

| Layer | Choice | Notes |
|---|---|---|
| Framework | **Next.js (App Router) + TypeScript** | One codebase for UI + API routes |
| UI | Tailwind + shadcn/ui | Responsive from day one |
| Database | **Postgres** on Supabase or Neon (free tier) | |
| ORM | Drizzle or Prisma | Pick one, stay with it |
| Auth | Supabase Auth or Auth.js | Lock to your email only (see Security) |
| Plaid | `plaid` (Node SDK) + `react-plaid-link` | |
| Hosting | Vercel (free tier) | Gives you the public HTTPS URL Plaid needs |
| Phone | PWA (Add to Home Screen) | No App Store, no $99/yr fee |

Alternatives are fine (React + FastAPI, etc.). The only hard requirement is a **backend that holds Plaid secrets**. Never put them in client code.

---

## 4. System diagram

```
┌────────────────────┐        ┌──────────────────────────────┐
│  Browser / iPhone  │        │          Plaid               │
│  (Next.js UI, PWA) │        │  Link UI · API · Webhooks    │
└─────────┬──────────┘        └───────▲───────────┬──────────┘
          │ HTTPS                     │ API calls │ webhooks
          ▼                           │           ▼
┌─────────────────────────────────────┴───────────────────────┐
│                  Next.js server (API routes)                │
│  /api/plaid/link-token   /api/plaid/exchange                │
│  /api/plaid/webhook      /api/transactions  /api/budgets    │
│  /api/accounts           /api/recurring                     │
└─────────────────────────────┬───────────────────────────────┘
                              │
                              ▼
                  ┌───────────────────────┐
                  │       Postgres        │
                  │ items · accounts ·    │
                  │ transactions · budgets│
                  └───────────────────────┘
```

---

## 5. Core Plaid flows

### 5.1 Linking an account
1. UI calls `POST /api/plaid/link-token`.
2. Server calls Plaid `/link/token/create` (products: `transactions`; `optional_products`: `liabilities` and `investments`, so institutions that don't support them still link; set `webhook` URL and, for OAuth banks, `redirect_uri`). **Request enough history up front** via the Transactions `days_requested` option (at least 180 days for Recurring Transactions; more if you want longer trends). Plaid says this only takes effect the first time an Item is initialized with Transactions, so on the Trial plan you can't fix it later without spending another slot.
3. UI opens Plaid Link with that token.
4. On success Link returns a `public_token`; UI sends it to `POST /api/plaid/exchange`.
5. Server calls `/item/public_token/exchange` → gets `access_token` + `item_id`.
6. Server **encrypts and stores** the `access_token`, then kicks off the first sync.

### 5.2 Syncing transactions
- Use **`/transactions/sync`** with a stored per-Item `cursor`. It returns `added`, `modified`, `removed`, and `next_cursor`.
- Loop while `has_more` is true; save the cursor only after the batch is committed to your DB.
- Upsert by `transaction_id`; delete anything in `removed`.
- Trigger syncs from the **`SYNC_UPDATES_AVAILABLE`** webhook, plus a manual "Refresh" button.
- Plaid returns a `personal_finance_category` on each transaction. Use it as your default category; let the user override.

### 5.3 Webhooks
- Endpoint: `POST /api/plaid/webhook`.
- **Verify the webhook signature** (Plaid sends a JWT in the `Plaid-Verification` header) before trusting it.
- Handle: `SYNC_UPDATES_AVAILABLE`, `ITEM` errors (e.g. `PENDING_EXPIRATION`, login required).
- For local dev, expose localhost with a tunnel (cloudflared/ngrok), or just test against your Vercel preview URL.

### 5.4 Re-auth
When an Item enters a login-required state, create a Link token in **update mode** for that Item instead of a new Item. This avoids burning a slot.

### 5.5 Subscriptions
Two options:
- Plaid's recurring transactions endpoint (`/transactions/recurring/get`). It's an add-on to Transactions that you request access to, so confirm it's enabled for your Trial team. It works best with at least 180 days of history (see 5.1), and there's a `RECURRING_TRANSACTIONS_UPDATE` webhook. In Sandbox, the `user_transactions_dynamic` test user has six months of recurring data.
- Fallback (build this regardless, it's small): group by merchant, look for a consistent amount and a roughly weekly/monthly/annual interval.

### 5.6 Net worth, liabilities, and investments
- **Balances:** `/accounts/get` returns cached balances and is fine for daily snapshots. Use `/accounts/balance/get` only when you need a real-time number.
- **Liabilities:** `/liabilities/get` returns credit card, student loan, and mortgage details (APRs, minimum payment, due dates). Plaid recommends using Liabilities together with Transactions for full loan details. Store the latest snapshot per account.
- **Investments:** `/investments/holdings/get` (positions + securities) and `/investments/transactions/get` (buys, sells, dividends, fees). Prices are as of the last update, not live quotes.
- **Net worth** = sum of asset account balances + holdings value + manual assets − (credit card balances + loans + manual liabilities). Plaid reports credit/loan balances as positive amounts owed, so flip the sign by account type at ingest.
- **History:** Plaid gives you *current* balances, not a net-worth history. Run a **daily scheduled job** (Vercel Cron) that writes one `net_worth_snapshots` row per day. Start it early, since you can't backfill what you didn't record.
- Watch for double counting: a brokerage's cash balance can appear both as an account balance and inside holdings. Pick one source per account type and document it.

---

## 6. Data model (v1)

```
users           id, email, created_at

items           id, user_id, plaid_item_id (unique),
                access_token_encrypted, institution_name,
                cursor, status, created_at

accounts        id, item_id, plaid_account_id (unique), name, mask,
                type, subtype, current_balance, available_balance,
                iso_currency, updated_at

transactions    id, account_id, plaid_transaction_id (unique),
                date, authorized_date, amount, merchant_name, name,
                plaid_category_primary, plaid_category_detailed,
                category_override, pending, notes, created_at

budgets         id, user_id, category, monthly_limit

recurring       id, user_id, merchant_name, avg_amount, frequency,
                last_date, next_expected_date, active

securities      id, plaid_security_id (unique), name, ticker,
                type, close_price, close_price_as_of

holdings        id, account_id, security_id, quantity,
                institution_price, institution_value, cost_basis,
                updated_at

investment_txns id, account_id, plaid_investment_txn_id (unique),
                security_id, date, type, subtype, quantity,
                price, amount, fees

liabilities     id, account_id, kind (credit | student | mortgage),
                apr, minimum_payment, next_due_date,
                last_statement_balance, raw_json, updated_at

manual_accounts id, user_id, name, kind (asset | liability),
                value, updated_at

net_worth_snapshots
                id, user_id, snapshot_date (unique per user),
                assets_total, liabilities_total, net_worth,
                breakdown_json
```

Notes:
- Plaid amounts are **positive for money out** and negative for money in. Normalize once, at ingest, and document it.
- Store `plaid_account_id` / `plaid_transaction_id` with unique constraints so syncs are idempotent.
- Pending transactions get replaced when they post; rely on `removed` + `added` from sync rather than trying to match them by hand.

---

## 7. API routes (v1)

| Route | Purpose |
|---|---|
| `POST /api/plaid/link-token` | Create Link token (new or update mode) |
| `POST /api/plaid/exchange` | Exchange public_token, store Item |
| `POST /api/plaid/webhook` | Receive Plaid webhooks |
| `POST /api/sync` | Manual sync for one/all Items |
| `GET /api/accounts` | Accounts + balances |
| `GET /api/transactions` | Filter by date, account, category, search |
| `PATCH /api/transactions/:id` | Re-categorize, add notes |
| `GET/PUT /api/budgets` | Read/set category budgets |
| `GET /api/recurring` | Subscription list |
| `GET /api/summary` | Month spend by category |
| `GET /api/net-worth` | Current net worth + history from snapshots |
| `GET /api/investments` | Holdings and investment transactions |
| `GET /api/liabilities` | Loans and credit card details |
| `GET/POST/PATCH /api/manual-accounts` | Manual assets and liabilities |
| `GET /api/cron/snapshot` | Daily net-worth snapshot (protect with a cron secret) |

---

## 8. Security checklist

You're storing credentials-adjacent data, so do these from the start:

- [ ] Plaid `client_id` / `secret` only in server env vars; **never** in client bundles or git
- [ ] `.env*` in `.gitignore` before the first commit
- [ ] Encrypt `access_token` at rest (AES-256-GCM with a key from an env var, or Supabase Vault)
- [ ] **Disable public signups.** Allowlist your own email so strangers can't create accounts and consume your 10-Item cap
- [ ] Every API route checks the session and scopes queries by `user_id`
- [ ] Verify Plaid webhook signatures
- [ ] Don't log access tokens or full transaction payloads
- [ ] Enable 2FA on your Plaid, Vercel, database, and GitHub accounts
- [ ] Use separate Sandbox and Production keys/environments

---

## 9. iPhone strategy

1. **Responsive web UI** (mobile-first layouts, large tap targets).
2. **PWA:** add a `manifest.webmanifest`, an `apple-touch-icon`, and `display: standalone`, then use Safari → Share → Add to Home Screen.
3. **Test early, in Sandbox:** I couldn't find Plaid documentation that confirms OAuth Link works inside an iOS home-screen web app. Developers have historically reported OAuth redirects leaving a standalone PWA for Safari and not returning, though that evidence is old and iOS may have changed. Settle it empirically before you spend a real Trial slot: check Plaid's OAuth guide for the Sandbox OAuth test institution and run it from the installed PWA on your phone.
   - **Fallback A (simplest):** link accounts from a regular Safari tab, and use the PWA only for day-to-day viewing. You'll only link a handful of accounts ever.
   - **Fallback B:** Plaid's Hosted Link, where Plaid hosts the Link flow at a URL you open in the browser and your server learns the result via webhook. Check the current docs for setup.
4. Your `redirect_uri` must be HTTPS and registered in the Plaid Dashboard.
5. **A home-screen app is not a browser tab, and the theme needs two mechanisms because of it.** An inline script in `layout.tsx` applies the theme before first paint — the only way to avoid a flash of the wrong theme. But closing the app and reopening it can restore the saved document rather than re-fetching it, and the restore can land with `<html>` missing the `dark` class that script added. Nothing noticed: `ThemeToggle` lives inside the user menu, so no component on the page owned the class. The result was the toggle reading `dark` from localStorage and showing dark pressed while the page rendered light — indistinguishable, to the person looking at it, from the toggle being broken.
   - `ThemeApplier` in the root layout is the repair net, re-checking on `visibilitychange` and `pageshow`. It is not a replacement for the script and must not become one: a class set from an effect lands after React has painted, so relying on it alone would flash light on every load.
   - Anything that reads the stored theme on a later render must resolve it the same way as the script. These three disagreed once already (`localStorage.getItem("theme") ? ... : prefersDark` never consulted the OS for a stored `"system"`) and the symptom looked like a broken toggle rather than three pieces disagreeing.
6. **Balances can be hidden, and the preference is a cookie rather than client state.** Press the net worth figure — on the dashboard or on `/net-worth` — to mask every balance on every page. Every masked figure is the same five characters: `*****`, whatever it was.
   - **Why a cookie, when the theme uses `localStorage`.** With the preference in `localStorage` the server cannot know it, so it renders the real figures, they sit in the HTML and the RSC payload, and they are on screen until the client hydrates and masks them. For a screen share that is the entire window the feature exists to close, and it reopens on every reload. Reading it from a cookie means the first paint is already masked. The cost is a POST and a re-render per toggle, which for a deliberate privacy action is the right trade.
   - **Why one constant rather than a shape-preserving mask.** The first version replaced only the digits and kept the rest — `$4,600.00` came out as `$*,***.**`, the same width as the original so nothing reflowed. That was an encoding of the number: the comma count and decimal point survived, so someone glancing at the screen could count them and place a balance within an order of magnitude. Preserving layout is worth less than not leaking. The cost is that columns reflow when you toggle, because `*****` is narrower than most amounts — visible, and a far better leak than the one it replaced.
   - The consequence worth remembering: **nothing about the value may vary in the mask.** Not the digit count, not the sign, not the currency, not compact-versus-full. Each of those is asserted directly in `tests/mask.test.mts`, because a mask that quietly started preserving one of them would look correct and still leak.
   - **What it does not cover.** Charts keep their shape: a line that rose is still visibly a line that rose. Masking the numbers is the line drawn, and it is worth stating rather than implying the charts are hidden too.
   - **What is out of scope by decision.** Spending and plan figures — the bar list, cash flow, the budget worksheet, transaction amounts — are not masked. "Hide balances" means balances: net worth, account balances, loan balances. Extending it to spending is a separate decision that would empty half the app.
   - `tests/hide-balances.test.mts` asserts the wiring rather than trusting review. A page can render a figure in a dozen places, and a missed one is quiet: the page looks right and one number is simply not masked.
7. Native iOS (SwiftUI + Plaid iOS SDK, or React Native) comes later and reuses the same backend. Running your own build on your own phone is free via Xcode, but it needs re-signing about weekly; a $99/yr Apple Developer account removes that.

---

## 10. Suggested folder structure

```
finance-app/
├─ app/
│  ├─ (auth)/login/
│  ├─ dashboard/
│  ├─ transactions/
│  ├─ budgets/
│  ├─ subscriptions/
│  └─ api/
│     ├─ plaid/{link-token,exchange,webhook}/route.ts
│     ├─ sync/route.ts
│     ├─ accounts/route.ts
│     ├─ transactions/route.ts
│     ├─ budgets/route.ts
│     ├─ recurring/route.ts
│     └─ summary/route.ts
├─ lib/
│  ├─ plaid.ts          # Plaid client setup
│  ├─ sync.ts           # transactions/sync loop
│  ├─ crypto.ts         # encrypt/decrypt tokens
│  ├─ db/               # schema + queries
│  └─ recurring.ts      # fallback subscription detection
├─ components/
├─ public/              # manifest, icons
├─ .env.local           # NEVER commit
└─ README.md
```

### Environment variables
```
PLAID_CLIENT_ID=
PLAID_SECRET=             # sandbox secret first, production later
PLAID_ENV=sandbox         # sandbox | production
PLAID_WEBHOOK_URL=
PLAID_REDIRECT_URI=
DATABASE_URL=
TOKEN_ENCRYPTION_KEY=     # 32 random bytes, base64
AUTH_SECRET=
ALLOWED_EMAIL=            # your email only
```

---

## 11. Build phases

**Phase 0 — Setup (an evening)**
- Sign up for a new Plaid team at dashboard.plaid.com/signup and take the **Trial plan** path. Do **not** submit a Production access application, because that's one-way and ends Trial eligibility
- Grab Sandbox keys; list the institutions you want to link and check the list fits in 10 Items
- Scaffold Next.js, set up Postgres + ORM + auth (allowlisted)
- Deploy a hello-world to Vercel

**Phase 1 — Sandbox linking**
- Link token + Link UI + exchange → store encrypted token
- Sandbox login: `user_good` / `pass_good`

**Phase 2 — Sync**
- `/transactions/sync` loop with cursor, upserts, removals
- Webhook endpoint with signature verification
- Accounts + transactions pages

**Phase 3 — Features**
- Category overrides, budgets, monthly summary, net worth
- Subscriptions (Plaid recurring or your own detection)
- Liabilities + Investments sync, manual accounts
- Net worth page and the daily snapshot cron (start recording early)

**Phase 4 — PWA + polish**
- Manifest/icons, mobile layout pass, test on iPhone
- Test OAuth bank linking in PWA vs. Safari

**Phase 5 — Go live with real data**
- Switch to Production keys, double-check the Trial plan is active and (if you want it) Recurring Transactions is enabled
- Confirm `days_requested` is set to what you want *before* the first real link; it can't be changed on an initialized Item
- Connect **one** real account first and confirm the sync before adding more (remember: slots are permanent)

---

## 12. Open questions

### Resolved
- **Trial bundle contents:** Transactions, Liabilities, Investments, Balance, Auth, Identity, Assets, and Statements are all included. See section 2.
- **Recurring Transactions:** it's an optional add-on and isn't named in the Trial bundle. Treat it as unconfirmed and build the fallback detector.
- **Institutions:** only US and Canadian institutions work on Trial; major OAuth banks are covered.
- **Plaid account:** you don't have one yet, so a new team should qualify for Trial. Just don't submit a Production application.
- **V1 scope:** everything. Spending, Liabilities, Investments, and net worth with manual accounts (sections 1 and 5.6).

### Still open
- **Does OAuth Link work in the home-screen PWA?** Can only be answered by testing on your iPhone (see section 9).
- **Is Recurring Transactions enabled for your team?** Ask Plaid support once your team exists.
- **Does your institution list fit in 10 Items?** List every bank, card, brokerage, 401k, and loan servicer you want to link.
- **Do all your institutions support Liabilities/Investments through Plaid?** Some won't; those fall back to manual accounts.

---

## 13. Useful docs to bookmark

- Plaid Quickstart (Node + React): https://plaid.com/docs/quickstart/
- Transactions Sync: https://plaid.com/docs/transactions/sync-migration/
- Webhook verification: https://plaid.com/docs/api/webhooks/webhook-verification/
- Link update mode: https://plaid.com/docs/link/update-mode/
- Sandbox test credentials: https://plaid.com/docs/sandbox/test-credentials/
