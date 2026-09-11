# Session Note for Reviewing Agent (2026-09-10, evening)

## 1. What this project is

`simlife-investing/` (sibling of `codeworld/` in `/Users/justinlee/Desktop/_Active/ths_textbook/`)
is an **isolated experimental classroom brokerage simulator** for a high-school
Personal Finance class. All money is simulated; no real brokerage, no advice.
Stack: Express 4 API + React 19 + Vite 6, `tsx` runner, `pg` for Postgres with
a `node:sqlite` file fallback for offline dev. No ORM.

## 2. Safety boundary (HARD — do not violate)

- **`codeworld/` is read-only reference.** Never modify, move, rename, format,
  or delete anything under it. The owner works there from other sessions; a
  `Platform.ts` edit from another session is currently uncommitted and NOT ours.
- Never open or copy `../codeworld/.env`. Never reference its `DATABASE_URL`.
- Our secrets live only in `simlife-investing/.env` (gitignored). Do not print
  secrets to chat/logs, do not commit them, do not paste them into docs.
- Do not deploy anything or create paid services without the owner's approval.

## 3. Architecture (see ARCHITECTURE.md for the full doc)

- Ports: web **3100**, api **4101** (`SIMLIFE_PORT`). Session cookie `sl_session`
  (HMAC, own secret). All env vars `SIMLIFE_*`.
- DB: `SIMLIFE_DATABASE_URL` → Postgres; empty → local SQLite `data/simlife.db`.
  One SQL dialect subset (`?` placeholders rewritten to `$n` for pg). Schema is
  boot-time additive (`initSchema()` + `ensureColumn()` in `server/db.ts`).
- Auth: Google ID tokens verified with `google-auth-library` `verifyIdToken`
  (NOT tokeninfo). Roles server-side from `SIMLIFE_TEACHER_EMAILS`. Domain lock
  via `SIMLIFE_ALLOWED_GOOGLE_DOMAIN`. Demo login exists only when
  `SIMLIFE_DEMO_AUTH=true` AND `NODE_ENV!=production` (server 404s otherwise).
- Ledger (`server/ledger.ts`): append-only; integer cents + integer micro-shares;
  every mutation is one DB transaction writing the ledger row AND
  `accounts.cash_cents`. Invariant `cash == SUM(amount)`. Idempotency keys
  (UNIQUE). Teacher removals/reversals never go negative — 422 with "sell
  first" message. Average-cost basis. **Do not alter accounting semantics
  without running `npm test` (18 tests must stay green).**
- Quotes (`server/quotes.ts`): `QuoteProvider` interface; `MockQuoteProvider`
  default; `StooqQuoteProvider` opt-in via `SIMLIFE_QUOTE_PROVIDER=stooq`;
  `CachedQuotes` 60s TTL. Every price labeled delayed with timestamp+source.
- Frontend (`src/`): no router; conditional views. The warm paper/olive visual
  system matches CodeWorld's level of finish while remaining recognizably
  SimLife — keep it coherent.

## 4. Current environment state (important context)

- `.env` (local only): `SIMLIFE_DATABASE_URL` → Supabase project **financeWRLD**,
  ca-central-1, transaction pooler. `SIMLIFE_GOOGLE_CLIENT_ID` set (real ID).
  `SIMLIFE_ALLOWED_GOOGLE_DOMAIN` is **temporarily blank for testing —
  MUST be restored to `tcitys.org` before students use this.**
  `SIMLIFE_DEMO_AUTH=true` (disable before go-live).
- Local dev currently reads/writes the live financeWRLD DB (URL is set).
- Google Cloud side: `http://127.0.0.1:3100` + `https://codebloom-v70b.onrender.com`
  are authorized JS origins on the owner's OAuth client.
- Servers run as background `nohup` processes (api 4101, vite 3100); they die
  on reboot/kill. Restart: `SIMLIFE_PORT=4101 npx tsx server/index.ts` and
  `npx vite --host 127.0.0.1 --port 3100 --strictPort` from the project dir.

## 5. Data state in financeWRLD

- Classes: `class-p3-2026` "3rd Period — Personal Finance" (join `PERIOD3`),
  `class-p4-2026` (join `PERIOD4`), `demo-class-1` (`DEMO1`).
- 42 real students (`p3-*`, `p4-*`), all brokerage $0, seeded from
  `server/seed-data/third-period.json` + `fourth-period.json` (these JSONs also
  hold the teacher-pasted ClassBank checking/savings reference figures).
  Seed scripts: `npm run seed:third`, `npm run seed:fourth` (idempotent).
- 5 demo accounts (`demo-*`) exist in the DB — **delete before go-live**.
- Real-student ledger is clean except: Aniya Bates has an offsetting
  add+reversal pair from an early Postgres smoke test (balance $0, correct).
- Roster open items (also in the JSONs): Jeremiah Henry + Serenity Harper
  missing from ClassBank pastes; ~2 registrar names unaccounted per period;
  unconfirmed mappings (`tj samuel`→Tremayne Samuel Jr., Leah→Daleah Stewart);
  Aviyonna Prince job mismatch (Accountant vs CNA).

## 6. What changed today (post-MVP)

1. **Teacher dashboard upgrade** (`src/App.tsx` Teacher component): All/class
   pills, sortable roster columns (cash, invested, portfolio, gain/loss,
   trades, last active with `fmtWhen` relative times), click-any-row profile
   drawer (joined/last-active, ClassBank reference panel, cash added/removed
   totals, activity counts, holdings, history). New endpoints:
   `GET /api/teacher/reference?classId=`, enriched `GET /api/teacher/roster`
   (works with empty classId = all) and `GET /api/teacher/student`
   (+counts, +totals). New `users.last_active_at` column + heartbeat in
   `currentUser()` and both login routes. Styles appended to `src/styles.css`.
2. **Perf fix**: roster was N sequential `portfolioFor()` calls (~45 round-trips).
   Now one aggregate ledger query (`ANY(?)` on pg, `IN (...)` on sqlite) +
   one quote batch. Measured 0.09–0.18s per switch against ca-central-1.
3. **Postgres NUMERIC fix** (`server/db.ts`): `SUM()`/`COUNT()` come back as
   strings from node-pg, which broke `sellAll` (`Number.isInteger`) and the
   invariant `===`. Added type parsers (OID 1700 + INT8 → Number). SQLite
   masked this; tests run on SQLite.
4. **Test isolation fix**: suite now `delete process.env.SIMLIFE_DATABASE_URL`
   so it always uses temp SQLite files (it once wrote 8 rows to financeWRLD;
   removed via cascade delete — verified gone).
5. `POST /api/demo/quote` (demo-only mock price override) supports the
   "what-if-it-goes-up" classroom demo; 404 in production.
6. **Student Portfolio redesign** (`src/App.tsx`, `src/styles.css`): holdings
   are now a compact, responsive Portfolio with ticker search, sorting,
   expandable detail/sell controls, and 15-item pagination. It avoids
   horizontal scrolling and remains usable with large holding counts.
7. **Banking second pass on `experiment/simlife-banking`**: replaced the first
   serious-looking banking screen with a playful, ClassBank-familiar SimLife
   dashboard while leaving Brokerage styling alone. Students now have checking,
   interest-bearing savings with a projection graph, brokerage transfer,
   document-style mail, full/partial bill payments, and question/dispute
   submission. Engineering additions include immutable payment/dispute rows,
   preserved correspondence, idempotency-detail conflicts, legacy paid-bill
   compatibility, and stronger per-student/bill locking order for Postgres.
   Full review and remaining scope: `BANKING_REVIEW.md`.

## 7. Verification status (all green as of this note)

- `npm run typecheck` clean (client + server). On the banking branch,
  `npm test` is **35/35** (17 banking plus 18 existing tests).
- `npm run build` succeeds; prod boot serves `dist/` with `demoEnabled:false`
  and demo login 404 (verified on port 4102).
- Live Postgres round-trips verified: fund → buy → roster math → sell-all →
  reversal → overdraw-422 → freeze-423 → student-on-teacher-route-403.
- `codeworld/` untouched by this session (only reads + `git status`/`git diff`).

## 8. Known limitations / suggested next work (not bugs)

- Audit table loads 500 rows unbounded — fine now, but paginate if it janks
  with real trade volume.
- `counts.n` / `totals.*` arrive as numbers post-fix; frontend coerces safely.
- Supabase free cold starts: first request after idle is slow (same for
  CodeWorld); uptime pinger covers both when deployed.
- NOT yet built: `BASE_PATH` support for serving under
  `codebloom-v70b.onrender.com/investing` (the firewall strategy — planned,
  no code yet); CSV roster import; real deployment; `stooq` evaluation.
- Pending owner decisions: restore domain lock, delete demo accounts,
  roster identity confirmations (§5), approve student starting amounts.

## 8a. Product-direction update

The owner is considering expanding this isolated application into a broader
**SimLife** one-stop shop with checking, savings, paychecks, student-paid bills,
and atomic transfers into the existing brokerage. The brokerage on `main` is
the known-good fallback. Banking work must be developed on
`experiment/simlife-banking` in a separate `simlife-banking/` Git worktree and
must not be merged until separately reviewed. See
`OPENCODE_NEXT_DIRECTIVE.md`.

## 8b. Banking branch state after owner-requested review

The banking worktree now implements the intended first-version student model:
checking pays mail-delivered bills, savings accrues a configurable classroom
APY, and checking can fund the existing brokerage. Partial bill balances remain
visible. The default APY is 3.40% as of 2026-09-07 and is configurable through
`SIMLIFE_SAVINGS_*`; it is presented as a variable high-yield benchmark, not a
universal bank rate. This pass used only a temporary SQLite database.

The next agent directive has been narrowed to the teacher dispute inbox and
resolution workflow plus Postgres-compatible review. PDF/file uploads,
deployment, live migrations, and merging remain explicitly out of scope.

## 9. Guidance for the reviewing agent

- Stylistic/UI refinements to the dashboard and student views are welcome and
  expected. Keep the SimLife color scheme and the ever-present SIMULATED labels.
- Do not weaken: server-side role checks, reason-required adjustments,
  no-negative-cash rule, idempotency, append-only ledger, demo-gating.
- After any change: `npm run typecheck`, `npm test`, and one boot smoke test
  (`/api/health`). If you touch SQL, sanity-check both dialects (tests cover
  SQLite; reason about Postgres types — see §6.3).
- Commands: `npm run dev` (3100+4101) · `npm test` · `npm run seed:third` /
  `seed:fourth` (idempotent) · `npm run build` + `npm start` (prod).

## 10. Dispute-inbox follow-up (branch `experiment/simlife-banking`, unmerged)

Teacher side of student bill questions is built: class-filtered inbox,
reply-and-resolve with resolver/timestamp audit, no-overwrite semantics
(dedupe / 409 conflict / 409 resolved), student-visible replies in the same
mail document, pay-while-open preserved. 39/39 tests. Docs updated in
`BANKING_REVIEW.md` (includes Postgres lock-order reasoning and an
attachment-design note for later). Prod fail-closed gates re-verified.
Nothing merged, nothing deployed, no live data touched. ChromeOS/browser
pass still owed.
