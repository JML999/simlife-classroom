# Banking Experiment — Review Note (branch `experiment/simlife-banking`)

Worktree: `/Users/justinlee/Desktop/_Active/ths_textbook/simlife-banking`
Base: `main` @ `dda4cc5` (clean, untouched since). No merge performed.

## Commits on this branch

- `946148b` Banking ledger: journal, transfers, bills, income batches + 12 tests
- `1de16ad` Banking API: student bank routes, class-scoped teacher issuance
- `9fe025c` Banking UI: student section, teacher issuance, bill mailbox, profiles

## Schema (additive, SQLite + Postgres compatible, in `server/db.ts`)

- `bank_accounts(user_id UNIQUE, checking_cents, savings_cents)` — cached
  balances, updated only inside journal transactions (same pattern as brokerage).
- `bank_journal(bank_account_id, kind, checking_leg, savings_leg, memo,
  actor_id, idempotency_key UNIQUE, related_id)` — append-only. One transfer =
  one row with two signed legs. Invariant: checking/savings equal their leg sums.
- `bill_templates(teacher_id, title, amount_cents, late_fee_cents, description)`.
- `bills(user_id, template_id, title, amount_cents, late_fee_cents, issued_at,
  due_at, paid_at, payment_journal_id, idempotency_key UNIQUE, issued_by)` —
  status (`due`/`late`/`paid`) derived on read; no scheduler.
- `income_postings(user_id, label, amount_cents, posted_at, posted_by,
  batch_id, idempotency_key UNIQUE)`.
- Brokerage side untouched except one new ledger kind: `transfer_in`
  (transfer record, not a trade; keeps brokerage invariant intact).

## Routes

- Student: `GET /api/bank` (balances + bills w/ status + recent journal +
  brokerage snapshot), `POST /api/bank/transfer` (checking↔savings,
  checking→brokerage one-way), `POST /api/bank/bills/:id/pay`.
- Teacher (`requireCurrentTeacher`, class-scoped): `GET /api/teacher/bank`,
  `POST /api/teacher/income/preview|issue`, bill template CRUD-lite,
  `POST /api/teacher/bills/preview|issue`. Batch keys `${batchId}:${userId}`;
  whole batch in one tx; retry resumes; cross-class ids rejected.
- `GET /api/teacher/student` extended with `bank` + `bankInvariant`.

## UI

- Shared nav evolved to **SimLife** with Banking | Investing pills (student)
  and Brokerage | Banking workspace (teacher). Investing styling untouched.
- Banking borrows ClassBank's mental model (sidebar-free: prominent balances,
  mailbox, transfer flows, checkbox class table with SEND-style preview bars)
  with original SimLife components — no ClassBank assets/text copied.
- Student sees an "unpaid bills are spoken for" banner: checking is not
  automatically available to invest while bills are due (the central lesson).
- Teacher profile drawer gained a Banking panel (balances, bills, journal).

## Tests (30/30 green: 15 brokerage + 3 quotes + 12 bank)

`server/bank.test.ts` covers: opening balances, transfer conservation,
cross-ledger conservation, insufficient-funds with no partial writes,
duplicate/concurrent execution-once, full bill lifecycle incl. late fee,
cross-student bill rejection, batch atomicity + retry-resume + rollback,
batch scoping + intra-batch duplicates, invalid directions, reconciliation.
Fixtures only, temp SQLite, `SIMLIFE_DATABASE_URL` deleted in-process.

## Live walkthrough (fresh SQLite, fictional demo accounts, ports 4103/3200)

Paycheck $1,200 × 4 → bill $600+$50 fee × 4 → student sees both → pays bill
($600 on-time) → $100 savings → $300 checking→brokerage → buys $100 VOO →
duplicate-pay retry deduped → teacher sees paid bill, both invariants true.
Authz spot-checks: student→teacher routes 403, teacher→student-money 403,
cross-class batch rejected. Prod boot refuses unsafe config (fail-closed gate
verified); with valid config it proceeds to DB connect (proven with bogus
host → ECONNREFUSED, i.e. validation passed).

## Compromises / honesty notes

- Narrow/mobile layouts checked at code level only (grid collapse, wrapping
  rows, card-based actions; no browser available here). Needs a Chromebook pass.
- `transfer()` rejects savings→brokerage directly (must go via checking) to
  keep every transfer one debit + one credit. One-way into brokerage only.
- Late fees apply when a bill is paid late, set per-bill at issuance; no
  scheduler, no compounding, no fee-waiver flow yet.
- Live state: none touched. financeWRLD never connected from this worktree
  (no `.env` here). `main` worktree and `codeworld/` verified unmodified.

## Decisions still with the owner

- Real starting amounts + roster identity resolutions (unchanged).
- Quote provider approval; deployment URL/service (firewall question stands:
  independent service = new URL = likely school-filter block; same-host mount
  remains the fallback and would need a narrow exception to no-codeworld-edits).
- Whether to merge this branch after review.
