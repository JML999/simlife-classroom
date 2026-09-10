/**
 * Ledger tests: balances, reversals, duplicates, insufficient funds.
 * Run: npm test
 */
import "./env.js";
import os from "node:os";
import path from "node:path";
import { test, before } from "node:test";
import assert from "node:assert";

process.env["SIMLIFE_DB_PATH"] = path.join(os.tmpdir(), `simlife-ledger-test-${process.pid}.db`);
// Never touch a real database from tests, even if .env sets SIMLIFE_DATABASE_URL.
delete process.env["SIMLIFE_DATABASE_URL"];

const { initSchema, run } = await import("./db.js");
const { adjustCash, reverseCash, checkInvariant, historyFor, LedgerError } = await import("./ledger.js");

let n = 0;
const uid = () => `t_ledger_${process.pid}_${++n}`;

before(async () => {
  await initSchema();
  await run(`INSERT INTO users (id, email, name, role, created_at) VALUES (?, ?, ?, ?, ?)`,
    ["teacher1", "t@example.school", "Teacher", "teacher", new Date().toISOString()]);
});

async function makeStudent(): Promise<string> {
  const id = uid();
  await run(`INSERT INTO users (id, email, name, role, created_at) VALUES (?, ?, ?, ?, ?)`,
    [id, `${id}@example.school`, "Stu", "student", new Date().toISOString()]);
  return id;
}

test("add cash credits balance and keeps the invariant", async () => {
  const s = await makeStudent();
  const r = await adjustCash({ userId: s, actorId: "teacher1", amountCents: 100000, reason: "Starting balance", idempotencyKey: uid() });
  assert.equal(r.deduped, false);
  assert.equal(r.entry.amount_cents, 100000);
  const inv = await checkInvariant(s);
  assert.ok(inv.ok && inv.cash === 100000 && inv.sum === 100000);
});

test("reason is required", async () => {
  const s = await makeStudent();
  await assert.rejects(
    () => adjustCash({ userId: s, actorId: "teacher1", amountCents: 100, reason: "  ", idempotencyKey: uid() }),
    (e: any) => e instanceof LedgerError && e.code === "INVALID_REASON",
  );
});

test("removal beyond cash fails without liquidating", async () => {
  const s = await makeStudent();
  await adjustCash({ userId: s, actorId: "teacher1", amountCents: 5000, reason: "Seed", idempotencyKey: uid() });
  await assert.rejects(
    () => adjustCash({ userId: s, actorId: "teacher1", amountCents: -99999, reason: "Too much", idempotencyKey: uid() }),
    (e: any) => e instanceof LedgerError && e.code === "INSUFFICIENT_CASH",
  );
  const inv = await checkInvariant(s);
  assert.ok(inv.ok && inv.cash === 5000);
});

test("duplicate idempotency key does not double-credit", async () => {
  const s = await makeStudent();
  const key = uid();
  const a = await adjustCash({ userId: s, actorId: "teacher1", amountCents: 2500, reason: "One-time", idempotencyKey: key });
  const b = await adjustCash({ userId: s, actorId: "teacher1", amountCents: 2500, reason: "One-time", idempotencyKey: key });
  assert.equal(a.deduped, false);
  assert.equal(b.deduped, true);
  assert.equal(a.entry.id, b.entry.id);
  const inv = await checkInvariant(s);
  assert.ok(inv.ok && inv.cash === 2500);
});

test("idempotency key cannot be reused for another account or amount", async () => {
  const first = await makeStudent();
  const second = await makeStudent();
  const key = uid();
  await adjustCash({ userId: first, actorId: "teacher1", amountCents: 2500, reason: "One-time", idempotencyKey: key });
  await assert.rejects(
    () => adjustCash({ userId: second, actorId: "teacher1", amountCents: 2500, reason: "One-time", idempotencyKey: key }),
    (e: any) => e instanceof LedgerError && e.code === "IDEMPOTENCY_CONFLICT",
  );
  await assert.rejects(
    () => adjustCash({ userId: first, actorId: "teacher1", amountCents: 5000, reason: "One-time", idempotencyKey: key }),
    (e: any) => e instanceof LedgerError && e.code === "IDEMPOTENCY_CONFLICT",
  );
  assert.ok((await checkInvariant(first)).ok);
  assert.ok((await checkInvariant(second)).ok);
});

test("reversal compensates without deleting; double reversal rejected", async () => {
  const s = await makeStudent();
  const orig = await adjustCash({ userId: s, actorId: "teacher1", amountCents: 10000, reason: "Wrong amount", idempotencyKey: uid() });
  const rev = await reverseCash({ entryId: orig.entry.id, actorId: "teacher1", reason: "Entered $100, meant $10", idempotencyKey: uid() });
  assert.equal(rev.entry.amount_cents, -10000);
  assert.equal(rev.entry.reverses_id, orig.entry.id);
  const hist = await historyFor(s);
  assert.equal(hist.length, 2, "original must be preserved");
  const inv = await checkInvariant(s);
  assert.ok(inv.ok && inv.cash === 0);
  await assert.rejects(
    () => reverseCash({ entryId: orig.entry.id, actorId: "teacher1", reason: "Again", idempotencyKey: uid() }),
    (e: any) => e instanceof LedgerError && e.code === "ALREADY_REVERSED",
  );
});

test("reversal that would drive cash negative is rejected", async () => {
  const s = await makeStudent();
  const orig = await adjustCash({ userId: s, actorId: "teacher1", amountCents: 5000, reason: "Seed", idempotencyKey: uid() });
  // Spend the cash first via a negative adjustment path is impossible, so simulate
  // by removing cash down to zero through a valid removal, then reversing the seed.
  await adjustCash({ userId: s, actorId: "teacher1", amountCents: -5000, reason: "Withdraw for test", idempotencyKey: uid() });
  await adjustCash({ userId: s, actorId: "teacher1", amountCents: 100, reason: "Tiny top-up", idempotencyKey: uid() });
  await assert.rejects(
    () => reverseCash({ entryId: orig.entry.id, actorId: "teacher1", reason: "Too late", idempotencyKey: uid() }),
    (e: any) => e instanceof LedgerError && e.code === "INSUFFICIENT_CASH",
  );
});

test("zero amount rejected", async () => {
  const s = await makeStudent();
  await assert.rejects(
    () => adjustCash({ userId: s, actorId: "teacher1", amountCents: 0, reason: "Nothing", idempotencyKey: uid() }),
    (e: any) => e instanceof LedgerError && e.code === "INVALID_AMOUNT",
  );
});
