import "./env.js";
import os from "node:os";
import path from "node:path";
import { before, test } from "node:test";
import assert from "node:assert";

process.env["SIMLIFE_DB_PATH"] = path.join(os.tmpdir(), `simlife-life-events-${process.pid}.db`);
delete process.env["SIMLIFE_DATABASE_URL"];
const db = await import("./db.js");
const life = await import("./life-events.js");
const now = new Date("2026-09-28T14:00:00Z");

before(async () => {
  await db.initSchema();
  await db.run(`INSERT INTO classes (id, name, join_code, trading_frozen, created_at) VALUES ('wheel-class', 'Wheel Class', 'WHEEL', 0, ?)`, [now.toISOString()]);
  for (const id of ["wheel-a", "wheel-b", "wheel-c", "wheel-no-job"]) {
    await db.run(`INSERT INTO users (id, name, role, class_id, job_title, job_pay_cents, created_at)
      VALUES (?, ?, 'student', 'wheel-class', ?, ?, ?)`, [id, id, id === "wheel-no-job" ? null : "Electrician", id === "wheel-no-job" ? null : 85000, now.toISOString()]);
  }
});

test("a deposit spin reaches checking once and cannot reroll that day", async () => {
  const first = await life.spinLifeEvent({ classId: "wheel-class", studentId: "wheel-a", actorId: "teacher", now, drawIndex: 0 });
  const again = await life.spinLifeEvent({ classId: "wheel-class", studentId: "wheel-a", actorId: "teacher", now, drawIndex: 4 });
  assert.equal(first.id, again.id);
  assert.equal(first.key, "inheritance");
  assert.equal(first.status, "applied");
  const account = await db.one<{ checking_cents: number }>(`SELECT checking_cents FROM bank_accounts WHERE user_id = 'wheel-a'`);
  assert.equal(Number(account?.checking_cents), 20000);
  await db.run(`UPDATE life_events SET status = 'pending' WHERE id = ?`, [first.id]);
  await life.spinLifeEvent({ classId: "wheel-class", studentId: "wheel-a", actorId: "teacher", now });
  assert.equal(Number((await db.one<{ checking_cents: number }>(`SELECT checking_cents FROM bank_accounts WHERE user_id = 'wheel-a'`))?.checking_cents), 20000);
  const postings = await db.q(`SELECT id FROM income_postings WHERE user_id = 'wheel-a'`);
  assert.equal(postings.length, 1);
});

test("an expense creates a payable bill without silently withdrawing cash", async () => {
  const event = await life.spinLifeEvent({ classId: "wheel-class", studentId: "wheel-b", actorId: "teacher", now, drawIndex: 4 });
  assert.equal(event.key, "flat_tire");
  const bills = await db.q<{ title: string; amount_cents: number; paid_cents: number }>(`SELECT title, amount_cents, paid_cents FROM bills WHERE user_id = 'wheel-b'`);
  assert.deepEqual(bills.map((bill) => [bill.title, Number(bill.amount_cents), Number(bill.paid_cents)]), [["Flat tire", 6000, 0]]);
  await db.run(`UPDATE life_events SET status = 'pending' WHERE id = ?`, [event.id]);
  await life.spinLifeEvent({ classId: "wheel-class", studentId: "wheel-b", actorId: "teacher", now });
  assert.equal((await db.q(`SELECT id FROM bills WHERE user_id = 'wheel-b'`)).length, 1);
  assert.equal((await life.studentLifeEvents("wheel-b")).length, 1);
});

test("layoff immediately assigns the Arby's cashier role and a lower paycheck", async () => {
  const event = await life.spinLifeEvent({ classId: "wheel-class", studentId: "wheel-c", actorId: "teacher", now, drawIndex: 9 });
  assert.equal(event.newJobTitle, "Cashier at Arby's");
  assert.equal(event.newPayCents, 40000);
  const student = await db.one<{ job_title: string; job_pay_cents: number }>(`SELECT job_title, job_pay_cents FROM users WHERE id = 'wheel-c'`);
  assert.deepEqual([student?.job_title, Number(student?.job_pay_cents)], ["Cashier at Arby's", 40000]);
  await assert.rejects(() => life.spinLifeEvent({ classId: "wrong-class", studentId: "wheel-no-job", actorId: "teacher", now }), /selected period/);
  await assert.rejects(() => life.spinLifeEvent({ classId: "wheel-class", studentId: "wheel-no-job", actorId: "teacher", now }), /Assign this student a job/);
});
