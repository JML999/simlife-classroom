# OpenCode Directive — SimLife Investing Launch-Candidate Phase

## Objective

Turn the existing isolated SimLife brokerage MVP into a classroom-ready launch
candidate. Focus on scale, teacher setup, pagination, and verification. Do not
expand this phase into paychecks, bills, rent, savings, or a full ClassBank
replacement.

## Hard safety boundary

- Work only in `simlife-investing/`.
- `../codeworld/` is read-only reference. Do not modify, format, move, delete,
  stage, or commit anything inside it. Do not open or copy its `.env`.
- Use only `SIMLIFE_*` configuration and the independent financeWRLD database.
- Do not deploy, create services, change Google OAuth configuration, change
  Supabase settings, delete demo accounts, alter real student balances, or run
  seed/import commands against the live database.
- Do not print or commit secrets. Preserve all existing accounting and auth
  invariants.

## Read first

Read these files completely before editing:

1. `SESSION_NOTE_FOR_REVIEW.md`
2. `ARCHITECTURE.md`
3. `README.md`
4. `server/ledger.ts` and all three existing test files
5. The current `src/App.tsx`, especially the student Portfolio and teacher
   student-profile flows

Review recent commits so you do not undo intentional UX decisions:

- `412fb1c` scalable student Portfolio
- `8aa853e` initial Portfolio redesign
- `7e4e420` cash adjustment moved into individual student profiles

## Required work

### 1. Make large portfolios fast on the server

`portfolioFor()` currently requests holding quotes sequentially. Refactor it so
a portfolio with 100 holdings does not wait for 100 serial network round trips.

- Deduplicate symbols.
- Fetch quotes concurrently with a conservative concurrency limit (about 6–10),
  not an unbounded `Promise.all` flood.
- Preserve the current per-symbol failure behavior: one unavailable quote must
  not break the entire portfolio; that holding may fall back to cost basis.
- Preserve delayed/source/timestamp labeling and the server cache.
- Add tests that exercise a large portfolio and partial quote-provider failure.
  Make the quote-loading logic injectable/testable rather than relying on live
  network timing.

### 2. Paginate growing histories

The student history and teacher audit endpoints must not return an ever-growing
unbounded result.

- Add server-side pagination with a hard maximum page size.
- Return enough metadata for Previous/Next controls and a clear displayed range.
- Apply it to student transaction history and teacher audit history.
- Keep newest-first ordering deterministic; use a stable tie-breaker in addition
  to timestamp.
- Preserve class and student filters on the teacher audit.
- Add API/data-layer tests for first page, later page, invalid parameters, empty
  results, and stable ordering.
- Update both UIs with compact controls consistent with the current design. Do
  not introduce horizontally scrolling action buttons.

### 3. Build a safe bulk brokerage-deposit workflow

The teacher needs a practical way to initialize many brokerage accounts from a
Google Form/Sheet export. This is separate from the individual **Adjust cash**
control, which must remain inside each student profile.

Implement a teacher-only **Import brokerage deposits** workflow scoped to one
selected class:

- Accept CSV with columns `email`, `amount`, and optional `reason`.
- Preview first; never apply immediately on file selection.
- Validate every row: normalized email, known student in the selected class,
  positive amount, sensible maximum, no duplicate students, and no ambiguous
  matches.
- Display valid rows, rejected rows with specific reasons, total students, and
  total simulated dollars before confirmation.
- Require an explicit confirmation step and a batch reason.
- Apply all accepted deposits transactionally: either the entire confirmed batch
  posts or none does.
- Give the batch an idempotency identity so a retry/double-click cannot fund the
  class twice. Each resulting ledger entry must remain individually auditable.
- Do not add a generic cash-adjustment tray to the bottom of the dashboard.
- Do not use or mutate the existing roster seed JSON as the import mechanism.
- Test authorization, class scoping, validation, atomic rollback, audit entries,
  ledger invariants, and retry/idempotency behavior in isolated SQLite tests.
- During development, use fixtures only. Do not submit an import to financeWRLD.

### 4. Launch-readiness audit

Perform a focused audit and fix issues found within scope:

- Production must refuse to boot with mock quotes or unsafe/missing auth config.
- Confirm demo routes remain inaccessible in production.
- Confirm teacher routes enforce the database-backed teacher role.
- Confirm student trading still respects the class freeze state.
- Confirm all money remains integer cents and all shares integer micro-shares.
- Confirm the new Portfolio search, sorting, disclosure rows, and pagination work
  at desktop and Chromebook/mobile widths. Test with generated fixture data of
  at least 100 holdings; do not create those holdings in financeWRLD.
- Keep all simulated-money and delayed-quote disclosures visible.

## Explicitly out of scope

- Deployment or environment/dashboard changes
- Real student funding or roster mutation
- Deleting demo data
- Paychecks, bills, fines, rent, utilities, savings, mailboxes, grades, or a
  general ClassBank clone
- Real-money brokerage connections or investment advice
- Charts, options, crypto, dividends, market orders, or social features
- Edits to CodeWorld or hosting SimLife inside the CodeWorld process

## Verification required

Use Node 22 or newer. Before handing back:

1. `npm run typecheck`
2. `npm test`
3. `npm run build`
4. Production boot smoke test and `/api/health`
5. `git diff --check`
6. Verify `git -C ../codeworld status --short` is unchanged from the start

Do not claim a browser path was tested unless it was actually exercised. Report
all files changed, tests added, remaining decisions, and any live-state actions
(there should be none). Commit the completed work in the SimLife repository with
focused commits.

## Owner decisions that remain outside this directive

Do not guess these values. Report them back for the owner:

- Final brokerage starting amounts/import CSV
- Resolution of unmatched or ambiguous roster identities
- Approved production quote provider and its usage terms
- Independent deployment URL/service
- Final go-live timing for domain lock, demo-auth disablement, and demo-data
  cleanup
