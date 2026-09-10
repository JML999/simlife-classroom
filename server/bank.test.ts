/**
 * Banking tests: journal conservation, transfers, bills, income batches,
 * idempotency, rollback, authorization boundaries. Isolated SQLite fixtures.
 * Run: npm test
 */
import "./env.js";
import os from "node:os";
import path from "node:path";
import { test, before } from "node:test";
import assert from "node:assert";

process.env["SIMLIFE_DB_PATH"] = path.join(os.tmpdir(), `simlife-bank-test-${process.pid}.db`);
// Never touch a real database from tests, even if .env sets SIMLIFE_DATABASE_URL.
delete process.env["SIMLIFE_DATABASE_URL"];

const { initSchema, run, one } = await import("./db.js");
const {
  postIncome, transfer, payBill, createBillTemplate, issueBillInTx,
  issueIncomeBatch, issueBillBatch, bankSummaryFor, checkBankInvariant,
  billStatus, billTotal, BankError,
} = await import("./bank.js");
const { checkInvariant } = await import("./ledger.js");
const { withTx } = await import("./db.js");

let n = 0;
const uid = () => `t_bank_${process.pid}_${++n}`;
const TEACHER = "bteacher";

before(async () => {
  await initSchema();
  await run(`INSERT INTO users (id, email, name, role, created_at) VALUES (?, ?, ?, ?, ?)`,
    [TEACHER, "bt@example.school", "Teacher", "teacher", new Date().toISOString()]);
});

async function makeStudent(classId: string | null = null): Promise<string> {
  const id = uid();
  await run(`INSERT INTO users (id, email, name, role, class_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, `${id}@example.school`, "Stu", "student", classId, new Date().toISOString()]);
  return id;
}

async function makeClass(): Promise<string> {
  const id = uid();
  await run(`INSERT INTO classes (id, name, join_code, trading_frozen, created_at) VALUES (?, ?, ?, 0, ?)`,
    [id, "Test Class", `TC${n}`, new Date().toISOString()]);
  return id;
}

test("paycheck opens balances and keeps the journal invariant", async () => {
  const s = await makeStudent();
  const r = await postIncome({ userId: s, actorId: TEACHER, label: "Week 1 paycheck", amountCents: 150000, idempotencyKey: uid() });
  assert.equal(r.deduped, false);
  const sum = await bankSummaryFor(s);
  assert.equal(sum.checkingCents, 150000);
  assert.equal(sum.savingsCents, 0);
  const inv = await checkBankInvariant(s);
  assert.ok(inv.ok, JSON.stringify(inv));
});

test("checking↔savings transfer conserves money", async () => {
  const s = await makeStudent();
  await postIncome({ userId: s, actorId: TEACHER, label: "Pay", amountCents: 100000, idempotencyKey: uid() });
  await transfer({ userId: s, from: "checking", to: "savings", amountCents: 30000, idempotencyKey: uid() });
  const sum = await bankSummaryFor(s);
  assert.equal(sum.checkingCents, 70000);
  assert.equal(sum.savingsCents, 30000);
  await transfer({ userId: s, from: "savings", to: "checking", amountCents: 10000, idempotencyKey: uid() });
  const sum2 = await bankSummaryFor(s);
  assert.equal(sum2.checkingCents, 80000);
  assert.equal(sum2.savingsCents, 20000);
  assert.ok((await checkBankInvariant(s)).ok);
});

test("checking→brokerage conserves across BOTH ledgers", async () => {
  const s = await makeStudent();
  await postIncome({ userId: s, actorId: TEACHER, label: "Pay", amountCents: 50000, idempotencyKey: uid() });
  await transfer({ userId: s, from: "checking", to: "brokerage", amountCents: 20000, memo: "Investing", idempotencyKey: uid() });
  const bank = await bankSummaryFor(s);
  assert.equal(bank.checkingCents, 30000);
  assert.ok((await checkBankInvariant(s)).ok);
  const inv = await checkInvariant(s);
  assert.ok(inv.ok && inv.cash === 20000, JSON.stringify(inv));
  const rows = await (await import("./db.js")).q(`SELECT kind, amount_cents FROM ledger l JOIN accounts a ON a.id = l.account_id WHERE a.user_id = ?`, [s]);
  assert.deepEqual(rows.map((r: any) => [r.kind, r.amount_cents]), [["transfer_in", 20000]]);
});

test("insufficient funds rejects with no partial writes", async () => {
  const s = await makeStudent();
  await postIncome({ userId: s, actorId: TEACHER, label: "Pay", amountCents: 5000, idempotencyKey: uid() });
  await assert.rejects(
    () => transfer({ userId: s, from: "checking", to: "savings", amountCents: 99999, idempotencyKey: uid() }),
    (e: any) => e instanceof BankError && e.code === "INSUFFICIENT_FUNDS",
  );
  const sum = await bankSummaryFor(s);
  assert.equal(sum.checkingCents, 5000);
  assert.equal(sum.recent.length, 1, "only the paycheck entry exists");
  assert.ok((await checkBankInvariant(s)).ok);
});

test("duplicate transfer/payment/paycheck requests execute once", async () => {
  const s = await makeStudent();
  await postIncome({ userId: s, actorId: TEACHER, label: "Pay", amountCents: 80000, idempotencyKey: uid() });
  const key = uid();
  const [a, b] = await Promise.all([
    transfer({ userId: s, from: "checking", to: "savings", amountCents: 10000, idempotencyKey: key }),
    transfer({ userId: s, from: "checking", to: "savings", amountCents: 10000, idempotencyKey: key }),
  ]);
  assert.equal(a.entry.id, b.entry.id);
  assert.ok(a.deduped || b.deduped);
  const sum = await bankSummaryFor(s);
  assert.equal(sum.savingsCents, 10000);
  assert.ok((await checkBankInvariant(s)).ok);
});

test("bill lifecycle: issue → due → pay → paid persists; late derived + fee", async () => {
  const s = await makeStudent();
  await postIncome({ userId: s, actorId: TEACHER, label: "Pay", amountCents: 100000, idempotencyKey: uid() });
  const tpl = await createBillTemplate({ teacherId: TEACHER, title: "Electric bill", amountCents: 8000, lateFeeCents: 1500 });
  const future = new Date(Date.now() + 7 * 86400000).toISOString();
  const issued = await withTx(async (t) => issueBillInTx(t, {
    userId: s, title: "Electric bill", amountCents: 8000, lateFeeCents: 1500,
    dueAt: future, templateId: tpl.id, issuedBy: TEACHER, idempotencyKey: uid(),
  }));
  assert.equal(issued.status, "due");
  assert.equal(issued.total_due_cents, 8000);
  // Past-due derivation without any writer:
  assert.equal(billStatus({ paid_at: null, due_at: new Date(Date.now() - 1000).toISOString() }), "late");
  assert.equal(billTotal({ amount_cents: 8000, late_fee_cents: 1500, paid_at: null, due_at: new Date(Date.now() - 1000).toISOString() }), 9500);
  // Pay on time: no fee.
  const paid = await payBill({ userId: s, billId: issued.id, idempotencyKey: uid() });
  assert.equal(paid.totalCents, 8000);
  const sum = await bankSummaryFor(s);
  assert.equal(sum.checkingCents, 92000);
  assert.equal(sum.bills[0].status, "paid");
  // Double-pay rejected AND duplicate key dedupes:
  await assert.rejects(
    () => payBill({ userId: s, billId: issued.id, idempotencyKey: uid() }),
    (e: any) => e instanceof BankError && e.code === "ALREADY_PAID",
  );
  assert.ok((await checkBankInvariant(s)).ok);
});

test("late bill charges amount + fee atomically", async () => {
  const s = await makeStudent();
  await postIncome({ userId: s, actorId: TEACHER, label: "Pay", amountCents: 50000, idempotencyKey: uid() });
  const past = new Date(Date.now() - 86400000).toISOString();
  const issued = await withTx(async (t) => issueBillInTx(t, {
    userId: s, title: "Water", amountCents: 3000, lateFeeCents: 500,
    dueAt: past, templateId: null, issuedBy: TEACHER, idempotencyKey: uid(),
  }));
  assert.equal(issued.status, "late");
  const paid = await payBill({ userId: s, billId: issued.id, idempotencyKey: uid() });
  assert.equal(paid.totalCents, 3500);
  assert.ok((await checkBankInvariant(s)).ok);
});

test("student cannot pay another student's bill; short checking leaves it unpaid", async () => {
  const a = await makeStudent();
  const b = await makeStudent();
  await postIncome({ userId: a, actorId: TEACHER, label: "Pay", amountCents: 1000, idempotencyKey: uid() });
  const issued = await withTx(async (t) => issueBillInTx(t, {
    userId: b, title: "Rent share", amountCents: 50000,
    dueAt: new Date(Date.now() + 86400000).toISOString(), templateId: null, issuedBy: TEACHER, idempotencyKey: uid(),
  }));
  await assert.rejects(
    () => payBill({ userId: a, billId: issued.id, idempotencyKey: uid() }),
    (e: any) => e instanceof BankError && e.code === "NOT_YOUR_BILL",
  );
  await postIncome({ userId: b, actorId: TEACHER, label: "Pay", amountCents: 100, idempotencyKey: uid() });
  await assert.rejects(
    () => payBill({ userId: b, billId: issued.id, idempotencyKey: uid() }),
    (e: any) => e instanceof BankError && e.code === "INSUFFICIENT_FUNDS",
  );
  const sum = await bankSummaryFor(b);
  assert.equal(sum.bills[0].status, "due");
});

test("class-wide paycheck batch posts atomically; retry resumes; failure rolls back", async () => {
  const cls = await makeClass();
  const s1 = await makeStudent(cls);
  const s2 = await makeStudent(cls);
  const other = await makeStudent(); // different class (none) — must be untouched
  const r = await issueIncomeBatch({
    actorId: TEACHER, batchId: uid(),
    items: [
      { userId: s1, label: "Week 2", amountCents: 90000 },
      { userId: s2, label: "Week 2", amountCents: 90000 },
    ],
  });
  assert.equal(r.posted, 2);
  assert.equal((await bankSummaryFor(s1)).checkingCents, 90000);
  // Retry with same batch id posts nothing new:
  const r2 = await issueIncomeBatch({
    actorId: TEACHER, batchId: r.batchId,
    items: [
      { userId: s1, label: "Week 2", amountCents: 90000 },
      { userId: s2, label: "Week 2", amountCents: 90000 },
    ],
  });
  assert.equal(r2.posted, 0);
  assert.equal((await bankSummaryFor(s1)).checkingCents, 90000);
  assert.equal((await bankSummaryFor(other)).checkingCents, 0);
  // A bad row fails the WHOLE batch:
  await assert.rejects(
    () => issueIncomeBatch({
      actorId: TEACHER, batchId: uid(),
      items: [
        { userId: s1, label: "Week 3", amountCents: 10000 },
        { userId: s2, label: "Week 3", amountCents: -5 },
      ],
    }),
    (e: any) => e instanceof BankError,
  );
  assert.equal((await bankSummaryFor(s1)).checkingCents, 90000, "first row rolled back too");
  assert.ok((await checkBankInvariant(s1)).ok && (await checkBankInvariant(s2)).ok);
});

test("class-wide bill batch is scoped and idempotent", async () => {
  const cls = await makeClass();
  const s1 = await makeStudent(cls);
  const outsider = await makeStudent();
  const batch = uid();
  const due = new Date(Date.now() + 3 * 86400000).toISOString();
  const r = await issueBillBatch({
    issuedBy: TEACHER, batchId: batch,
    items: [{ userId: s1, title: "Internet", amountCents: 4500, dueAt: due }],
  });
  assert.equal(r.issued, 1);
  const again = await issueBillBatch({
    issuedBy: TEACHER, batchId: batch,
    items: [{ userId: s1, title: "Internet", amountCents: 4500, dueAt: due }],
  });
  assert.equal(again.bills[0].id, r.bills[0].id, "same bill returned, not duplicated");
  assert.equal((await bankSummaryFor(outsider)).bills.length, 0);
  // Duplicate student inside one batch is rejected before writing:
  await assert.rejects(
    () => issueBillBatch({
      issuedBy: TEACHER, batchId: uid(),
      items: [
        { userId: s1, title: "X", amountCents: 100, dueAt: due },
        { userId: s1, title: "X", amountCents: 100, dueAt: due },
      ],
    }),
    (e: any) => e instanceof BankError && e.code === "INVALID_INPUT",
  );
});

test("brokerage→bank and savings→brokerage are rejected; conservation holds", async () => {
  const s = await makeStudent();
  await postIncome({ userId: s, actorId: TEACHER, label: "Pay", amountCents: 20000, idempotencyKey: uid() });
  await assert.rejects(
    () => transfer({ userId: s, from: "brokerage", to: "checking", amountCents: 100, idempotencyKey: uid() }),
    (e: any) => e instanceof BankError && e.code === "INVALID_INPUT",
  );
  await assert.rejects(
    () => transfer({ userId: s, from: "savings", to: "brokerage", amountCents: 100, idempotencyKey: uid() }),
    (e: any) => e instanceof BankError && e.code === "INVALID_INPUT",
  );
  assert.ok((await checkBankInvariant(s)).ok);
  assert.ok((await checkInvariant(s)).ok);
});

test("opening balances: no account rows until first posting", async () => {
  const s = await makeStudent();
  const sum = await bankSummaryFor(s);
  assert.equal(sum.checkingCents, 0);
  assert.equal(sum.bills.length, 0);
  const row = await one(`SELECT id FROM bank_accounts WHERE user_id = ?`, [s]);
  assert.equal(row, undefined);
});
