import "./env.js";
import os from "node:os";
import path from "node:path";
import { test, before } from "node:test";
import assert from "node:assert";

process.env["SIMLIFE_DB_PATH"] = path.join(os.tmpdir(), `simlife-onboarding-test-${process.pid}.db`);
delete process.env["SIMLIFE_DATABASE_URL"];

const { initSchema, run, one } = await import("./db.js");
const { importRosterProfiles, onboardingStatus, claimRosterProfile, approveRosterProfile, assignRosterProfile, applyRosterProfile } = await import("./onboarding.js");

before(async () => {
  await initSchema();
  await run(`INSERT INTO classes (id, name, join_code, trading_frozen, created_at) VALUES ('onboard-class', 'Onboarding', 'ONBOARD', 0, ?)`, [new Date().toISOString()]);
  await run(`INSERT INTO users (id, email, name, role, class_id, created_at) VALUES ('onboard-teacher', 'teacher@example.com', 'Teacher', 'teacher', NULL, ?)`, [new Date().toISOString()]);
});

test("unique name + class match is non-financial until opening money is applied", async () => {
  await run(`INSERT INTO users (id, email, name, role, class_id, created_at) VALUES ('onboard-student-1', 'one@example.com', 'Jordan O’Lee', 'student', 'onboard-class', ?)`, [new Date().toISOString()]);
  await importRosterProfiles({ classId: "onboard-class", actorId: "onboard-teacher", sourceLabel: "Test import", importKey: "import-one", rows: [{ fullName: "Jordan O'Lee", jobTitle: "Electrician", jobPayCents: 85000, checkingCents: 120000, savingsCents: 30000, brokerageCents: 50000, carPaymentCents: 27500 }] });
  const status: any = await onboardingStatus("onboard-student-1");
  assert.equal(status.state, "match");
  const claimed: any = await claimRosterProfile({ userId: "onboard-student-1", profileId: status.candidates[0].id });
  assert.equal(claimed.state, "matched");
  assert.equal(await one(`SELECT id FROM bank_accounts WHERE user_id = 'onboard-student-1'`), undefined, "matching alone does not move money");
  await applyRosterProfile({ profileId: status.candidates[0].id, actorId: "onboard-teacher" });
  const bank = await one<any>(`SELECT checking_cents, savings_cents FROM bank_accounts WHERE user_id = 'onboard-student-1'`);
  assert.deepEqual([Number(bank?.checking_cents), Number(bank?.savings_cents)], [120000, 30000]);
  const bankSum = await one<any>(`SELECT SUM(checking_leg) AS checking, SUM(savings_leg) AS savings FROM bank_journal j JOIN bank_accounts b ON b.id = j.bank_account_id WHERE b.user_id = 'onboard-student-1'`);
  assert.deepEqual([Number(bankSum?.checking), Number(bankSum?.savings)], [120000, 30000]);
  const brokerage = await one<any>(`SELECT cash_cents FROM accounts WHERE user_id = 'onboard-student-1'`);
  const ledger = await one<any>(`SELECT SUM(amount_cents) AS total FROM ledger l JOIN accounts a ON a.id = l.account_id WHERE a.user_id = 'onboard-student-1'`);
  assert.equal(Number(brokerage?.cash_cents), 50000);
  assert.equal(Number(ledger?.total), 50000);
  const user = await one<any>(`SELECT job_title, job_pay_cents, car_payment_cents FROM users WHERE id = 'onboard-student-1'`);
  assert.deepEqual([user?.job_title, Number(user?.job_pay_cents), Number(user?.car_payment_cents)], ["Electrician", 85000, 27500]);
  const retry: any = await claimRosterProfile({ userId: "onboard-student-1", profileId: status.candidates[0].id });
  assert.equal(retry.deduped, true);
});

test("student-proposed corrections wait for teacher approval", async () => {
  await run(`INSERT INTO users (id, email, name, role, class_id, created_at) VALUES ('onboard-student-2', 'two@example.com', 'Taylor Smith', 'student', 'onboard-class', ?)`, [new Date().toISOString()]);
  await importRosterProfiles({ classId: "onboard-class", actorId: "onboard-teacher", sourceLabel: "Test import", importKey: "import-two", rows: [{ fullName: "Taylor Smith", jobTitle: "Driver", checkingCents: 10000 }] });
  const status: any = await onboardingStatus("onboard-student-2");
  await claimRosterProfile({ userId: "onboard-student-2", profileId: status.candidates[0].id, proposed: { fullName: "Taylor Smith", jobTitle: "Truck Driver", checkingCents: 12500 } });
  assert.equal((await onboardingStatus("onboard-student-2") as any).state, "pending");
  assert.equal(await one(`SELECT id FROM bank_accounts WHERE user_id = 'onboard-student-2'`), undefined);
  await approveRosterProfile({ profileId: status.candidates[0].id, actorId: "onboard-teacher" });
  assert.equal((await onboardingStatus("onboard-student-2") as any).state, "matched");
  assert.equal(await one(`SELECT id FROM bank_accounts WHERE user_id = 'onboard-student-2'`), undefined);
  await applyRosterProfile({ profileId: status.candidates[0].id, actorId: "onboard-teacher" });
  assert.equal(Number((await one<any>(`SELECT checking_cents FROM bank_accounts WHERE user_id = 'onboard-student-2'`))?.checking_cents), 12500);
  assert.equal((await one<any>(`SELECT job_title FROM users WHERE id = 'onboard-student-2'`))?.job_title, "Truck Driver");
});

test("same-name duplicates are ambiguous and are never auto-selected", async () => {
  await run(`INSERT INTO users (id, email, name, role, class_id, created_at) VALUES ('onboard-student-3', 'three@example.com', 'Alex Lee', 'student', 'onboard-class', ?)`, [new Date().toISOString()]);
  await importRosterProfiles({ classId: "onboard-class", actorId: "onboard-teacher", sourceLabel: "Duplicates", importKey: "import-three", rows: [{ fullName: "Alex Lee" }, { fullName: "Alex Lee", externalRef: "other" }] });
  assert.equal((await onboardingStatus("onboard-student-3") as any).state, "ambiguous");
});

test("re-pasting identical import content is idempotent across browser keys", async () => {
  const rows = [{ fullName: "Repeat Student", jobTitle: "Cashier", checkingCents: 2500 }];
  const first = await importRosterProfiles({ classId: "onboard-class", actorId: "onboard-teacher", sourceLabel: "Repeat source", importKey: "browser-key-one", rows });
  const second = await importRosterProfiles({ classId: "onboard-class", actorId: "onboard-teacher", sourceLabel: "Repeat source", importKey: "browser-key-two", rows });
  assert.equal(first.deduped, false);
  assert.equal(second.deduped, true);
  assert.equal(first.importId, second.importId);
});

test("teacher can resolve a name mismatch only within the same class", async () => {
  await run(`INSERT INTO users (id, email, name, role, class_id, created_at) VALUES ('onboard-student-4', 'four@example.com', 'Sam Nickname', 'student', 'onboard-class', ?)`, [new Date().toISOString()]);
  await importRosterProfiles({ classId: "onboard-class", actorId: "onboard-teacher", sourceLabel: "Mismatch", importKey: "mismatch", rows: [{ fullName: "Samuel Legalname", savingsCents: 9900 }] });
  const profile = await one<any>(`SELECT id FROM roster_profiles WHERE full_name = 'Samuel Legalname'`);
  await assignRosterProfile({ profileId: profile.id, userId: "onboard-student-4", actorId: "onboard-teacher" });
  assert.equal(await one(`SELECT id FROM bank_accounts WHERE user_id = 'onboard-student-4'`), undefined);
  await applyRosterProfile({ profileId: profile.id, actorId: "onboard-teacher" });
  assert.equal(Number((await one<any>(`SELECT savings_cents FROM bank_accounts WHERE user_id = 'onboard-student-4'`))?.savings_cents), 9900);
});
