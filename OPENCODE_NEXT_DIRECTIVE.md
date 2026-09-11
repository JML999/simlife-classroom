# OpenCode Directive — Banking Follow-up After Second-Pass Review

## Objective

Continue only on `/Users/justinlee/Desktop/_Active/ths_textbook/simlife-banking`
and branch `experiment/simlife-banking`. Build the teacher side of the new
student **Question or dispute** workflow, then perform a Postgres-compatible
engineering review. Do not expand into deployment or file uploads in this task.

The current student experience is intentionally complete enough for a classroom
demo: playful dashboard, checking/savings/brokerage cards, mailbox documents,
full or partial bill payments, savings APY/projection, and transfers. Preserve
that design and preserve the existing Brokerage/Portfolio presentation.

## Hard boundaries

- Do not modify, stage, format, or read secrets from `../codeworld/`.
- Do not modify the original `../simlife-investing/` worktree or merge to main.
- Do not connect to, migrate, seed, or edit financeWRLD or any live data.
- Use a fresh temporary SQLite database and fictional users for every walkthrough.
- Do not deploy or change Google OAuth/Supabase settings.
- Preserve integer cents, append-only journals, server-side roles/class scope,
  idempotency, no-negative balances, and the atomic bank→brokerage transfer.
- Read `BANKING_REVIEW.md`, `SESSION_NOTE_FOR_REVIEW.md`, `ARCHITECTURE.md`, and
  all banking code/tests before editing.

## Build now: teacher dispute inbox and resolution

Add a teacher-visible **Questions** count and inbox inside Banking. It must be
class-filtered and server-authorized. Each item should show student, bill,
remaining balance, question, submitted time, and current status.

The teacher may:

1. Reply and mark the question resolved without changing the bill.
2. Leave it open.

The student must see the teacher reply and resolved/open state in the same mail
document. Resolution is an audited state transition with resolver and timestamp;
it is not deletion.

Do **not** add arbitrary bill editing. If you propose a future waive/adjust
feature, document the compensating-ledger design first; do not mutate original
amounts or erase payments.

Required safety behavior:

- A teacher can see/resolve only disputes for students in a class they control.
- A student can see only disputes attached to their own bills.
- A resolved dispute cannot be silently overwritten; a repeated identical
  request dedupes, and a reused key with different details conflicts.
- Paying a bill while a question is open remains allowed, matching the current
  student warning, unless the owner explicitly changes that classroom rule.

## Engineering review

After implementing the inbox, inspect every new Postgres transaction for lock
order and retry behavior. Add tests for authorization, idempotency mismatch,
double-submit behavior, and payment/resolution concurrency semantics. Do not
claim Postgres verification from SQLite tests; record reasoning separately.

Keep attachment/PDF support out of scope. In the handoff, provide a short design
note covering private object storage, signed/authorized downloads, allowed MIME
types, size limits, malware considerations, and how a document version would be
bound immutably to an issued bill.

## Acceptance checks

Run with Node 22+:

- `npm run typecheck`
- `npm test`
- `npm run build`
- a production boot/health smoke test against a temporary SQLite file
- browser walkthrough at desktop and Chromebook-like width
- `git diff --check`

Update both `BANKING_REVIEW.md` and `SESSION_NOTE_FOR_REVIEW.md`. Record exact
test counts and honest limitations. Commit only coherent changes to the
experimental branch. Stop without merging or deploying.
