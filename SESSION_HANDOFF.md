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

---

## Class tab / first module (2026-09-21)

The Class tab and its first module (sector sort) are described in
`CLASS_MODULE_STATUS.md` — what is built, what was actually verified in a
browser, and what is explicitly NOT yet verified. Read that before changing
anything under `server/sorting.ts` or the Class parts of `src/App.tsx`.

Related design docs: `CLASS_TAB_PLAN.md`, `MODULE_WEEK2_BALANCED_PORTFOLIO.md`,
`LEADERBOARD_PLAN.md`.

---

## Update 2026-09-22 — submit model, drafts, Modules + Module 2 live

Commits on `origin/main` (all pushed, Render auto-deploys):
`17b97be` class tab + sector data · `92ad5ba` drag-drop sort + teacher
dashboard · `726f01f` submit-for-teacher-check (no scores shown to students)
· `137469b` Save-for-later draft next to Submit · `6115741` dynamic class
feed + portfolio mission · `5848fb8` "Your field guide" → "Modules",
Module 2 mission seed, per-class hide checkboxes.

Student model now: **Save** (partial OK, server draft, "Draft saved" badge,
resume across devices) → **Submit** (requires all placed, teacher checks it).
Grading never leaves the server for students; drafts are never submissions and
never shown on the teacher portal. Submit clears the draft.

Teacher model: Class page has **"Modules shown to this class"** — per-class
checkbox grid (CodeWorld pattern: store hidden set, save whole state at once,
Show all / Hide all). Hidden = presentation-only; progress + submissions kept.
Module numbers are chronological and stable when something is hidden.

Live prod state (verified 2026-09-22 via read-only query + seed runs):
- Module 1: sector sort `sact_gVYh5qvdjwnv_IHs` (published, class=null).
- Module 2: "Build a five-sector portfolio" `cpost_QnyDY8gXb8gPpQsK`
  (published, class=null) — seeded with `npm run seed:mission`. Pushing code
  does NOT create it; the seed must be run against the target DB (idempotent).
- `class_hidden_modules` exists live, hidden set empty (nothing hidden).
- `npm run seed:sort` was run against prod 2026-09-21; `seed:mission` 2026-09-22.

Health: **91/91 tests pass**, client + server typecheck clean, `npm run build`
clean. Working tree clean.

Still open:
1. Browser check for hide/unhide (interrupted by usage limit): untick Module 2
   for one class, confirm student loses it, re-tick, confirm it returns as
   Module 2 (not renumbered).
2. `CLASS_MODULE_STATUS.md` is stale (says 81 tests, Module 2 "not built").
   Update or delete it.
3. `npm run dev` reads/writes PROD Supabase (`.env` sets
   `SIMLIFE_DATABASE_URL`). Unset it for a local SQLite sandbox.
4. Old browser-verified gaps in `CLASS_MODULE_STATUS.md` (drag over empty
   space, reload mid-sort with drafts now, no-class student, teacher class
   filter, concurrent submits) — still unverified against production.

---

## Update 2026-09-22 (evening) — Module 2 guided flow, Class tab polish

Changes (working tree, not yet committed at time of writing):
- `src/App.tsx`: shared `ModuleHead` chrome (back link, mono eyebrow
  "Module N · kind", serif title); ClassSection opens modules via
  `{kind, id, moduleNumber}`; module cards unified (both `.module-card`,
  mission card shows `{goalsMet}/{goalCount} goals` + status badge).
- `PortfolioMission` rewritten as goals-first guided flow: assignment
  panel → "Where you stand" 5-goal checklist (plain-English next actions,
  progress bar, start-vs-now sector chips, Open Investing / Refresh) →
  write-up locked until `mission.met` → sticky `.module-action-bar`.
  Mission now allows resubmission (consistent with Module 1). Targets /
  evidence spec unchanged — pedagogy kept.
- `SortActivity` takes `moduleNumber`, uses `ModuleHead`, sticky action
  bar with "N of 12 placed / Draft saved / Submitted" status copy.
- `src/styles.css`: retired `.mission-hero`, `.mission-layout`,
  `.mission-step`, `.step-no`, `.research-pick`, `.mission-evidence`,
  `.sticky-card`, `.mission-check`, `.wide`, `.mission-submit-bar`;
  added `.module-head`, `.class-back`, `.module-detail`, `.module-page`,
  `.module-action-bar`, `.mission-brief-body`, `.mission-basket`,
  `.goals-*`, `.sector-chip` (+`.now`), `.explain-lock`, `.explain-pick`,
  `.pick-*`, `.reflect-field`, `.word-count`, `.sr-only`.
  `.module-card-body` set to `var(--sans)` (was inheriting mono from
  global `button` rule).
- `server/seed-portfolio-mission.ts`: now an **upsert** keyed on title —
  UPDATE summary/body/spec/hero_url if the row exists (never touches
  status/class scope/submissions), else create. Run against prod DB to
  ship the new copy: `npm run seed:mission`.

Verification (sandbox, local SQLite, mock quotes — never prod):
- `SIMLIFE_DATABASE_URL=` empty forces SQLite; port 3199/4199 to avoid
  the user's dev server on 3100/4101. Background processes do NOT survive
  between tool calls — servers + Playwright must run in one bash call.
- Playwright chromium check: **26/26 PASS** — module list numbering,
  Module 1 header/action bar/tap-to-place/draft save, Module 2 locked
  state (5 goals, no empty textareas, disabled submit), 6 buys meeting
  all goals, unlocked form, dropdown options, submit + notice.
  Screenshots: `/tmp/simlife-ui-check/{1-list,2-sort,3-mission-locked,
  4-mission-unlocked,5-mission-submitted}.png` — all reviewed, correct.
- Playwright gotchas: Chrome `innerText` uppercases `text-transform`
  (compare `.toLowerCase()`); use `allTextContents()` not
  `allTextValues()`; `page.reload()` resets SPA to dashboard (re-click
  Class nav).
- `npm test` (91), client + server typecheck, `npm run build` all clean.

Still open (in addition to the four above):
5. Commit + push these three modified files when the user says go
   (Render auto-deploys; run `npm run seed:mission` against prod after
   deploy to refresh the mission copy).
