import "./env.js";
import os from "node:os";
import path from "node:path";
import { test, before } from "node:test";
import assert from "node:assert";

process.env["SIMLIFE_DB_PATH"] = path.join(os.tmpdir(), `simlife-admin-test-${process.pid}.db`);
delete process.env["SIMLIFE_DATABASE_URL"];

const { initSchema, run, one, q, withTx } = await import("./db.js");
const { adjustCash, checkInvariant } = await import("./ledger.js");
const { postIncome, transfer, checkBankInvariant, issueBillInTx } = await import("./bank.js");
const { deletionStatus, deleteEmptyStudent, mergeStudents, StudentAdminError } = await import("./student-admin.js");

let n = 0;
const uid = () => `t_admin_${process.pid}_${++n}`;
const TEACHER = "admin_teacher";
async function makeStudent(name: string, email: string) {
  const id = uid();
  await run(`INSERT INTO users (id, email, name, role, google_sub, created_at) VALUES (?, ?, ?, 'student', ?, ?)`, [id, email, name, `sub-${id}`, new Date().toISOString()]);
  return id;
}

before(async () => {
  await initSchema();
  await run(`INSERT INTO users (id, email, name, role, created_at) VALUES (?, ?, ?, 'teacher', ?)`, [TEACHER, "teacher@test.school", "Teacher", new Date().toISOString()]);
});

test("empty student can be deleted only with exact name confirmation", async () => {
  const id = await makeStudent("Empty Student", "empty@test.school");
  assert.equal((await deletionStatus(id)).canDelete, true);
  await assert.rejects(() => deleteEmptyStudent({ userId: id, confirmation: "DELETE" }), (e: any) => e instanceof StudentAdminError && e.code === "INVALID_INPUT");
  await deleteEmptyStudent({ userId: id, confirmation: "Empty Student" });
  assert.equal(await one(`SELECT id FROM users WHERE id = ?`, [id]), undefined);
});

test("active student cannot be deleted and duplicate merge preserves all money, history, bills, and login aliases", async () => {
  const target = await makeStudent("Correct Student", "correct@test.school");
  const source = await makeStudent("Duplicate Student", "duplicate@test.school");
  await adjustCash({ userId: target, actorId: TEACHER, amountCents: 10000, reason: "Target funding", idempotencyKey: uid() });
  await adjustCash({ userId: source, actorId: TEACHER, amountCents: 20000, reason: "Source funding", idempotencyKey: uid() });
  await postIncome({ userId: target, actorId: TEACHER, label: "Target pay", amountCents: 30000, idempotencyKey: uid() });
  await postIncome({ userId: source, actorId: TEACHER, label: "Source pay", amountCents: 40000, idempotencyKey: uid() });
  await transfer({ userId: source, from: "checking", to: "savings", amountCents: 5000, idempotencyKey: uid() });
  await withTx((t) => issueBillInTx(t, { userId: source, title: "Phone", amountCents: 6000, lateFeeCents: 0, dueAt: new Date(Date.now() + 86400000).toISOString(), idempotencyKey: uid(), issuedBy: TEACHER }));
  assert.equal((await deletionStatus(source)).canDelete, false);
  await assert.rejects(() => deleteEmptyStudent({ userId: source, confirmation: "Duplicate Student" }), (e: any) => e instanceof StudentAdminError && e.code === "HAS_ACTIVITY");

  await mergeStudents({ targetUserId: target, sourceUserId: source, actorId: TEACHER, reason: "Duplicate Google account", confirmation: "MERGE" });
  assert.equal(await one(`SELECT id FROM users WHERE id = ?`, [source]), undefined);
  assert.equal((await one<any>(`SELECT cash_cents FROM accounts WHERE user_id = ?`, [target]))?.cash_cents, 30000);
  assert.equal((await one<any>(`SELECT checking_cents, savings_cents FROM bank_accounts WHERE user_id = ?`, [target]))?.checking_cents, 65000);
  assert.equal((await one<any>(`SELECT savings_cents FROM bank_accounts WHERE user_id = ?`, [target]))?.savings_cents, 5000);
  assert.equal((await one<any>(`SELECT COUNT(*) AS n FROM bills WHERE user_id = ?`, [target]))?.n, 1);
  assert.equal((await one<any>(`SELECT user_id FROM user_aliases WHERE email = ?`, ["duplicate@test.school"]))?.user_id, target);
  assert.equal((await q(`SELECT * FROM student_account_merges WHERE target_user_id = ?`, [target])).length, 1);
  assert.ok((await checkInvariant(target)).ok);
  assert.ok((await checkBankInvariant(target)).ok);
});
