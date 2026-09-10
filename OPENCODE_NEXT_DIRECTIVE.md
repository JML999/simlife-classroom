# OpenCode Directive — SimLife Banking Worktree Experiment

## Goal

Build the first working banking-and-bills expansion of SimLife on an isolated
Git branch and worktree. The existing investing application on `main` is the
known-good fallback and must continue to work unchanged.

This phase should prove the core one-stop-shop workflow:

> Teacher issues income and bills → student manages checking and savings →
> student pays bills → student transfers genuinely available money into the
> existing brokerage account → teacher can see and audit the result.

Do not attempt to reproduce every ClassBank feature in this phase.

## Create the isolation boundary before editing

The source repository is:

`/Users/justinlee/Desktop/_Active/ths_textbook/simlife-investing`

1. Confirm its `main` branch is clean. If it is not clean, stop and report the
   exact files; do not discard or absorb someone else's changes.
2. From that repository, create branch `experiment/simlife-banking` in this
   separate worktree:

   `/Users/justinlee/Desktop/_Active/ths_textbook/simlife-banking`

3. If either the branch or destination already exists, inspect and report it
   instead of deleting, overwriting, resetting, or inventing another location.
4. Make every implementation commit on `experiment/simlife-banking` only.
5. Do not merge into `main`. The owner will request a separate review before
   deciding whether to merge.

## Hard safety boundary

- Work only in the new `simlife-banking/` worktree.
- `../codeworld/` is read-only reference. Do not modify, format, move, delete,
  stage, or commit anything inside it. Never open or copy `../codeworld/.env`.
- Do not modify the original `simlife-investing/` worktree after creating the
  banking worktree.
- Use only `SIMLIFE_*` configuration. Do not print, copy, or commit secrets.
- Do not deploy, create services, change OAuth/Supabase settings, delete demo
  accounts, seed financeWRLD, or alter any real student data or balances.
- Use a temporary SQLite database and fictional fixtures for all development
  and testing. Explicitly remove `SIMLIFE_DATABASE_URL` from test processes.
- Preserve server-side roles, idempotency, append-only records, integer cents,
  integer micro-shares, and no-negative-brokerage-cash rules.

## Read before editing

Read these files completely in the new worktree:

1. `SESSION_NOTE_FOR_REVIEW.md`
2. `ARCHITECTURE.md`
3. `README.md`
4. `server/db.ts`, `server/ledger.ts`, and all existing tests
5. `server/index.ts`
6. `src/App.tsx`, `src/api.ts`, and `src/styles.css`

Review the most recent commits so the experiment retains intentional UX:

- `412fb1c` scalable student Portfolio
- `8aa853e` Portfolio redesign
- `7e4e420` cash adjustment moved into individual student profiles

## Architecture requirements

### Preserve the brokerage boundary

The existing `accounts`/brokerage ledger represents brokerage cash and trades.
Do not reinterpret historical brokerage entries as checking transactions and do
not wedge bills into trade-ledger kinds.

Add a banking subsystem with explicit boundaries, such as:

- bank accounts (`checking`, `savings`)
- an append-only bank journal
- balanced transfer/posting records
- bill templates and individual bill instances
- income/paycheck templates and individual postings

Exact table names are flexible, but the meaning and invariants must be clear.
Use additive, repeatable migrations compatible with SQLite and Postgres.

### Atomic money movement

- Checking ↔ savings transfers must debit and credit atomically.
- Checking → brokerage must debit checking and credit existing brokerage cash
  atomically in one database transaction.
- A failed or repeated request must never create, destroy, or duplicate money.
- Every mutation needs a stable idempotency identity and an audit trail showing
  student, what, when, amount, and reason/source.
- Student-facing balances must be derived from or reconciled against the
  immutable journal, not accepted from browser state.
- Reject transactions that would make checking, savings, or brokerage cash
  negative. Do not silently use another account to cover a shortfall.

### Bills and due dates

- A teacher can create and assign a one-time bill to one student or an entire
  selected class.
- A bill has a title, amount, issued date, due date, optional description, and a
  visible status: `due`, `paid`, or `late`.
- Bills arrive in a student **Bills / Mailbox** view. The student, not the
  teacher, chooses **Pay from checking**.
- Paying a bill is atomic and idempotent. Insufficient checking funds produces a
  useful error and leaves the bill unpaid.
- Do not depend on a fragile background process for correctness. Late status can
  be determined from due date when read; if late fees are included, processing
  must be explicit and idempotent.
- For this experiment, recurring bills may be represented by reusable teacher
  templates plus an explicit **Issue now** action. Do not build a scheduler yet.

### Income

- A teacher can issue a paycheck/deposit to one student or an entire selected
  class with amount, label, and date.
- Class-wide issuance must be atomic and retry-safe.
- A teacher must see a preview and total before confirming a class-wide posting.
- Preserve the individual student-profile cash adjustment where it currently
  lives; do not restore a floating adjustment tray at the bottom of the roster.

## Required student experience

Evolve the product name in the shared navigation to **SimLife**, with clearly
separated areas for **Banking** and **Investing**.

### Visual and interaction direction

- Preserve the current Investing/Brokerage styling and formatting. Do not
  redesign the Portfolio, investing summary cards, trade flow, typography,
  colors, or disclosure treatment unless a banking integration requires a
  small, clearly justified navigation change.
- Make Banking feel immediately familiar to students who have used ClassBank:
  prominent account balances, recognizable checking/savings sections, a clear
  activity feed, an obvious bill inbox, simple transfer/payment flows, and
  teacher controls organized around classes and student accounts.
- Match the useful **experience and mental model**, not ClassBank's identity.
  Do not copy its source code, logo, name, proprietary artwork, screenshots,
  exact text, or pixel-for-pixel trade dress. Use original SimLife components,
  wording, and visual details.
- Banking may have its own close-to-a-bank visual character, but it must still
  sit naturally inside the shared SimLife shell. Moving between Banking and
  Investing should feel like switching sections of one product, not opening two
  unrelated websites.
- Where the desired classroom mechanics intentionally differ from ClassBank,
  follow the SimLife requirement. Most importantly, bills go to the student's
  mailbox and the **student pays them**; the teacher does not simulate this by
  sending an expense that automatically removes money.

The student banking dashboard must show:

- checking balance
- savings balance
- brokerage cash / portfolio value (from the existing investing subsystem)
- bills due and late
- recent banking activity
- transfer controls for checking ↔ savings and checking → brokerage
- Bills / Mailbox with an obvious Pay action and paid/due/late state

The central lesson should be visible in the hierarchy: a checking balance is not
automatically available to invest when bills are still due.

Use the shared SimLife quality and responsive standards. Avoid wide tables for
primary student actions, horizontal scrolling to reach buttons, or controls
detached from the item they affect.

## Required teacher experience

Add a **Banking** area to the existing teacher workspace that supports:

- selected-class paycheck/deposit issuance with preview and confirmation
- selected-class bill issuance with preview and confirmation
- current counts for due, paid, and late bills
- per-student checking, savings, brokerage, and outstanding-bill summary
- opening a student's profile to inspect their banking journal and bills

All teacher mutations must be server-authorized and class-scoped. The UI must
not be treated as an authorization boundary.

## Required tests

Keep all existing tests green and add isolated tests covering at minimum:

- checking and savings opening balances
- checking ↔ savings transfer conservation
- checking → brokerage conservation across both ledgers
- insufficient-funds rejection with no partial writes
- duplicate transfer/payment/paycheck requests execute once
- bill creation, payment, paid-state persistence, and late-state calculation
- student cannot pay another student's bill
- student cannot call teacher issuance routes
- teacher class-wide issuance cannot affect another class
- atomic rollback for a failed class-wide operation
- ledger/journal balance reconciliation
- SQLite behavior plus a written review of Postgres-specific SQL/types

Use generated fictional data only. Never exercise mutation tests against the
configured remote database.

## Definition of done for this experiment

The branch is ready for review when:

1. A fictional teacher can issue a paycheck and household bill to a fictional
   class.
2. A fictional student can see both, pay the bill from checking, move money to
   savings, transfer money into brokerage, and buy an existing simulated stock.
3. The teacher can see the resulting balances, bill status, and audit history.
4. Refreshes and duplicate clicks do not duplicate money or payments.
5. Existing investing, freeze controls, individual adjustments, authentication,
   and accounting tests still pass.
6. `npm run typecheck`, the full test suite, and `npm run build` pass.
7. Desktop and narrow/mobile layouts have been visually checked.
8. No files outside the banking worktree changed.

Commit coherent checkpoints on `experiment/simlife-banking`. Finish with a
review note describing the schema, routes, UI, tests, compromises, screenshots
or visual evidence, commit hashes, and any decisions the owner still needs to
make. Do not merge, deploy, or modify live data.

## Explicitly out of scope

- Automatic recurring scheduler
- Late-fee policy beyond a minimal explicitly tested implementation
- Class stores, rewards, jobs marketplace, behavior points, or gradebook sync
- Automated life-event wheel
- Dividends, options, crypto, short selling, or real-money integrations
- Production deployment or infrastructure changes
- CSV balance imports (design later after the banking schema is reviewed)
- Resolving real roster identities or selecting real starting amounts
- The existing launch-hardening backlog unless a change is directly required
  to keep this experiment correct
