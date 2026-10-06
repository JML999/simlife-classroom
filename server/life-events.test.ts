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

test("career wedges use the highest and lowest five percent of assigned pay in that period", async () => {
  await db.run(`INSERT INTO classes (id, name, join_code, trading_frozen, created_at) VALUES ('ranked-class', 'Ranked Class', 'RANKED', 0, ?)`, [now.toISOString()]);
  for (let i = 0; i < 20; i++) {
    const id = `ranked-${i}`;
    const title = i === 0 ? "DoorDash Delivery Driver" : i === 19 ? "Cardiologist" : "Office Assistant";
    const pay = i === 0 ? 20000 : i === 19 ? 2500000 : 40000 + i * 1000;
    await db.run(`INSERT INTO users (id, name, role, class_id, job_title, job_pay_cents, created_at)
      VALUES (?, ?, 'student', 'ranked-class', ?, ?, ?)`, [id, id, title, pay, now.toISOString()]);
  }
  const top = await life.spinLifeEvent({ classId: "ranked-class", studentId: "ranked-19", actorId: "teacher", now, drawIndex: 8 });
  assert.equal(top.index, 8, "the animation lands on the career wedge that was drawn");
  assert.equal(top.key, "layoff");
  assert.equal(top.newJobTitle, "Cashier at Arby's");
  assert.equal(top.newPayCents, 40000);
  const nextHighest = await life.spinLifeEvent({ classId: "ranked-class", studentId: "ranked-18", actorId: "teacher", now, drawIndex: 8 });
  assert.equal(nextHighest.key, "promotion", "the first layoff must not move the next earner into today's top bracket");
  const bottom = await life.spinLifeEvent({ classId: "ranked-class", studentId: "ranked-0", actorId: "teacher", now, drawIndex: 9 });
  assert.equal(bottom.index, 9);
  assert.equal(bottom.key, "promotion");
  assert.equal(bottom.title, "New job assignment");
  assert.equal(bottom.newJobTitle, "Delivery Operations Coordinator");
  assert.equal(bottom.newPayCents, 30000);
  const studentNotice = (await life.studentLifeEvents("ranked-0"))[0];
  assert.equal(studentNotice?.title, "New job assignment");
  assert.equal("key" in studentNotice, false);
  assert.equal("index" in studentNotice, false);
  assert.equal(/percent|bracket|rank/i.test(studentNotice.description), false);
  const middle = await life.spinLifeEvent({ classId: "ranked-class", studentId: "ranked-10", actorId: "teacher", now, drawIndex: 8 });
  assert.equal(middle.key, "promotion");
  assert.equal(middle.newPayCents, 55000);
  const saved = await db.one<{ event_key: string; payload: string }>(`SELECT event_key, payload FROM life_events WHERE id = ?`, [bottom.id]);
  assert.equal(saved?.event_key, "promotion");
  assert.equal(JSON.parse(saved!.payload).wheelIndex, 9);
});


test("highest earners receive the Arby's job even when a non-career event is drawn", async () => {
  await db.run(`INSERT INTO classes (id, name, join_code, trading_frozen, created_at) VALUES ('auto-class', 'Automatic Class', 'AUTO', 0, ?)`, [now.toISOString()]);
  for (let i = 0; i < 20; i++) {
    await db.run(`INSERT INTO users (id, name, role, class_id, job_title, job_pay_cents, created_at)
      VALUES (?, ?, 'student', 'auto-class', 'Test job', ?, ?)`, [`auto-${i}`, `auto-${i}`, 40000 + i * 10000, now.toISOString()]);
  }
  const top = await life.spinLifeEvent({ classId: "auto-class", studentId: "auto-19", actorId: "teacher", now, drawIndex: 0 });
  assert.equal(top.key, "layoff");
  assert.equal(top.index, 9, "animation must land on a career twist rather than inheritance");
  assert.equal(top.newJobTitle, "Cashier at Arby's");
  assert.equal(top.newPayCents, 40000);
  assert.equal((await db.q(`SELECT id FROM income_postings WHERE user_id = 'auto-19'`)).length, 0);
  const next = await life.spinLifeEvent({ classId: "auto-class", studentId: "auto-18", actorId: "teacher", now, drawIndex: 0 });
  assert.equal(next.key, "inheritance", "earlier layoffs must not move another student into the top bracket");
  const repeat = await life.spinLifeEvent({ classId: "auto-class", studentId: "auto-19", actorId: "teacher", now, drawIndex: 4 });
  assert.equal(repeat.id, top.id);
  assert.equal(repeat.newJobTitle, "Cashier at Arby's");
});

test("credit-card spin creates one $750 claim and wages repay it exactly once", async () => {
  const bank = await import("./bank.js");
  await db.run(`INSERT INTO users (id, name, role, class_id, job_title, job_pay_cents, created_at) VALUES ('claim-student', 'Claim Student', 'student', 'wheel-class', 'Electrician', 85000, ?)`, [now.toISOString()]);
  const event = await life.spinLifeEvent({ classId: "wheel-class", studentId: "claim-student", actorId: "teacher", now, drawIndex: 10 });
  assert.equal(event.key, "credit_card_garnishment");
  assert.equal(event.index, 10);
  assert.equal((await (await import("./student-admin.js")).deletionStatus("claim-student")).canDelete, false);
  // Recovery of a pending event must not create another claim.
  await db.run(`UPDATE life_events SET status = 'pending' WHERE id = ?`, [event.id]);
  await life.spinLifeEvent({ classId: "wheel-class", studentId: "claim-student", actorId: "teacher", now });
  assert.equal((await bank.bankSummaryFor("claim-student")).garnishments.length, 1);
  const pay = (batchId: string, amountCents: number, isPaycheck = true) => bank.issueIncomeBatch({ actorId: "teacher", batchId, isPaycheck, items: [{ userId: "claim-student", label: "Pay", amountCents }] });
  const first = await pay("claim-pay-1", 30000);
  assert.equal(first.withheldCents, 30000); assert.equal(first.depositedCents, 0);
  assert.equal((await bank.bankSummaryFor("claim-student")).garnishments[0].remainingCents, 45000);
  assert.equal((await pay("claim-pay-1", 30000)).posted, 0);
  assert.equal((await bank.bankSummaryFor("claim-student")).garnishments[0].remainingCents, 45000);
  await assert.rejects(() => pay("claim-pay-1", 30000, false), /withholding setting/);
  const bonus = await pay("claim-bonus", 10000, false);
  assert.equal(bonus.withheldCents, 0);
  assert.equal((await bank.bankSummaryFor("claim-student")).garnishments[0].remainingCents, 45000);
  await bank.postIncome({ userId: "claim-student", actorId: "teacher", label: "Inheritance", amountCents: 5000, idempotencyKey: "claim-gift" });
  assert.equal((await bank.bankSummaryFor("claim-student")).garnishments[0].remainingCents, 45000);
  const final = await pay("claim-pay-2", 60000);
  assert.equal(final.withheldCents, 45000); assert.equal(final.depositedCents, 15000);
  const settled = await bank.bankSummaryFor("claim-student");
  assert.equal(settled.garnishments[0].remainingCents, 0);
  assert.equal(settled.garnishments[0].paidCents, 75000);
  assert.equal(settled.checkingCents, 30000);
  const ordinary = await pay("claim-pay-3", 30000);
  assert.equal(ordinary.withheldCents, 0); assert.equal(ordinary.depositedCents, 30000);
  assert.equal((await bank.checkBankInvariant("claim-student")).ok, true);
  assert.equal((await db.q(`SELECT id FROM bank_journal WHERE kind = 'wage_garnishment' AND related_id = ?`, [settled.garnishments[0].id])).length, 2);
});

test("concurrent wages cannot overpay a claim, and batch failures roll back its repayments", async () => {
  const bank = await import("./bank.js");
  await db.run(`INSERT INTO users (id, name, role, class_id, job_title, job_pay_cents, created_at) VALUES ('atomic-claim', 'Atomic Claim', 'student', 'wheel-class', 'Electrician', 85000, ?)`, [now.toISOString()]);
  await bank.createWageClaim({ userId: "atomic-claim", sourceKey: "atomic-claim", title: "Credit card", amountCents: 75000 });
  await assert.rejects(() => bank.issueIncomeBatch({ actorId: "teacher", batchId: "rollback-claim", isPaycheck: true, items: [{ userId: "atomic-claim", label: "Pay", amountCents: 40000 }, { userId: "zz-missing-student", label: "Pay", amountCents: 40000 }] }), /not found/);
  assert.equal((await bank.bankSummaryFor("atomic-claim")).garnishments[0].paidCents, 0);
  const runs = await Promise.all(["atomic-1", "atomic-2"].map(batchId => bank.issueIncomeBatch({ actorId: "teacher", batchId, isPaycheck: true, items: [{ userId: "atomic-claim", label: "Pay", amountCents: 40000 }] })));
  assert.equal(runs.reduce((sum, r) => sum + r.withheldCents, 0), 75000);
  assert.equal((await bank.bankSummaryFor("atomic-claim")).checkingCents, 5000);
  assert.equal((await bank.checkBankInvariant("atomic-claim")).ok, true);
});
