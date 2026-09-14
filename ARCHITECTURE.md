# SimLife Investing — Architecture

Experimental classroom brokerage simulator. Simulated money only. No real
brokerage connections, no investment advice, no real financial data collection.

## 0. Safety boundary (nonnegotiable)

- Everything under `../codeworld/` is **read-only reference**. Never modify,
  move, rename, format, or delete anything there.
- Separate database (`SIMLIFE_DATABASE_URL`), separate session cookie
  (`sl_session`), separate ports (web **3100**, api **4101**), separate env
  file, separate deployment, separate Supabase project.
- After every milestone: `git -C ../codeworld diff -- codeworld` (run from the
  repo root as `git diff -- codeworld`) must show no changes.
- Work stays in this folder in its own Git repository. It is never merged into
  or deployed through the CodeWorld repository.

## 1. What was adapted from CodeWorld (patterns only, no code copied)

| CodeWorld pattern | SimLife adaptation |
|---|---|
| Express + Vite, one process serves API + static `dist/` in prod | Same shape, different ports (3100/4101) |
| Boot-time additive schema init (`CREATE TABLE IF NOT EXISTS`) | Same: `initSchema()` in `server/db.ts`, additive only, no down-migrations |
| HMAC-signed httpOnly session cookie (`cw_session`) | Same construction, own cookie name `sl_session`, own secret `SIMLIFE_SESSION_SECRET` |
| Teacher role from server-side email allowlist (`TEACHER_EMAILS`); students can never self-assign | Same: `SIMLIFE_TEACHER_EMAILS`, role set only at login/seed time |
| Google Workspace domain restriction (`ALLOWED_GOOGLE_DOMAIN`) | Same: `SIMLIFE_ALLOWED_GOOGLE_DOMAIN` |
| Classes with look-alike-free join codes, `upper(join_code)` unique index, skippable join gate | Same algo (`server/auth.ts`), own `classes` table |
| `/api/health` touches the DB (pinger-safe health check) | Same: `GET /api/health` runs `SELECT 1` |
| Teacher dashboard filtered by `?classId=` | Same |
| `.env.example` with placeholders only | Same |

## 2. Deliberate divergences from CodeWorld

1. **Google verification**: CodeWorld verifies ID tokens via Google's
   `tokeninfo` endpoint. SimLife uses the supported `google-auth-library`
   `OAuth2Client.verifyIdToken()` (proper signature + `aud` + `exp` + `iss`
   checks) server-side. Nothing tokeninfo-based is copied.
2. **Database**: CodeWorld requires Postgres at boot (`DATABASE_URL`).
   SimLife uses `SIMLIFE_DATABASE_URL` for Postgres/Supabase in production,
   and falls back to a local file-backed SQLite database (`data/simlife.db`,
   via `node:sqlite`) for development and tests. All SQL is written in a
   shared dialect subset (see §5) so both backends behave identically.
3. **No AI tutor, no lessons, no grading.** Out of scope by design.
4. **Shared design quality, separate product**: SimLife follows CodeWorld's warm
   paper, serif, mono-accent design system while retaining finance-specific
   account language and an always-visible simulation warning.

## 3. User roles

- `student`: owns exactly one brokerage account. Can view own portfolio,
  quotes, and history; can buy/sell (when trading open); can join a class.
  Can never touch another student's account or call teacher endpoints
  (enforced server-side on every route, tested).
- `teacher`: roster + audit for their classes. Can add/remove brokerage cash
  (reason required, confirmation required), reverse a cash adjustment,
  freeze/reopen trading per class, manage classes/join codes. Cannot trade
  on a student's account.
- Role is assigned server-side: email in `SIMLIFE_TEACHER_EMAILS` → teacher,
  else student. No client input influences role.

## 4. Routes

```
Public:            GET  /api/health
                   GET  /api/auth/config          { googleClientId, demoEnabled }
                   POST /api/auth/google          { credential } -> session
                   POST /api/auth/demo            { userId } (dev only, 404 in prod)
                   POST /api/auth/logout
Student (auth):    GET  /api/me
                   POST /api/classes/join         { code }
                   GET  /api/onboarding            first-login profile status/match
                   POST /api/onboarding/claim      confirm or propose corrections
                   GET  /api/portfolio            cash, holdings, values, gains
                   GET  /api/history              own ledger entries (newest first)
                   GET  /api/quotes?symbol=AAA    cached quote + timestamp
                   GET  /api/search?q=aa          ticker search
                   POST /api/trades/buy           { ticker, qtyMicro|dollars, idempotencyKey }
                   POST /api/trades/sell          { ticker, qtyMicro|all, idempotencyKey }
Teacher (auth+role):
                   GET  /api/teacher/onboarding?classId=
                   POST /api/teacher/onboarding/import
                   POST /api/teacher/onboarding/:id/approve
                   POST /api/teacher/onboarding/:id/assign
                   GET  /api/teacher/roster?classId=
                   POST /api/teacher/cash         { studentId, amountCents, reason, idempotencyKey }
                   POST /api/teacher/cash/reverse { entryId, reason, idempotencyKey }
                   POST /api/teacher/freeze       { classId, frozen }
                   GET  /api/teacher/audit?classId=|studentId=
                   POST /api/teacher/classes      { name, joinCode? }
```

All money endpoints require auth; teacher endpoints additionally require
`role === 'teacher'`. Students addressing another student's id get 403
(the account is resolved from the session, never from a client-supplied id).

## 5. Data model

```
users(id PK, email UNIQUE, name, role, google_sub UNIQUE NULL, class_id FK NULL, created_at)
classes(id PK, name, join_code UNIQUE on upper(), trading_frozen 0/1, created_at)
accounts(id PK, user_id UNIQUE FK, cash_cents INT NOT NULL DEFAULT 0)
ledger(id PK, account_id FK, kind, amount_cents, ticker NULL, qty_micro NULL,
       price_cents NULL, reason NULL, actor_id FK, idempotency_key UNIQUE,
       reverses_id NULL, quote_ts NULL, quote_source NULL, created_at)
```

First-login imports are staged separately from authenticated users:
`roster_imports` identifies an idempotent teacher import and `roster_profiles`
stores its unclaimed/pending/claimed rows. A profile can be offered only after
the student joins its class and only when the normalized name match is unique.
Confirmed checking/savings values create one `opening_balance` bank-journal
entry; confirmed brokerage cash creates a normal ledger cash adjustment. The
cached balances are updated inside the same transaction.

- **Money**: integer cents (`cash_cents`, `amount_cents`, `price_cents`).
- **Shares**: integer micro-shares (`qty_micro`, 1 share = 1,000,000 units)
  → supports fractional shares to 6 decimal places.
- **Dialect subset** (works on Postgres + SQLite): `TEXT` PKs (app-generated
  ids), `INTEGER`, `TEXT`, no booleans (0/1), timestamps as ISO-8601 `TEXT`,
  `?` placeholders for SQLite vs `$n` for Postgres handled by the db layer's
  `ph()` helper... actually implemented as: db layer exposes `q/one/run/tx`
  and rewrites `?` → `$n` for Postgres automatically. Single SQL source.

## 6. Ledger rules (source of truth)

1. The ledger is append-only. No UPDATE/DELETE on ledger rows, ever.
2. Every balance change writes its ledger entry in the **same DB transaction**
   as the `accounts.cash_cents` update (`SELECT … FOR UPDATE`-style row lock
   on Postgres; `BEGIN IMMEDIATE` on SQLite).
3. Invariant: `accounts.cash_cents == SUM(ledger.amount_cents)` per account.
   A test asserts this after every operation.
4. Entry kinds: `cash_adjust` (teacher add/remove), `cash_reversal`
   (compensating entry pointing at `reverses_id`), `buy` (cash leg negative +
   share leg positive in one row), `sell` (cash leg positive + share leg negative).
5. Teacher cash removal never liquidates: if `cash + delta < 0` → 422 with
   "student must sell investments first". Same for buys (insufficient cash)
   and sells (insufficient shares).
6. Every teacher adjustment requires a non-empty written `reason` (server-validated).
7. Every trade records `ticker, qty_micro, price_cents, quote_ts, quote_source`.
8. Idempotency: `idempotency_key TEXT UNIQUE`. Retried submissions with the
   same key return the original entry (200 + `deduped: true`) instead of
   double-executing. Clients generate one UUID per form submission and reuse
   it across retries/double-clicks.
9. Reversal (not deletion): a reversal inserts a compensating entry
   (`amount = -original.amount`, `reverses_id = original.id`) with its own
   reason. Double-reversal is rejected. A reversal that would drive cash
   negative is rejected (student must sell first — same rule).

## 7. Quote-provider interface

```ts
interface Quote { ticker, priceCents, asOf (ISO), source, delayed: boolean }
interface QuoteProvider {
  readonly name: string;                       // e.g. 'mock' | 'stooq'
  search(q: string): Promise<{ ticker, name }[]>;
  getQuote(ticker: string): Promise<Quote>;    // throws QuoteError('NOT_FOUND' | 'UNAVAILABLE')
}
```

- `MockQuoteProvider`: deterministic in-memory prices for dev/tests; prices
  adjustable at runtime (demo "price changes", concurrency tests).
- `StooqQuoteProvider` (optional, no key): free Stooq CSV endpoint, always
  flagged `delayed: true`. See `MARKET_DATA.md` for the recommendation.
- `CachedQuotes`: server-side TTL cache (60s) in front of whichever provider
  is configured; every quote shown with its timestamp; invalid tickers and
  provider outages return clean 4xx/503 JSON, never a stack trace.
- Keys stay server-side. The browser never calls a market-data vendor.
- No scraping of Google/Yahoo Finance.

## 8. Authentication & privacy

- Google Identity Services on the client; ID token POSTed to the server and
  verified with `google-auth-library` (`verifyIdToken`, audience =
  `SIMLIFE_GOOGLE_CLIENT_ID`). Domain restricted to
  `SIMLIFE_ALLOWED_GOOGLE_DOMAIN`. Teacher role from `SIMLIFE_TEACHER_EMAILS`.
- Demo auth (`POST /api/auth/demo`) exists only when `SIMLIFE_DEMO_AUTH=true`
  **and** `NODE_ENV !== 'production'` — the server returns 404 otherwise and
  the client hides demo UI unless `/api/auth/config` says `demoEnabled`.
- Minimum student data: name + school email + class. No financial, SSN,
  license, or brokerage info is ever requested.

## 9. Deployment separation

- Own Supabase/Postgres project; server reads **only** `SIMLIFE_DATABASE_URL`.
- Local ports: web **3100**, api **4101** (CodeWorld: 3000/4000).
- `.env.example` contains placeholders only; no secrets are ever copied from
  `../codeworld/.env` (which is never even opened).
- Prod: one Node process serves `dist/` + `/api` (same shape as CodeWorld's
  `DEPLOY.md`, but a separate service, separate repo folder, separate DB).

## 10. Design language

Clean, calm, student-friendly. CodeWorld's warm paper/serif/mono family with
restrained olive and rose finance accents. Always-visible
"SIMULATED MONEY — for class only" banner. Key figures in plain order: Cash
available, Amount invested, Portfolio value, Total gain/loss. No confetti, no
alarms, no casino language, no rapid-trading prompts, no leaderboards.
Teacher cash controls require typing a reason + an explicit confirm step.

## 11. Assumptions & open questions

- A1: Single-teacher-per-class is assumed (as in CodeWorld); teacher endpoints
  check role, not class ownership. Must scope before a second teacher arrives.
- A2: Average-cost basis for gain/loss. Fine for class; not tax accounting.
- A3: Stooq free tier is acceptable for classroom demo; verify its terms with
  the district before projecting live prices in class (see MARKET_DATA.md).
- Q1: Should ClassBank transfers auto-credit brokerage cash later? Deferred —
  teacher adjustment is the manual bridge for now.
- Q2: Do we need per-student cost-basis method choice (FIFO vs average)?
  No — average cost for the MVP.
- Q3: Intraday vs closing prices for grading consistency? TBD; quotes always
  carry timestamps so the teacher can define the rule.
