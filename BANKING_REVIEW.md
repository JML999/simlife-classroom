# Banking Experiment — Second-Pass Review

Branch: `experiment/simlife-banking`

Worktree: `/Users/justinlee/Desktop/_Active/ths_textbook/simlife-banking`

Known-good base: `main` at `dda4cc5`

The main investing worktree and `codeworld/` remain untouched. This branch has
not been merged or deployed, and no live database was used during this review.

## Product result

The student Banking area now uses the same mental model students already know:
a bright welcome dashboard, three obvious account cards, a mailbox, bills that
the student pays, and a simple transfer area. The visual treatment is original
SimLife work rather than copied ClassBank assets, but it is deliberately more
playful and immediately legible than the earlier warm/serious banking screen.
The established Brokerage/Portfolio presentation was not redesigned.

Student flow:

1. Paychecks arrive in checking.
2. Bills arrive as mail with sender, document heading, correspondence, amount,
   due date, and status.
3. **Read** opens a statement-style letter. **Pay** asks how much to pay.
4. Full payment closes the bill; partial payment leaves the exact remainder in
   the mailbox. Overpayment and insufficient checking are rejected atomically.
5. **Question or dispute** records a message for later teacher resolution; it
   explicitly does not pause the due date.
6. Checking can move to savings or brokerage; savings can move back to checking.

The dashboard continuously reinforces the course idea that a checking balance
is not the same as money available to invest when bills remain due.

## Savings model

- Default classroom rate: **3.40% APY**, configurable with
  `SIMLIFE_SAVINGS_APY_BPS` plus label/as-of environment values.
- The default is a current high-yield benchmark, not a promise that every bank
  pays this rate. Source and as-of date are visible in the UI and documented in
  `README.md`.
- Interest is settled lazily when the student loads Banking or moves savings.
  Whole cents become append-only `savings_interest` journal entries; residual
  micro-cents are retained so frequent logins do not lose fractional earnings.
- The student sees interest earned plus 1-, 5-, and 10-year projections. The
  graph states its assumption: current balance remains deposited with no later
  deposits or withdrawals.

## Engineering corrections in this pass

- Added `bill_payments` as immutable payment records and `paid_cents` on bills,
  enabling audited partial payments instead of overwriting history.
- Added `bill_disputes`, with ownership checks and idempotent student submission.
- Preserved bill sender/document content from templates through class issuance.
- Fixed mailbox delivery for a student who has a bill but no bank account yet.
- Fixed checking↔savings activity amounts displaying `$0.00` because the two
  balanced legs had previously been summed.
- Added exact-request checks for reused idempotency keys. A key reused for a
  different student, amount, direction, bill, or message returns a conflict.
- Strengthened Postgres concurrency: banking mutations lock the per-student
  boundary before checking idempotency, and payments lock the bill row before
  calculating remaining balance. SQLite keeps its `BEGIN IMMEDIATE` writer lock.
- Preserved old fully paid bills in the new UI even though historical rows did
  not have `paid_cents`.
- Added visible errors inside the payment/dispute modal instead of hiding an
  unsuccessful action behind the overlay.

## Schema additions

- `bank_accounts.interest_residual_micros`, `interest_accrued_at`
- `bill_templates.sender`, `document_title`, `document_body`
- `bills.paid_cents`, `sender`, `document_title`, `document_body`
- new `bill_payments` and `bill_disputes` tables

All changes are additive and use the project's shared SQLite/Postgres SQL
subset. Money remains integer cents, the bank journal remains append-only, and
checking/savings cached balances must equal their journal-leg sums. A transfer
to brokerage still updates both accounting systems inside one transaction.

## Verification

- `npm run typecheck`: passed
- `npm test`: **35/35 passed** (17 banking, 18 existing brokerage/auth/quotes)
- `npm run build`: passed
- local API boot + `/api/health`: passed on port 4110 against a temporary SQLite
  file with `SIMLIFE_DATABASE_URL` explicitly blank
- `git diff --check`: passed
- Browser walkthrough used fictional users and a temporary SQLite database:
  paycheck, issued utility correspondence, partial payment, remaining bill,
  savings transfer, interest projection, and checking-to-brokerage transfer.
- Wide and narrow layouts were visually inspected. Primary student controls do
  not require horizontal scrolling.

## Deliberately remaining before merge/deployment

- Teacher handling for open questions/disputes (reply, resolve, or explicitly
  adjust/waive through compensating records) is not built yet.
- Mail is structured text correspondence, not uploaded PDF files. A safe
  attachment system needs explicit file storage, type/size rules, and access
  control; it should not be improvised into the database.
- A real Postgres staging smoke test is still required before merge. This pass
  reasoned about and hardened row locking but intentionally did not connect to
  financeWRLD.
- Restore the `tcitys.org` domain lock, disable demo auth, remove demo accounts,
  resolve roster identities, and choose deployment routing before student use.
- Audit/history pagination and `BASE_PATH` hosting remain general product work.

See `OPENCODE_NEXT_DIRECTIVE.md` for the next bounded implementation task.

## Follow-up: teacher dispute inbox (branch, unmerged)

Implemented per `OPENCODE_NEXT_DIRECTIVE.md` (dispute follow-up):

- `resolveDispute()` (`server/bank.ts`): audited open→resolved transition
  recording reply + resolver + timestamp. Same key + same text dedupes;
  same key + different text → 409 conflict; any other write to a resolved
  dispute → 409 `ALREADY_RESOLVED`. Resolution never touches the bill;
  paying while a question is open stays allowed. Concurrent double-resolve:
  exactly one wins (`UPDATE ... WHERE status='open'` row-count check).
- `listDisputes(classId?)`: open-first ordering with student/bill/remaining
  context; class-filtered. New columns `resolved_by`, `resolve_key`
  (additive `ensureColumn` migration + fresh-DB DDL).
- Routes: `GET /api/teacher/disputes?classId=`,
  `POST /api/teacher/disputes/:id/resolve` (both `requireCurrentTeacher`).
- UI: teacher Banking "Student questions" panel (open count, reply + resolve,
  leave-open path); student mail document renders the full thread
  (question + teacher reply + resolved state).
- Tests: 39/39 green (4 new: resolve visibility, dedupe/conflict/race,
  pay-while-open + class scoping, unknown-id 404).
- Live walkthrough (fresh SQLite, fictional accounts): dispute → inbox →
  resolve → student-visible reply → overwrite rejected → isolation +
  pay-while-open verified at route level.
- Prod gates re-verified: unsafe config refused; full-shape config proceeds
  to DB connect (bogus host → ECONNREFUSED, i.e. validation passed).

### Postgres lock-order review (reasoning only — no live pg connected)

Write-order per transaction, always parent→child, single direction:
- `disputeBill`: `bills` row (`FOR UPDATE`) → `bill_disputes` INSERT.
- `resolveDispute`: `bill_disputes` row (`FOR UPDATE`) → unlocked `bills`
  read → conditional `UPDATE` on the already-locked row. No second lock taken.
- `payBill`: `bank_accounts` → journal INSERT → `bills` UPDATE.
- `transfer`/`postIncome`/batches: bank rows → journal → (brokerage rows).
- Batches now sort items by `userId` so concurrent class-wide postings lock
  `bank_accounts` rows in the same order (removes the one real deadlock vector:
  overlapping batches locking rows in opposite orders).
- SQLite mutex serializes everything, so tested concurrency semantics
  (double-submit, races) hold there by construction; on Postgres they rest on
  row locks + the `WHERE status='open'` guard + unique keys, as reasoned above.
  A staging run against real Postgres is still recommended before merge.

### Attachment/PDF design note (future, not built)

If bill letters ever accept uploads: store bytes in private object storage
(Supabase Storage, non-public bucket), never in Postgres; serve only through
an authorized route that checks session + class membership and returns a
short-lived signed URL with `Content-Disposition: attachment`. Allowlist MIME
(`application/pdf`, `image/png`, `image/jpeg`), 5 MB cap, magic-byte check on
the server (extension is not trust). No librarian-side rendering pipeline, so
malware scanning means either a scanner service or classroom policy + teacher
upload-only. Versioning: immutable `bill_documents(id, bill_id, sha256,
mime, bytes, uploaded_by, created_at)` rows; `bills` points at the active
document id; a new version is a new row + pointer update — history preserved,
nothing mutated.

### Honest limitations

- No real-browser walkthrough available in this environment (same constraint
  as prior passes); layouts follow existing responsive patterns and build clean.
- ChromeOS/small-screen verification still owed before students use it.
