# SimLife Investing — Session Handoff

## What works (verified 2026-09-10, all local)

- **Isolated app** in `simlife-investing/` — own package, ports (web 3100, api
  4101), session cookie (`sl_session`), env (`SIMLIFE_*`), database
  (SQLite file locally, Postgres via `SIMLIFE_DATABASE_URL` in deploy).
- **Auth**: district Google sign-in via `google-auth-library`
  `verifyIdToken` (not tokeninfo), domain restriction, server-side
  teacher/student roles. Demo login works locally, returns **404 in
  production** (verified: `demoEnabled:false`, `index.html:200`).
- **Ledger**: integer cents, micro-shares, immutable append-only entries with
  price/qty/timestamps/source; idempotency keys; average-cost basis.
- **Teacher controls**: add/remove cash (reason + confirm required), safe
  reversal (compensating entry, double-reversal blocked), per-class
  freeze/reopen, roster, full audit log.
- **Student**: ticker search, cached delayed quotes with timestamps,
  fractional buys (shares or dollars), sell partial/all, holdings with
  per-holding + total gain/loss, complete history. "SIMULATED" labels throughout.
- **Full QA workflow passed live**: +$500 cash → buy $585 VOO → mock price
  $585→$620 → +$35 gain shown → sell all ($620) → −$200 cash removal →
  −$5,000 overdraw correctly rejected (422) → freeze blocks buys (423) →
  reopen → student blocked from teacher endpoints (403) → reversal +$200 →
  double reversal rejected. Cash ended at $1,535.00, invariant holds.
- **15/15 automated tests pass** (`npm test`); **typecheck clean**;
  **production build succeeds**; prod boot serves `dist/` with demo disabled.

## What remains mocked

- Market data: `MockQuoteProvider` default (fixed classroom prices; demo-only
  `POST /api/demo/quote` override for "what if it goes up?" — 404 in prod).
- Demo users/class (`DEMO1`) are fictional and dev-only.
- No ClassBank link yet — teacher cash adjustment is the manual bridge.

## What requires credentials (not yet done — needs your approval)

- Own Supabase/Postgres project → `SIMLIFE_DATABASE_URL` (local SQLite works until then).
- Google OAuth client id → `SIMLIFE_GOOGLE_CLIENT_ID` (+ authorized origin
  for the deployed URL); `SIMLIFE_TEACHER_EMAILS`, `SIMLIFE_SESSION_SECRET`.
- Optional: `SIMLIFE_QUOTE_PROVIDER=stooq` for free delayed live quotes (no
  key). See `MARKET_DATA.md` before projecting live prices (terms check).
- No deployment made, no paid services created.

## Known risks / follow-ups

- Single-teacher assumption (same as CodeWorld): teacher endpoints check role,
  not class ownership. Scope per-teacher before a second teacher arrives.
- Average-cost basis only; quotes delayed by design; no charts (intentional).
- Layout checked at code level (responsive grid, 760px breakpoint) — verify
  once on a real Chromebook; no headless browser was available here.
- `node:sqlite` prints an ExperimentalWarning on boot — harmless, no action.

## Exact commands

```bash
cd /Users/justinlee/Desktop/_Active/ths_textbook/simlife-investing
cp .env.example .env   # first time only (gitignored)
npm install
npm run seed           # demo teacher + class (DEMO1) + 4 fictional students
npm run dev            # http://127.0.0.1:3100  (api :4101)
npm test               # 15 accounting/authorization tests
npm run typecheck; npm run build; npm start  # prod equivalents
```

## Update 2026-09-10 (afternoon)

- Google OAuth live (`SIMLIFE_GOOGLE_CLIENT_ID` set); domain lock temporarily
  blank for testing — **restore `tcitys.org` before students use it**.
- financeWRLD (Supabase, ca-central-1) wired as `SIMLIFE_DATABASE_URL`;
  3rd + 4th period rosters seeded (42 students at $0); smoke-tested cash
  add + reversal on Postgres.
- Teacher dashboard upgraded (CodeWorld patterns, SimLife scheme): All/class
  pills, sortable roster (cash, portfolio, gain/loss, trades, last active),
  per-student profile drawer with ClassBank reference snapshot, cash
  totals, and full history. `users.last_active_at` heartbeat added.
- Tests hardened: suite now deletes `SIMLIFE_DATABASE_URL` so it can never
  run against the real DB (it leaked 8 rows once; removed via cascade).
- Local dev now reads/writes financeWRLD. Demo accounts still exist there;
  delete before go-live, then `SIMLIFE_DEMO_AUTH=false`.

## Evidence codeworld/ was not changed

`git -C ../codeworld status --short` and `git diff --stat` both empty after
every phase (final check 2026-09-10). No files under `codeworld/` were
written; its `.env` was never opened. `SIMLIFE_DATABASE_URL` never references
`DATABASE_URL`.
