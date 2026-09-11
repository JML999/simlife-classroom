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
    | "NOT_YOUR_BILL" | "INVALID_INPUT" | "EMPTY_BATCH" | "IDEMPOTENCY_CONFLICT"
    | "ALREADY_RESOLVED";
  constructor(code: BankError["code"], msg: string) {
    super(msg);
    this.code = code;
  }
}

export interface BankAccount {
  id: string;
  checkingCents: number;
  savingsCents: number;
  interestResidualMicros: number;
  interestAccruedAt: string;
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
  paid_cents: number;
  sender: string | null;
  document_title: string | null;
  document_body: string | null;
  idempotency_key: string | null;
  issued_by: string | null;
  created_at: string;
  status?: BillStatus;
  total_due_cents?: number;
  remaining_cents?: number;
  disputes?: BillDispute[];
}

export interface BillDispute {
  id: string; bill_id: string; user_id: string; reason: string; status: string;
  resolution: string | null; resolved_at: string | null; resolved_by: string | null;
  idempotency_key: string; resolve_key: string | null;
  created_at: string;
}

const DEFAULT_SAVINGS_APY_BPS = 340;
const YEAR_MS = 365.2425 * 24 * 60 * 60 * 1000;
const MICROS_PER_CENT = 1_000_000;

/** Classroom benchmark, configurable without a code change. 340 bps = 3.40% APY. */
export function savingsRate() {
  const raw = Number(process.env["SIMLIFE_SAVINGS_APY_BPS"] || DEFAULT_SAVINGS_APY_BPS);
  const apyBps = Number.isInteger(raw) && raw >= 0 && raw <= 2500 ? raw : DEFAULT_SAVINGS_APY_BPS;
  return {
    apyBps,
    apy: apyBps / 10_000,
    label: process.env["SIMLIFE_SAVINGS_RATE_LABEL"] || "High-yield classroom benchmark · Marcus Online Savings",
    asOf: process.env["SIMLIFE_SAVINGS_RATE_AS_OF"] || "2026-09-07",
  };
}

export function billStatus(b: Pick<Bill, "paid_at" | "due_at">, now = new Date()): BillStatus {
  if (b.paid_at) return "paid";
  return new Date(b.due_at).getTime() < now.getTime() ? "late" : "due";
}

/** Total owed right now: base amount plus the late fee once the bill is late. */
export function billTotal(b: Pick<Bill, "amount_cents" | "late_fee_cents" | "paid_at" | "due_at">, now = new Date()): number {
  const comparison = b.paid_at ? new Date(b.paid_at) : now;
  const late = new Date(b.due_at).getTime() < comparison.getTime();
  return b.amount_cents + (late ? b.late_fee_cents : 0);
}

export function billRemaining(b: Pick<Bill, "amount_cents" | "late_fee_cents" | "paid_at" | "due_at" | "paid_cents">, now = new Date()): number {
  if (b.paid_at) return 0;
  return Math.max(0, billTotal(b, now) - Number(b.paid_cents || 0));
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
  // Serialize first-account creation per user on Postgres. Without this lock,
  // two simultaneous first paychecks can race on bank_accounts.user_id UNIQUE.
  const user = await t.one<{ id: string }>(`SELECT id FROM users WHERE id = ?${fu}`, [userId]);
  if (!user) throw new BankError("NOT_FOUND", "Student account not found.");
  let acct = await t.one<{ id: string; checking_cents: number; savings_cents: number; interest_residual_micros: number; interest_accrued_at: string | null }>(
    `SELECT id, checking_cents, savings_cents, interest_residual_micros, interest_accrued_at FROM bank_accounts WHERE user_id = ?${fu}`, [userId],
  );
  if (!acct) {
    const id = newId("bac");
    const now = nowIso();
    await t.run(`INSERT INTO bank_accounts (id, user_id, checking_cents, savings_cents, interest_residual_micros, interest_accrued_at, created_at) VALUES (?, ?, 0, 0, 0, ?, ?)`,
      [id, userId, now, now]);
    return { id, checkingCents: 0, savingsCents: 0, interestResidualMicros: 0, interestAccruedAt: now };
  }
  return {
    id: acct.id, checkingCents: Number(acct.checking_cents), savingsCents: Number(acct.savings_cents),
    interestResidualMicros: Number(acct.interest_residual_micros || 0),
    interestAccruedAt: acct.interest_accrued_at || nowIso(),
  };
}

/**
 * Settle continuously accrued savings interest into whole cents before any
 * savings mutation or summary. Residual micro-cents preserve sub-cent earnings.
 * The posted credit is a normal journal entry, so the savings invariant holds.
 */
async function settleSavingsInterest(t: Tx, acct: BankAccount, now = new Date()): Promise<BankAccount> {
  const last = new Date(acct.interestAccruedAt);
  const elapsedMs = Math.max(0, now.getTime() - last.getTime());
  if (!elapsedMs) return acct;
  const { apy } = savingsRate();
  const earnedMicros = Math.floor(acct.savingsCents * (Math.pow(1 + apy, elapsedMs / YEAR_MS) - 1) * MICROS_PER_CENT);
  const totalMicros = acct.interestResidualMicros + earnedMicros;
  const creditCents = Math.floor(totalMicros / MICROS_PER_CENT);
  const residual = totalMicros - creditCents * MICROS_PER_CENT;
  if (creditCents > 0) {
    await insertJournal(t, {
      id: newId("bj"), bank_account_id: acct.id, kind: "savings_interest",
      checking_leg: 0, savings_leg: creditCents,
      memo: `${(savingsRate().apy * 100).toFixed(2)}% APY savings interest`, actor_id: null,
      idempotency_key: null, related_id: null, created_at: now.toISOString(),
    });
  }
  await t.run(
    `UPDATE bank_accounts SET savings_cents = ?, interest_residual_micros = ?, interest_accrued_at = ? WHERE id = ?`,
    [acct.savingsCents + creditCents, residual, now.toISOString(), acct.id],
  );
  return { ...acct, savingsCents: acct.savingsCents + creditCents, interestResidualMicros: residual, interestAccruedAt: now.toISOString() };
}

async function findJournalByKey(t: Tx, key: string): Promise<JournalEntry | undefined> {
  return t.one<JournalEntry>(`SELECT * FROM bank_journal WHERE idempotency_key = ?`, [key]);
}

async function journalOwner(t: Tx, entry: JournalEntry): Promise<string | undefined> {
  return (await t.one<{ user_id: string }>(`SELECT user_id FROM bank_accounts WHERE id = ?`, [entry.bank_account_id]))?.user_id;
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
    // Lock the student's account boundary before checking the request key.
    // This makes simultaneous retries for the same student serialize on PG;
    // SQLite's BEGIN IMMEDIATE provides the equivalent writer serialization.
    const acct = await getOrCreateBankAccount(t, opts.userId);
    const existing = await findJournalByKey(t, key);
    if (existing) {
      if (await journalOwner(t, existing) !== opts.userId || existing.kind !== "income" || existing.checking_leg !== amount || existing.savings_leg !== 0) {
        throw new BankError("IDEMPOTENCY_CONFLICT", "That deposit confirmation was already used for different details.");
      }
      return { entry: existing, deduped: true };
    }
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
  const checkingLeg = opts.from === "checking" ? -amount : opts.to === "checking" ? amount : 0;
  const savingsLeg = opts.from === "savings" ? -amount : opts.to === "savings" ? amount : 0;
  const kind = opts.to === "brokerage" ? "transfer_to_brokerage" : "transfer";
  return withTx(async (t) => {
    let acct = await getOrCreateBankAccount(t, opts.userId);
    const existing = await findJournalByKey(t, key);
    if (existing) {
      if (await journalOwner(t, existing) !== opts.userId || existing.kind !== kind || existing.checking_leg !== checkingLeg || existing.savings_leg !== savingsLeg) {
        throw new BankError("IDEMPOTENCY_CONFLICT", "That transfer confirmation was already used for different details. Refresh and try again.");
      }
      return { entry: existing, deduped: true };
    }
    const fu = t.dialect === "pg" ? " FOR UPDATE" : "";
    if (opts.from === "savings" || opts.to === "savings") acct = await settleSavingsInterest(t, acct);
    const nextChecking = acct.checkingCents + checkingLeg;
    const nextSavings = acct.savingsCents + savingsLeg;
    if (nextChecking < 0) {
      throw new BankError("INSUFFICIENT_FUNDS", `Only ${fmtCents(acct.checkingCents)} in checking. No other account is used to cover the shortfall.`);
    }
    if (nextSavings < 0) {
      throw new BankError("INSUFFICIENT_FUNDS", `Only ${fmtCents(acct.savingsCents)} in savings. No other account is used to cover the shortfall.`);
    }
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
  sender?: string; documentTitle?: string; documentBody?: string;
}): Promise<{ id: string }> {
  const title = (opts.title || "").trim();
  if (title.length < 2 || title.length > 120) throw new BankError("INVALID_INPUT", "Bill title must be 2–120 characters.");
  const amount = requireSaneCents(requirePositiveCents(opts.amountCents, "Bill amount"));
  const fee = opts.lateFeeCents === undefined ? 0 : requireSaneCents(Math.floor(opts.lateFeeCents), "Late fee");
  if (fee < 0) throw new BankError("INVALID_AMOUNT", "Late fee cannot be negative.");
  const { run } = await import("./db.js");
  const id = newId("bt");
  await run(
    `INSERT INTO bill_templates (id, teacher_id, title, amount_cents, late_fee_cents, description, sender, document_title, document_body, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, opts.teacherId, title, amount, fee, (opts.description || "").trim().slice(0, 500) || null,
      (opts.sender || "").trim().slice(0, 120) || null, (opts.documentTitle || "").trim().slice(0, 160) || null,
      (opts.documentBody || opts.description || "").trim().slice(0, 8000) || null, nowIso()],
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
  sender?: string | null;
  documentTitle?: string | null;
  documentBody?: string | null;
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
  // Bills and bill-key retries share the same per-student serialization
  // boundary as deposits and transfers.
  const fu = t.dialect === "pg" ? " FOR UPDATE" : "";
  const user = await t.one<{ id: string }>(`SELECT id FROM users WHERE id = ?${fu}`, [b.userId]);
  if (!user) throw new BankError("NOT_FOUND", "Student account not found.");
  const existing = await t.one<Bill>(`SELECT * FROM bills WHERE idempotency_key = ?`, [key]);
  if (existing) {
    if (existing.user_id !== b.userId || existing.title !== title || Number(existing.amount_cents) !== amount ||
        Number(existing.late_fee_cents) !== fee || new Date(existing.due_at).getTime() !== due.getTime()) {
      throw new BankError("IDEMPOTENCY_CONFLICT", "That bill confirmation was already used for different details.");
    }
    return { ...existing, paid_cents: Number(existing.paid_cents || 0), status: billStatus(existing), total_due_cents: billTotal(existing), remaining_cents: billRemaining(existing) };
  }
  const row: Bill = {
    id: newId("bill"), user_id: b.userId, template_id: b.templateId ?? null,
    title, amount_cents: amount, late_fee_cents: fee,
    issued_at: nowIso(), due_at: due.toISOString(), paid_at: null, payment_journal_id: null,
    paid_cents: 0, sender: (b.sender || "").trim().slice(0, 120) || null,
    document_title: (b.documentTitle || "").trim().slice(0, 160) || null,
    document_body: (b.documentBody || "").trim().slice(0, 8000) || null,
    idempotency_key: key, issued_by: b.issuedBy, created_at: nowIso(),
  };
  try {
    await t.run(
      `INSERT INTO bills (id, user_id, template_id, title, amount_cents, late_fee_cents, issued_at, due_at, paid_at, payment_journal_id, paid_cents, sender, document_title, document_body, idempotency_key, issued_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.user_id, row.template_id, row.title, row.amount_cents, row.late_fee_cents, row.issued_at, row.due_at,
        row.sender, row.document_title, row.document_body, row.idempotency_key, row.issued_by, row.created_at],
    );
  } catch (err: any) {
    if (isUniqueViolation(err)) {
      const dup = (await t.one<Bill>(`SELECT * FROM bills WHERE idempotency_key = ?`, [key]))!;
      return { ...dup, paid_cents: Number(dup.paid_cents || 0), status: billStatus(dup), total_due_cents: billTotal(dup), remaining_cents: billRemaining(dup) };
    }
    throw err;
  }
  return { ...row, status: billStatus(row), total_due_cents: billTotal(row), remaining_cents: billRemaining(row) };
}

/** Student pays all or part of their own bill from checking. Atomic + idempotent. */
export async function payBill(opts: {
  userId: string; billId: string; amountCents?: number; idempotencyKey: string; now?: Date;
}): Promise<{ entry: JournalEntry; deduped: boolean; paidCents: number; totalCents: number; remainingCents: number }> {
  const key = requireKey(opts.idempotencyKey);
  const now = opts.now ?? new Date();
  return withTx(async (t) => {
    const fu = t.dialect === "pg" ? " FOR UPDATE" : "";
    const bill = await t.one<Bill>(`SELECT * FROM bills WHERE id = ?${fu}`, [opts.billId]);
    if (!bill) throw new BankError("NOT_FOUND", "Bill not found.");
    if (bill.user_id !== opts.userId) throw new BankError("NOT_YOUR_BILL", "You can only pay your own bills.");
    const existing = await t.one<{ bill_id: string; user_id: string; amount_cents: number; journal_id: string }>(
      `SELECT bill_id, user_id, amount_cents, journal_id FROM bill_payments WHERE idempotency_key = ?`, [key],
    );
    if (existing) {
      if (existing.bill_id !== opts.billId || existing.user_id !== opts.userId ||
          (opts.amountCents !== undefined && existing.amount_cents !== opts.amountCents)) {
        throw new BankError("IDEMPOTENCY_CONFLICT", "That payment confirmation was already used for different details. Refresh and try again.");
      }
      const entry = (await t.one<JournalEntry>(`SELECT * FROM bank_journal WHERE id = ?`, [existing.journal_id]))!;
      const bill = (await t.one<Bill>(`SELECT * FROM bills WHERE id = ?`, [existing.bill_id]))!;
      return { entry, deduped: true, paidCents: existing.amount_cents, totalCents: existing.amount_cents, remainingCents: billRemaining(bill, now) };
    }
    if (bill.paid_at) throw new BankError("ALREADY_PAID", "This bill is already paid.");
    const remaining = billRemaining(bill, now);
    const amount = opts.amountCents === undefined ? remaining : requireSaneCents(requirePositiveCents(opts.amountCents, "Payment"), "Payment");
    if (amount > remaining) throw new BankError("INVALID_AMOUNT", `The remaining balance is ${fmtCents(remaining)}. Enter that amount or less.`);
    const acct = await getOrCreateBankAccount(t, opts.userId);
    if (acct.checkingCents < amount) {
      throw new BankError("INSUFFICIENT_FUNDS", `This payment is ${fmtCents(amount)} but checking has ${fmtCents(acct.checkingCents)}. The bill balance did not change.`);
    }
    const entry = await insertJournal(t, {
      id: newId("bj"), bank_account_id: acct.id, kind: "bill_payment",
      checking_leg: -amount, savings_leg: 0,
      memo: `Payment: ${bill.title}`, actor_id: null, idempotency_key: `billpay:${key}`, related_id: bill.id,
    });
    await t.run(
      `INSERT INTO bill_payments (id, bill_id, user_id, amount_cents, journal_id, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [newId("bp"), bill.id, opts.userId, amount, entry.id, key, now.toISOString()],
    );
    const nextPaid = Number(bill.paid_cents || 0) + amount;
    const remainingAfter = Math.max(0, remaining - amount);
    await t.run(`UPDATE bank_accounts SET checking_cents = ? WHERE id = ?`, [acct.checkingCents - amount, acct.id]);
    await t.run(`UPDATE bills SET paid_cents = ?, paid_at = ?, payment_journal_id = ? WHERE id = ?`,
      [nextPaid, remainingAfter === 0 ? now.toISOString() : null, entry.id, bill.id]);
    return { entry, deduped: false, paidCents: amount, totalCents: amount, remainingCents: remainingAfter };
  });
}

/** Student flags correspondence for teacher review; no balance changes. */
export async function disputeBill(opts: {
  userId: string; billId: string; reason: string; idempotencyKey: string;
}): Promise<{ dispute: BillDispute; deduped: boolean }> {
  const key = requireKey(opts.idempotencyKey);
  const reason = String(opts.reason || "").trim();
  if (reason.length < 5 || reason.length > 1000) throw new BankError("INVALID_INPUT", "Explain the question or dispute in 5–1,000 characters.");
  return withTx(async (t) => {
    const fu = t.dialect === "pg" ? " FOR UPDATE" : "";
    const bill = await t.one<Bill>(`SELECT * FROM bills WHERE id = ?${fu}`, [opts.billId]);
    if (!bill) throw new BankError("NOT_FOUND", "Bill not found.");
    if (bill.user_id !== opts.userId) throw new BankError("NOT_YOUR_BILL", "You can only dispute your own bills.");
    const existing = await t.one<BillDispute>(`SELECT * FROM bill_disputes WHERE idempotency_key = ?`, [key]);
    if (existing) {
      if (existing.bill_id !== opts.billId || existing.user_id !== opts.userId || existing.reason !== reason) {
        throw new BankError("IDEMPOTENCY_CONFLICT", "That dispute confirmation was already used for different details. Refresh and try again.");
      }
      return { dispute: existing, deduped: true };
    }
    if (bill.paid_at) throw new BankError("ALREADY_PAID", "This bill is already paid.");
    const dispute: BillDispute = {
      id: newId("bd"), bill_id: bill.id, user_id: opts.userId, reason, status: "open",
      resolution: null, resolved_at: null, resolved_by: null,
      idempotency_key: key, resolve_key: null, created_at: nowIso(),
    };
    await t.run(
      `INSERT INTO bill_disputes (id, bill_id, user_id, reason, status, resolution, resolved_at, idempotency_key, created_at) VALUES (?, ?, ?, ?, 'open', NULL, NULL, ?, ?)`,
      [dispute.id, dispute.bill_id, dispute.user_id, dispute.reason, dispute.idempotency_key, dispute.created_at],
    );
    return { dispute, deduped: false };
  });
}

/**
 * Teacher resolves a student's bill question. Audited state transition, not
 * deletion: sets reply + resolver + timestamp, flips open→resolved.
 *
 * - Same idempotency key + same reply text → deduped (safe retry).
 * - Same key + different text → IDEMPOTENCY_CONFLICT.
 * - Already resolved (any other key) → ALREADY_RESOLVED. Replies are never
 *   silently overwritten; there is no edit path.
 * - Resolution never changes the bill. Paying while open stays allowed.
 */
export async function resolveDispute(opts: {
  disputeId: string; actorId: string; resolution: string; idempotencyKey: string;
}): Promise<{ dispute: BillDispute; deduped: boolean }> {
  const key = requireKey(opts.idempotencyKey);
  const resolution = String(opts.resolution || "").trim();
  if (resolution.length < 2 || resolution.length > 1000) {
    throw new BankError("INVALID_INPUT", "Write a short reply to the student (2–1,000 characters).");
  }
  return withTx(async (t) => {
    const fu = t.dialect === "pg" ? " FOR UPDATE" : "";
    const dispute = await t.one<BillDispute & { owner_role: string }>(
      `SELECT d.*, u.role AS owner_role FROM bill_disputes d JOIN users u ON u.id = d.user_id WHERE d.id = ?${fu}`,
      [opts.disputeId],
    );
    if (!dispute) throw new BankError("NOT_FOUND", "Question not found.");
    if (dispute.owner_role !== "student") throw new BankError("NOT_FOUND", "Question not found.");
    if (dispute.status === "resolved") {
      if (dispute.resolve_key === key) {
        if (dispute.resolution === resolution) return { dispute: stripOwner(dispute), deduped: true };
        throw new BankError("IDEMPOTENCY_CONFLICT", "That answer confirmation was already used for different details. Refresh to see the recorded answer.");
      }
      throw new BankError(
        "ALREADY_RESOLVED",
        `This question was already answered${dispute.resolved_at ? ` on ${new Date(dispute.resolved_at).toLocaleDateString()}` : ""}. Resolved answers cannot be overwritten.`,
      );
    }
    const now = nowIso();
    const n = await t.run(
      `UPDATE bill_disputes SET status = 'resolved', resolution = ?, resolved_at = ?, resolved_by = ?, resolve_key = ?
       WHERE id = ? AND status = 'open'`,
      [resolution, now, opts.actorId, key, dispute.id],
    );
    if (n === 0) {
      // Lost a concurrent race: re-read to answer precisely, never overwrite.
      const current = (await t.one<BillDispute>(`SELECT * FROM bill_disputes WHERE id = ?`, [dispute.id]))!;
      if (current.status === "resolved" && current.resolve_key === key && current.resolution === resolution) {
        return { dispute: current, deduped: true };
      }
      throw new BankError("ALREADY_RESOLVED", "This question was just answered. Resolved answers cannot be overwritten.");
    }
    const done = (await t.one<BillDispute>(`SELECT * FROM bill_disputes WHERE id = ?`, [dispute.id]))!;
    return { dispute: done, deduped: false };
  });
}

function stripOwner(d: BillDispute & { owner_role?: string }): BillDispute {
  const { owner_role, ...rest } = d;
  void owner_role;
  return rest;
}

export interface DisputeInboxItem extends BillDispute {
  student_name: string;
  class_id: string | null;
  class_name: string | null;
  bill_title: string;
  remaining_cents: number;
  bill_status: BillStatus;
}

/** Teacher inbox: open questions first, then newest. Optional class filter. */
export async function listDisputes(classId?: string): Promise<DisputeInboxItem[]> {
  const { q } = await import("./db.js");
  const rows = await q<DisputeInboxItem & { amount_cents: number; late_fee_cents: number; paid_at: string | null; due_at: string; paid_cents: number }>(
    `SELECT d.*, u.name AS student_name, u.class_id AS class_id, c.name AS class_name,
            b.title AS bill_title, b.amount_cents AS amount_cents, b.late_fee_cents AS late_fee_cents,
            b.paid_at AS paid_at, b.due_at AS due_at, b.paid_cents AS paid_cents
     FROM bill_disputes d
     JOIN users u ON u.id = d.user_id
     JOIN bills b ON b.id = d.bill_id
     LEFT JOIN classes c ON c.id = u.class_id
     WHERE u.role = 'student' ${classId ? "AND u.class_id = ?" : ""}
     ORDER BY CASE WHEN d.status = 'open' THEN 0 ELSE 1 END, d.created_at DESC`,
    classId ? [classId] : [],
  );
  const now = new Date();
  return rows.map((r) => ({
    ...r,
    bill_status: billStatus({ paid_at: r.paid_at, due_at: r.due_at }, now),
    remaining_cents: billRemaining({
      amount_cents: Number(r.amount_cents), late_fee_cents: Number(r.late_fee_cents),
      paid_at: r.paid_at, due_at: r.due_at, paid_cents: Number(r.paid_cents || 0),
    }, now),
  }));
}

export async function accrueSavingsForUser(userId: string, now = new Date()): Promise<void> {  await withTx(async (t) => {
    const fu = t.dialect === "pg" ? " FOR UPDATE" : "";
    const row = await t.one<{ id: string; checking_cents: number; savings_cents: number; interest_residual_micros: number; interest_accrued_at: string | null }>(
      `SELECT id, checking_cents, savings_cents, interest_residual_micros, interest_accrued_at FROM bank_accounts WHERE user_id = ?${fu}`, [userId],
    );
    if (!row) return;
    await settleSavingsInterest(t, {
      id: row.id, checkingCents: Number(row.checking_cents), savingsCents: Number(row.savings_cents),
      interestResidualMicros: Number(row.interest_residual_micros || 0), interestAccruedAt: row.interest_accrued_at || now.toISOString(),
    }, now);
  });
}

export async function bankSummaryFor(userId: string): Promise<{
  checkingCents: number; savingsCents: number; bills: Bill[]; recent: JournalEntry[];
  savingsInterest: { apyBps: number; apy: number; label: string; asOf: string; earnedCents: number; projection: { years: number; balanceCents: number; interestCents: number }[] };
}> {
  const { one, q } = await import("./db.js");
  await accrueSavingsForUser(userId);
  const rate = savingsRate();
  const emptyInterest = { ...rate, earnedCents: 0, projection: [1, 5, 10].map((years) => ({ years, balanceCents: 0, interestCents: 0 })) };
  const acct = await one<{ id: string; checking_cents: number; savings_cents: number }>(
    `SELECT id, checking_cents, savings_cents FROM bank_accounts WHERE user_id = ?`, [userId],
  );
  const byUser = await q<Bill>(`SELECT * FROM bills WHERE user_id = ? ORDER BY CASE WHEN paid_at IS NULL THEN 0 ELSE 1 END, due_at ASC`, [userId]);
  const disputes = await q<BillDispute>(
    `SELECT d.* FROM bill_disputes d JOIN bills b ON b.id = d.bill_id WHERE b.user_id = ? ORDER BY d.created_at DESC`, [userId],
  );
  const disputesByBill = new Map<string, BillDispute[]>();
  for (const d of disputes) disputesByBill.set(d.bill_id, [...(disputesByBill.get(d.bill_id) || []), d]);
  const now = new Date();
  const withStatus = byUser.map((b) => ({
    ...b,
    // Compatibility for bills paid before partial-payment tracking existed:
    // those rows have paid_at/payment journal but migrated paid_cents = 0.
    paid_cents: b.paid_at && !Number(b.paid_cents) ? billTotal(b, new Date(b.paid_at)) : Number(b.paid_cents || 0),
    status: billStatus(b, now), total_due_cents: billTotal(b, now),
    remaining_cents: billRemaining(b, now), disputes: disputesByBill.get(b.id) || [],
  }));
  const recent = acct ? await q<JournalEntry>(`SELECT * FROM bank_journal WHERE bank_account_id = ? ORDER BY created_at DESC LIMIT 50`, [acct.id]) : [];
  const earned = acct ? await one<{ cents: number }>(
    `SELECT COALESCE(SUM(savings_leg), 0) AS cents FROM bank_journal WHERE bank_account_id = ? AND kind = 'savings_interest'`, [acct.id],
  ) : undefined;
  const savings = Number(acct?.savings_cents || 0);
  const projection = [1, 5, 10].map((years) => {
    const balanceCents = Math.round(savings * Math.pow(1 + rate.apy, years));
    return { years, balanceCents, interestCents: balanceCents - savings };
  });
  return {
    checkingCents: Number(acct?.checking_cents || 0), savingsCents: savings, bills: withStatus, recent,
    savingsInterest: acct ? { ...rate, earnedCents: Number(earned?.cents || 0), projection } : emptyInterest,
  };
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
  // Deterministic row-lock order: concurrent batches covering overlapping
  // students must not lock bank_accounts rows in opposite orders (a classic
  // Postgres deadlock). Sorting by userId makes every writer agree.
  const ordered = [...opts.items].sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
  return withTx(async (t) => {
    let posted = 0;
    for (const it of ordered) {
      const key = `${opts.batchId}:${it.userId}`;
      const acct = await getOrCreateBankAccount(t, it.userId);
      const existing = await findJournalByKey(t, key);
      if (existing) {
        if (await journalOwner(t, existing) !== it.userId || existing.kind !== "income" || existing.checking_leg !== it.amountCents) {
          throw new BankError("IDEMPOTENCY_CONFLICT", "That paycheck batch id was already used for different details.");
        }
        continue;
      }
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
  items: { userId: string; title: string; amountCents: number; lateFeeCents?: number; dueAt: string; templateId?: string | null; sender?: string | null; documentTitle?: string | null; documentBody?: string | null }[];
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
        sender: it.sender, documentTitle: it.documentTitle, documentBody: it.documentBody,
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
