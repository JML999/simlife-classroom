/**
 * Banking subsystem: checking/savings journal, transfers, bills, income.
 *
 * Boundaries (see directive):
 * - Bank money lives in bank_accounts/bank_journal ONLY. Brokerage money lives
 *   in accounts/ledger ONLY. A checking→brokerage transfer touches both sides
 *   inside ONE database transaction, writing a journal row on the bank side
 *   and a `transfer_in` ledger row on the brokerage side (a transfer record,
 *   not a trade — historical brokerage entries are never reinterpreted).
 * - The journal is append-only. Balances are cached on bank_accounts but only
 *   ever updated inside the same tx as their journal row(s).
 * - Invariant per user: checking == SUM(checking_leg), savings == SUM(savings_leg).
 * - Late status is derived on read from due_at/paid_at. No scheduler.
 */
import { withTx, newId, nowIso, type Tx } from "./db.js";

export class BankError extends Error {
  code:
    | "INSUFFICIENT_FUNDS" | "NOT_FOUND" | "INVALID_AMOUNT" | "ALREADY_PAID"
    | "NOT_YOUR_BILL" | "INVALID_INPUT" | "EMPTY_BATCH";
  constructor(code: BankError["code"], msg: string) {
    super(msg);
    this.code = code;
  }
}

export interface BankAccount {
  id: string;
  checkingCents: number;
  savingsCents: number;
}

export interface JournalEntry {
  id: string;
  bank_account_id: string;
  kind: string;
  checking_leg: number;
  savings_leg: number;
  memo: string | null;
  actor_id: string | null;
  idempotency_key: string | null;
  related_id: string | null;
  created_at: string;
}

export type BillStatus = "due" | "late" | "paid";
export interface Bill {
  id: string;
  user_id: string;
  template_id: string | null;
  title: string;
  amount_cents: number;
  late_fee_cents: number;
  issued_at: string;
  due_at: string;
  paid_at: string | null;
  payment_journal_id: string | null;
  idempotency_key: string | null;
  issued_by: string | null;
  created_at: string;
  status?: BillStatus;
  total_due_cents?: number;
}

export function billStatus(b: Pick<Bill, "paid_at" | "due_at">, now = new Date()): BillStatus {
  if (b.paid_at) return "paid";
  return new Date(b.due_at).getTime() < now.getTime() ? "late" : "due";
}

/** Total owed right now: base amount plus the late fee once the bill is late. */
export function billTotal(b: Pick<Bill, "amount_cents" | "late_fee_cents" | "paid_at" | "due_at">, now = new Date()): number {
  const late = !b.paid_at && new Date(b.due_at).getTime() < now.getTime();
  return b.amount_cents + (late ? b.late_fee_cents : 0);
}

function requireKey(key: unknown): string {
  if (typeof key !== "string" || !key) throw new BankError("INVALID_INPUT", "Idempotency key is required.");
  return key;
}

function requirePositiveCents(n: unknown, what = "Amount"): number {
  if (!Number.isInteger(n) || (n as number) <= 0) {
    throw new BankError("INVALID_AMOUNT", `${what} must be a positive whole number of cents.`);
  }
  return n as number;
}

const MAX_CENTS = 100_000_00; // $100,000 sanity cap per operation
function requireSaneCents(n: number, what = "Amount"): number {
  if (n > MAX_CENTS) throw new BankError("INVALID_AMOUNT", `${what} is too large (max $100,000).`);
  return n;
}

async function getOrCreateBankAccount(t: Tx, userId: string): Promise<BankAccount> {
  const fu = t.dialect === "pg" ? " FOR UPDATE" : "";
  let acct = await t.one<{ id: string; checking_cents: number; savings_cents: number }>(
    `SELECT id, checking_cents, savings_cents FROM bank_accounts WHERE user_id = ?${fu}`, [userId],
  );
  if (!acct) {
    const id = newId("bac");
    await t.run(`INSERT INTO bank_accounts (id, user_id, checking_cents, savings_cents, created_at) VALUES (?, ?, 0, 0, ?)`,
      [id, userId, nowIso()]);
    return { id, checkingCents: 0, savingsCents: 0 };
  }
  return { id: acct.id, checkingCents: acct.checking_cents, savingsCents: acct.savings_cents };
}

async function findJournalByKey(t: Tx, key: string): Promise<JournalEntry | undefined> {
  return t.one<JournalEntry>(`SELECT * FROM bank_journal WHERE idempotency_key = ?`, [key]);
}

function isUniqueViolation(err: any): boolean {
  const msg = String(err?.message || err?.code || "");
  return /unique|UNIQUE|duplicate|23505|SQLITE_CONSTRAINT_UNIQUE/i.test(msg);
}

async function insertJournal(t: Tx, e: Omit<JournalEntry, "created_at"> & { created_at?: string }): Promise<JournalEntry> {
  const entry: JournalEntry = { ...e, created_at: e.created_at ?? nowIso() };
  await t.run(
    `INSERT INTO bank_journal (id, bank_account_id, kind, checking_leg, savings_leg, memo, actor_id, idempotency_key, related_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [entry.id, entry.bank_account_id, entry.kind, entry.checking_leg, entry.savings_leg, entry.memo, entry.actor_id, entry.idempotency_key, entry.related_id, entry.created_at],
  );
  return entry;
}

/**
 * Teacher paycheck/deposit → checking. One tx: income_postings row + journal
 * row + cached balance. Batch-safe: key should be `${batchId}:${userId}` for
 * class-wide issuance so retries resume instead of duplicating.
 */
export async function postIncome(opts: {
  userId: string; actorId: string; label: string; amountCents: number;
  idempotencyKey: string; batchId?: string | null;
}): Promise<{ entry: JournalEntry; deduped: boolean }> {
  const key = requireKey(opts.idempotencyKey);
  const amount = requireSaneCents(requirePositiveCents(opts.amountCents, "Pay amount"));
  const label = (opts.label || "").trim();
  if (label.length < 2 || label.length > 120) throw new BankError("INVALID_INPUT", "Give the deposit a short label (2–120 characters).");
  return withTx(async (t) => {
    const existing = await findJournalByKey(t, key);
    if (existing) return { entry: existing, deduped: true };
    const acct = await getOrCreateBankAccount(t, opts.userId);
    const postingId = newId("inc");
    try {
      await t.run(
        `INSERT INTO income_postings (id, user_id, label, amount_cents, posted_at, posted_by, batch_id, idempotency_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [postingId, opts.userId, label, amount, nowIso(), opts.actorId, opts.batchId ?? null, `post:${key}`, nowIso()],
      );
    } catch (err: any) {
      if (isUniqueViolation(err)) return { entry: (await findJournalByKey(t, key))!, deduped: true };
      throw err;
    }
    let entry: JournalEntry;
    try {
      entry = await insertJournal(t, {
        id: newId("bj"), bank_account_id: acct.id, kind: "income",
        checking_leg: amount, savings_leg: 0,
        memo: label, actor_id: opts.actorId, idempotency_key: key, related_id: postingId,
      });
    } catch (err: any) {
      if (isUniqueViolation(err)) return { entry: (await findJournalByKey(t, key))!, deduped: true };
      throw err;
    }
    await t.run(`UPDATE bank_accounts SET checking_cents = ? WHERE id = ?`, [acct.checkingCents + amount, acct.id]);
    return { entry, deduped: false };
  });
}

export type TransferTarget = "checking" | "savings" | "brokerage";

/**
 * Move money: checking↔savings (one journal row, two legs) or
 * checking→brokerage (one tx across BOTH subsystems: journal row +
 * `transfer_in` brokerage ledger row + both cached balances).
 * One-way into brokerage only — there is no brokerage→bank path.
 */
export async function transfer(opts: {
  userId: string; from: TransferTarget; to: TransferTarget;
  amountCents: number; memo?: string; idempotencyKey: string;
}): Promise<{ entry: JournalEntry; deduped: boolean }> {
  const key = requireKey(opts.idempotencyKey);
  const amount = requireSaneCents(requirePositiveCents(opts.amountCents, "Transfer amount"));
  if (opts.from === opts.to) throw new BankError("INVALID_INPUT", "Pick two different accounts.");
  if (opts.from === "brokerage") {
    throw new BankError("INVALID_INPUT", "Transfers out of brokerage are not supported.");
  }
  if (opts.from !== "checking" && opts.from !== "savings") throw new BankError("INVALID_INPUT", "Transfers start from checking or savings.");
  if (opts.to !== "checking" && opts.to !== "savings" && opts.to !== "brokerage") {
    throw new BankError("INVALID_INPUT", "Transfers go to checking, savings, or brokerage.");
  }
  if (opts.from === "savings" && opts.to === "brokerage") {
    throw new BankError("INVALID_INPUT", "Move savings → checking first, then checking → brokerage. (Keeps every transfer to one debit + one credit.)");
  }
  const memo = (opts.memo || "").trim().slice(0, 200);
  return withTx(async (t) => {
    const existing = await findJournalByKey(t, key);
    if (existing) return { entry: existing, deduped: true };
    const fu = t.dialect === "pg" ? " FOR UPDATE" : "";
    const acct = await getOrCreateBankAccount(t, opts.userId);
    const checkingLeg = opts.from === "checking" ? -amount : opts.to === "checking" ? amount : 0;
    const savingsLeg = opts.from === "savings" ? -amount : opts.to === "savings" ? amount : 0;
    const nextChecking = acct.checkingCents + checkingLeg;
    const nextSavings = acct.savingsCents + savingsLeg;
    if (nextChecking < 0) {
      throw new BankError("INSUFFICIENT_FUNDS", `Only ${fmtCents(acct.checkingCents)} in checking. No other account is used to cover the shortfall.`);
    }
    if (nextSavings < 0) {
      throw new BankError("INSUFFICIENT_FUNDS", `Only ${fmtCents(acct.savingsCents)} in savings. No other account is used to cover the shortfall.`);
    }
    const kind = opts.to === "brokerage" ? "transfer_to_brokerage" : "transfer";
    let entry: JournalEntry;
    try {
      entry = await insertJournal(t, {
        id: newId("bj"), bank_account_id: acct.id, kind,
        checking_leg: checkingLeg, savings_leg: savingsLeg,
        memo: memo || (opts.to === "brokerage" ? "Transfer to brokerage" : "Transfer"),
        actor_id: null, idempotency_key: key, related_id: null,
      });
    } catch (err: any) {
      if (isUniqueViolation(err)) return { entry: (await findJournalByKey(t, key))!, deduped: true };
      throw err;
    }
    await t.run(`UPDATE bank_accounts SET checking_cents = ?, savings_cents = ? WHERE id = ?`,
      [nextChecking, nextSavings, acct.id]);
    if (opts.to === "brokerage") {
      // Second half of the atomic move: credit existing brokerage cash.
      // `transfer_in` is a transfer record, not a trade — historical trade
      // entries are never reinterpreted, and the brokerage invariant
      // (cash == SUM(amount)) still holds.
      let bacct = await t.one<{ id: string; cash_cents: number }>(
        `SELECT id, cash_cents FROM accounts WHERE user_id = ?${fu}`, [opts.userId],
      );
      if (!bacct) {
        const bid = newId("acct");
        await t.run(`INSERT INTO accounts (id, user_id, cash_cents, created_at) VALUES (?, ?, 0, ?)`, [bid, opts.userId, nowIso()]);
        bacct = { id: bid, cash_cents: 0 };
      }
      try {
        await t.run(
          `INSERT INTO ledger (id, account_id, kind, amount_cents, ticker, qty_micro, price_cents, reason, actor_id, idempotency_key, reverses_id, quote_ts, quote_source, created_at)
           VALUES (?, ?, 'transfer_in', ?, NULL, NULL, NULL, ?, NULL, ?, NULL, NULL, NULL, ?)`,
          [newId("le"), bacct.id, amount, memo || "Transfer from checking", `xfer:${key}`, nowIso()],
        );
      } catch (err: any) {
        if (!isUniqueViolation(err)) throw err;
        // Brokerage leg already exists (earlier attempt died after it). The
        // journal row is new in THIS tx, so roll back rather than half-apply.
        throw new BankError("INVALID_INPUT", "This transfer was already partially recorded. Try again with a fresh confirmation.");
      }
      await t.run(`UPDATE accounts SET cash_cents = ? WHERE id = ?`, [bacct.cash_cents + amount, bacct.id]);
      entry.related_id = "brokerage:transfer_in";
    }
    return { entry, deduped: false };
  });
}

/** Teacher creates a reusable bill template. */
export async function createBillTemplate(opts: {
  teacherId: string; title: string; amountCents: number; lateFeeCents?: number; description?: string;
}): Promise<{ id: string }> {
  const title = (opts.title || "").trim();
  if (title.length < 2 || title.length > 120) throw new BankError("INVALID_INPUT", "Bill title must be 2–120 characters.");
  const amount = requireSaneCents(requirePositiveCents(opts.amountCents, "Bill amount"));
  const fee = opts.lateFeeCents === undefined ? 0 : requireSaneCents(Math.floor(opts.lateFeeCents), "Late fee");
  if (fee < 0) throw new BankError("INVALID_AMOUNT", "Late fee cannot be negative.");
  const { run } = await import("./db.js");
  const id = newId("bt");
  await run(
    `INSERT INTO bill_templates (id, teacher_id, title, amount_cents, late_fee_cents, description, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, opts.teacherId, title, amount, fee, (opts.description || "").trim().slice(0, 500) || null, nowIso()],
  );
  return { id };
}

export interface IssueBillInput {
  userId: string;
  title: string;
  amountCents: number;
  lateFeeCents?: number;
  dueAt: string;
  templateId?: string | null;
  issuedBy: string;
  idempotencyKey: string;
}

/** Issue one bill (single tx). Batch callers wrap many in one outer tx via issueBillInTx. */
export async function issueBillInTx(t: Tx, b: IssueBillInput): Promise<Bill> {
  const key = requireKey(b.idempotencyKey);
  const title = (b.title || "").trim();
  if (title.length < 2 || title.length > 120) throw new BankError("INVALID_INPUT", "Bill title must be 2–120 characters.");
  const amount = requireSaneCents(requirePositiveCents(b.amountCents, "Bill amount"));
  const fee = b.lateFeeCents === undefined ? 0 : requireSaneCents(Math.floor(b.lateFeeCents), "Late fee");
  const due = new Date(b.dueAt);
  if (isNaN(due.getTime())) throw new BankError("INVALID_INPUT", "Due date is not a valid date.");
  const existing = await t.one<Bill>(`SELECT * FROM bills WHERE idempotency_key = ?`, [key]);
  if (existing) return { ...existing, status: billStatus(existing), total_due_cents: billTotal(existing) };
  const row: Bill = {
    id: newId("bill"), user_id: b.userId, template_id: b.templateId ?? null,
    title, amount_cents: amount, late_fee_cents: fee,
    issued_at: nowIso(), due_at: due.toISOString(), paid_at: null, payment_journal_id: null,
    idempotency_key: key, issued_by: b.issuedBy, created_at: nowIso(),
  };
  try {
    await t.run(
      `INSERT INTO bills (id, user_id, template_id, title, amount_cents, late_fee_cents, issued_at, due_at, paid_at, payment_journal_id, idempotency_key, issued_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
      [row.id, row.user_id, row.template_id, row.title, row.amount_cents, row.late_fee_cents, row.issued_at, row.due_at, row.idempotency_key, row.issued_by, row.created_at],
    );
  } catch (err: any) {
    if (isUniqueViolation(err)) {
      const dup = (await t.one<Bill>(`SELECT * FROM bills WHERE idempotency_key = ?`, [key]))!;
      return { ...dup, status: billStatus(dup), total_due_cents: billTotal(dup) };
    }
    throw err;
  }
  return { ...row, status: billStatus(row), total_due_cents: billTotal(row) };
}

/** Student pays their own bill from checking. Atomic + idempotent. */
export async function payBill(opts: {
  userId: string; billId: string; idempotencyKey: string; now?: Date;
}): Promise<{ entry: JournalEntry; deduped: boolean; totalCents: number }> {
  const key = requireKey(opts.idempotencyKey);
  const now = opts.now ?? new Date();
  return withTx(async (t) => {
    const existing = await findJournalByKey(t, key);
    if (existing) {
      const bill = await t.one<Bill>(`SELECT * FROM bills WHERE payment_journal_id = ?`, [existing.id]);
      return { entry: existing, deduped: true, totalCents: -(existing.checking_leg) };
    }
    const bill = await t.one<Bill>(`SELECT * FROM bills WHERE id = ?`, [opts.billId]);
    if (!bill) throw new BankError("NOT_FOUND", "Bill not found.");
    if (bill.user_id !== opts.userId) throw new BankError("NOT_YOUR_BILL", "You can only pay your own bills.");
    if (bill.paid_at) throw new BankError("ALREADY_PAID", "This bill is already paid.");
    const total = billTotal(bill, now);
    const acct = await getOrCreateBankAccount(t, opts.userId);
    if (acct.checkingCents < total) {
      throw new BankError("INSUFFICIENT_FUNDS", `This bill needs ${fmtCents(total)} but checking has ${fmtCents(acct.checkingCents)}. The bill stays unpaid.`);
    }
    let entry: JournalEntry;
    try {
      entry = await insertJournal(t, {
        id: newId("bj"), bank_account_id: acct.id, kind: "bill_payment",
        checking_leg: -total, savings_leg: 0,
        memo: `Paid: ${bill.title}`, actor_id: null, idempotency_key: key, related_id: bill.id,
      });
    } catch (err: any) {
      if (isUniqueViolation(err)) {
        const dup = (await findJournalByKey(t, key))!;
        return { entry: dup, deduped: true, totalCents: -(dup.checking_leg) };
      }
      throw err;
    }
    await t.run(`UPDATE bank_accounts SET checking_cents = ? WHERE id = ?`, [acct.checkingCents - total, acct.id]);
    await t.run(`UPDATE bills SET paid_at = ?, payment_journal_id = ? WHERE id = ? AND paid_at IS NULL`,
      [now.toISOString(), entry.id, bill.id]);
    return { entry, deduped: false, totalCents: total };
  });
}

export async function bankSummaryFor(userId: string): Promise<{
  checkingCents: number; savingsCents: number; bills: Bill[]; recent: JournalEntry[];
}> {
  const { one, q } = await import("./db.js");
  const acct = await one<{ id: string; checking_cents: number; savings_cents: number }>(
    `SELECT id, checking_cents, savings_cents FROM bank_accounts WHERE user_id = ?`, [userId],
  );
  if (!acct) return { checkingCents: 0, savingsCents: 0, bills: [], recent: [] };
  const byUser = await q<Bill>(`SELECT * FROM bills WHERE user_id = ? ORDER BY CASE WHEN paid_at IS NULL THEN 0 ELSE 1 END, due_at ASC`, [userId]);
  const now = new Date();
  const withStatus = byUser.map((b) => ({ ...b, status: billStatus(b, now), total_due_cents: billTotal(b, now) }));
  const recent = await q<JournalEntry>(`SELECT * FROM bank_journal WHERE bank_account_id = ? ORDER BY created_at DESC LIMIT 50`, [acct.id]);
  return { checkingCents: acct.checking_cents, savingsCents: acct.savings_cents, bills: withStatus, recent };
}

/** Journal/balance reconciliation for tests and the teacher profile. */
export async function checkBankInvariant(userId: string): Promise<{ checking: number; checkingSum: number; savings: number; savingsSum: number; ok: boolean }> {
  const { one } = await import("./db.js");
  const acct = await one<{ id: string; checking_cents: number; savings_cents: number }>(
    `SELECT id, checking_cents, savings_cents FROM bank_accounts WHERE user_id = ?`, [userId],
  );
  if (!acct) return { checking: 0, checkingSum: 0, savings: 0, savingsSum: 0, ok: true };
  const sums = await one<{ c: number; s: number }>(
    `SELECT COALESCE(SUM(checking_leg), 0) AS c, COALESCE(SUM(savings_leg), 0) AS s FROM bank_journal WHERE bank_account_id = ?`, [acct.id],
  );
  const c = Number(sums?.c ?? 0), s = Number(sums?.s ?? 0);
  return { checking: acct.checking_cents, checkingSum: c, savings: acct.savings_cents, savingsSum: s, ok: acct.checking_cents === c && acct.savings_cents === s };
}

/** Class-wide paycheck issuance: one transaction for the whole batch.
 *  Per-row idempotency keys (`${batchId}:${userId}`) make retries resume
 *  instead of double-paying. Any validation failure rolls back everything. */
export async function issueIncomeBatch(opts: {
  actorId: string; batchId: string; items: { userId: string; label: string; amountCents: number }[];
}): Promise<{ posted: number; batchId: string }> {
  if (!opts.batchId) throw new BankError("INVALID_INPUT", "Batch id is required.");
  if (!opts.items.length) throw new BankError("EMPTY_BATCH", "Nothing to post — select at least one student.");
  for (const it of opts.items) {
    requireSaneCents(requirePositiveCents(it.amountCents, "Pay amount"));
    if (!it.userId || (it.label || "").trim().length < 2) {
      throw new BankError("INVALID_INPUT", "Each row needs a student and a short label.");
    }
  }
  const seen = new Set<string>();
  for (const it of opts.items) {
    if (seen.has(it.userId)) throw new BankError("INVALID_INPUT", "Duplicate student in batch — remove the duplicate row.");
    seen.add(it.userId);
  }
  return withTx(async (t) => {
    let posted = 0;
    for (const it of opts.items) {
      const key = `${opts.batchId}:${it.userId}`;
      const existing = await findJournalByKey(t, key);
      if (existing) continue;
      const acct = await getOrCreateBankAccount(t, it.userId);
      const postingId = newId("inc");
      await t.run(
        `INSERT INTO income_postings (id, user_id, label, amount_cents, posted_at, posted_by, batch_id, idempotency_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [postingId, it.userId, it.label.trim(), it.amountCents, nowIso(), opts.actorId, opts.batchId, `post:${key}`, nowIso()],
      );
      await insertJournal(t, {
        id: newId("bj"), bank_account_id: acct.id, kind: "income",
        checking_leg: it.amountCents, savings_leg: 0,
        memo: it.label.trim(), actor_id: opts.actorId, idempotency_key: key, related_id: postingId,
      });
      await t.run(`UPDATE bank_accounts SET checking_cents = ? WHERE id = ?`, [acct.checkingCents + it.amountCents, acct.id]);
      posted++;
    }
    return { posted, batchId: opts.batchId };
  });
}

/** Class-wide bill issuance: one transaction for the whole batch. */
export async function issueBillBatch(opts: {
  issuedBy: string; batchId: string;
  items: { userId: string; title: string; amountCents: number; lateFeeCents?: number; dueAt: string; templateId?: string | null }[];
}): Promise<{ issued: number; batchId: string; bills: Bill[] }> {
  if (!opts.batchId) throw new BankError("INVALID_INPUT", "Batch id is required.");
  if (!opts.items.length) throw new BankError("EMPTY_BATCH", "Nothing to issue — select at least one student.");
  const seen = new Set<string>();
  for (const it of opts.items) {
    if (seen.has(it.userId)) throw new BankError("INVALID_INPUT", "Duplicate student in batch — remove the duplicate row.");
    seen.add(it.userId);
  }
  return withTx(async (t) => {
    const bills: Bill[] = [];
    for (const it of opts.items) {
      bills.push(await issueBillInTx(t, {
        userId: it.userId, title: it.title, amountCents: it.amountCents,
        lateFeeCents: it.lateFeeCents, dueAt: it.dueAt, templateId: it.templateId ?? null,
        issuedBy: opts.issuedBy, idempotencyKey: `${opts.batchId}:${it.userId}`,
      }));
    }
    return { issued: bills.length, batchId: opts.batchId, bills };
  });
}

export function fmtCents(cents: number): string {  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  return `${sign}$${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
}
