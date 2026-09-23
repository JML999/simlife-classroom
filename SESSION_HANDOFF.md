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

## Update 2026-09-22 (night) — teacher dashboard: module stats + drawer Modules panel

Changes (working tree, not yet committed at time of writing):
- `server/module-progress.ts` (NEW): per-student module aggregation.
  Status = `not_started` / `in_progress` / `submitted` (sort draft or any
  mission goal → started; only an explicit sort submission or mission
  submission → completed; drafts never count as submitted).
  - `moduleProgress(classId)` — batched roster feed:
    `GET /api/teacher/module-progress?classId=` → `{ modules: [...],
    students: { id: { started, completed } } }` (hidden modules excluded;
    live `portfolioMissionState` only for mission-not-submitted students).
  - `studentModuleDetail(userId)` — drawer feed with full evidence detail
    (sort: answerKey + bestPlacements + attempts + draft flag; mission:
    checks/counts/evidence vs live, picks, reflection, submittedAt).
- `server/index.ts`: new `GET /api/teacher/module-progress` route;
  `GET /api/teacher/student` now also returns `modules: await
  studentModuleDetail(studentId)`.
- `src/App.tsx`:
  - Roster (Brokerage tab) simplified to **Student / Class / Last active /
    Modules started (n/N) / Modules completed (n/N)** — money columns
    removed (detail lives in the drawer); `val()` sort keys updated
    (`started`/`completed` from module-progress state); heading/hint copy
    updated.
  - New `TeacherSortDetail` + `TeacherMissionDetail` components: expanded
    drawer content — best-attempt ticker grid (✓/✕/hatched + hover titles),
    attempts/best/last-submitted line, plain-text "Missed N" list
    (`they put X · should be Y`), draft-only note; mission five-goal
    checklist with labels+counts (evidence snapshot if submitted, live
    state otherwise), picks theses + final reflection when submitted.
  - Drawer gets a **Modules** panel right under the student header:
    `{started} started · {done} of {n} submitted` hint + one `<details>`
    row per module (collapsed: `Module N · title` + `N/M parts` mono +
    badge Submitted/In progress/Not started; chevron ▸/▾).
- `src/styles.css`: `.module-breakdown`, `.module-row` (+summary/parts/
  chevron), `.module-row-body`, `.module-goal(s)` + `.goal-mark`,
  `.module-misses`, `.module-pick`, `.module-reflection` (reuses olive
  tokens; `.badge-due/ready/paid` for statuses).

Verification (sandbox, fresh SQLite, mock quotes — never prod):
- `npm run typecheck` clean; `npm test` **91/91**; `npm run build` ok.
- Seeds: `seed` + `seed:sort` + `seed:mission`. Student activity via API:
  Ava submitted sort 2-right/2-wrong/8-unplaced + bought AAPL/NKE/KO
  (mission 1/5 goals); Ben draft-only (3 placed).
- Playwright check `/tmp/simlife-ui-check/check.mjs`: **16/16 PASS** —
  roster headers (no money cols), counts Ava 2/2+1/2, Ben 1/2+0/2,
  Chloe 0/2; drawer 2 rows collapsed by default; summaries `2/12 correct
  SUBMITTED` + `1/5 goals IN PROGRESS`; expanded sort grid + MISSED 2
  (AMZN/WMT wrong buckets) + hover titles; expanded mission 5-goal
  checklist; wrong-cell title `they put … should be …`.
- Screenshots reviewed (fresh unique names — stale-read gotcha again:
  a reused path showed a phantom "collapsed" expanded shot; DOM probes
  confirmed both `<details>` stayed open): `fresh-teach-roster-1.png`,
  `fresh-teach-drawer-collapsed-2.png`, `fresh-teach-drawer-expanded-3b.png`.
- Gotchas reconfirmed: workspace lands on **Banking** tab after login
  (click `role=tab` "Brokerage"); demo login button text is the user
  name (Ms. Rivera); `innerText` uppercases `.label` (MISSED 2).

Still open:
5. Commit + push when the user says go (Render auto-deploys; no prod
   seed needed for this feature — endpoints derive from existing data).

## Update 2026-09-22 (late night) — drawer content splits by tab

Change (working tree, not yet committed at time of writing):
- `src/App.tsx` — the shared student profile drawer now branches on
  `tsection`:
  - **Brokerage pill**: Portfolio panel (stat grid: Brokerage cash /
    Invested / Account value / Total return + holdings table ticker,
    shares, avg cost, price, value, gain-loss $ and % + "Prices delayed ·
    {quoteSource}" hint; empty-holdings message) → Investment history
    (full brokerage ledger: When / What / Cash effect) → Adjust
    brokerage cash → Modules → Student details → Delete zone.
    No Job / Recurring expenses / ClassBank / Banking / Activity /
    History panels on this tab.
  - **Banking pill**: exactly the previous drawer, unchanged (Modules,
    Student details, Job, Recurring expenses, ClassBank ref, stat grid,
    Adjust cash, Banking, Activity, History, Delete) — implemented by
    wrapping the Job→History block in `{tsection === "banking" && <>…</>}`.
  - Shared: `cashAdjustPanel` extracted to a const (used by both
    branches); Modules + Student details + Delete zone render on both.
  - Brokerage roster hint → "Click a student for their portfolio,
    investment history, and module progress."

Verification (sandbox, same seeded DB as the module-stats run):
- `npm run typecheck` clean; `npm test` 91/91; `npm run build` ok.
- Playwright `/tmp/simlife-ui-check/check.mjs` regression: **16/16**
  (modules panel still works when opened from Brokerage).
- Playwright `check2.mjs`: **10/10** — brokerage drawer headings =
  [Portfolio, Investment history, Adjust cash, Modules, Student
  details, Delete] and NO job/bank/history panels; holdings AAPL/NKE/KO;
  stats text has $700 cash + $300 invested; investment history ≥3 rows;
  banking drawer headings = [Modules, Student details, Job, Recurring
  expenses, Adjust cash, Banking, Activity, History, Delete] and NO
  Portfolio / Investment history. Sidecars:
  `fresh-teach-drawer-{brokerage-4,banking-5}.json`.
- `check3.mjs` re-confirmed banking headings live in a separate run.
- Screenshots: brokerage drawer visually reviewed (correct). Banking
  drawer could NOT be visually reviewed — the image-read tool served
  wrong/stale pixels for every fresh path/md5/dimension this session
  (even a `.drawer`-element-only screenshot returned a full-page image).
  DOM headings + zero `pageErrors` are the evidence; banking markup is
  the pre-existing drawer only wrapped in a conditional.
- Roster hint text confirmed in the brokerage screenshot.

Still open:
6. Commit + push when the user says go — note the working tree ALSO has
   unrelated edits (server/quotes.ts, server/quotes.test.ts,
   server/ticker-directory.json, scripts/build-ticker-directory.mjs)
   made outside this session; ask whether to include them or stage only
   src/App.tsx + this handoff.

## Update 2026-09-23 — portfolio mission simplified to three goals

User request: the mission's five checks felt redundant — "Add 3 past your
first three" and "Put some additions in new industries" collapse into the
hold-6/cover-5 goals. New checklist is exactly three goals:

1. Start with three companies (baselineReady)
2. Hold 6 companies (minCompanies)
3. Cover 5 sectors (minSectors)

Changes (commit `c430e16`, pushed):
- `server/class-posts.ts`: DEFAULT_MISSION_SPEC drops
  `minNewCompanies`/`minNewSectorCompanies`; `portfolioMissionState`
  checks now only baselineReady/companies/sectors (arrays
  `newCompanies`/`newSectorCompanies` + counts still returned for the
  write-up picker); submission pick validation changed from "must be
  outside your original sectors" to "must be a current company holding
  you added after your first three" (picks = `state.newCompanies`,
  guaranteed ≥3 whenever hold-6 passes, so the write-up can never be
  blocked).
- `server/seed-portfolio-mission.ts`: SPEC drops the two keys.
- `src/App.tsx`: student goal list → 3 rows; pick dropdown options =
  `mission.newCompanies`; TeacherMissionDetail → 3 rows; teacher create
  form default spec + "Built-in evidence" hint updated; copy no longer
  says "new-industry".
- `server/class-posts.test.ts`: rejection test now expects the new
  pick-validation message (NKE = original buy still rejected).
- Goal counts auto-adapt everywhere (`Object.keys(checks).length`,
  `missionGoalsMet`) — roster/drawer show "1/3 goals" for Ava.
- `/tmp/simlife-ui-check/check.mjs` updated: expects `1/3 goals` and
  three-goal expansion (asserts removed goals absent).

Gate: typecheck clean, 92/92 tests, build green, pushed `cbca9b1..c430e16`.

Still open:
1. Prod has the OLD spec JSON stored; behavior is already 3-goal on
   deploy (checks read DEFAULT, not stored extras), but run
   `npm run seed:mission` against prod after Render deploys to refresh
   the stored spec/summary/body.
2. Sandbox re-seed + check.mjs/check2.mjs run not yet done this round.
