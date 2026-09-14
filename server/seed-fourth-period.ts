/**
 * Seed the real fourth-period roster (brokerage accounts at $0).
 * Run: npm run seed:fourth
 *
 * Starting cash is NOT seeded here — the teacher enters each student's
 * approved self-reported investment amount through the teacher dashboard,
 * which records the required reason in the ledger.
 */
import "./env.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initSchema, ensureColumn, one, run, newId, nowIso } from "./db.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(fs.readFileSync(path.join(here, "seed-data", "fourth-period.json"), "utf8"));

await initSchema();
await ensureColumn("users", "job_title", "TEXT");
await ensureColumn("users", "job_pay_cents", "INTEGER");
await ensureColumn("users", "job_updated_at", "TEXT");
const now = nowIso();
const cls = data.class;
if (!(await one(`SELECT id FROM classes WHERE id = ?`, [cls.id]))) {
  await run(`INSERT INTO classes (id, name, join_code, trading_frozen, created_at) VALUES (?, ?, ?, 0, ?)`,
    [cls.id, cls.name, cls.joinCode, now]);
  console.log(`[seed] class "${cls.name}" join code ${cls.joinCode}`);
}
let added = 0;
for (const s of data.students) {
  if (!(await one(`SELECT id FROM users WHERE id = ?`, [s.id]))) {
    await run(`INSERT INTO users (id, email, name, role, class_id, job_title, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [s.id, null, s.name, "student", cls.id, s.job || null, now]);
    added++;
  } else if (s.job) {
    // Backfill jobs for rosters seeded before the job column existed.
    // Never overwrite a teacher-set job.
    await run(`UPDATE users SET job_title = ? WHERE id = ? AND role = 'student' AND (job_title IS NULL OR job_title = '')`,
      [s.job, s.id]);
  }
  if (!(await one(`SELECT id FROM accounts WHERE user_id = ?`, [s.id]))) {
    await run(`INSERT INTO accounts (id, user_id, cash_cents, created_at) VALUES (?, ?, 0, ?)`,
      [newId("acct"), s.id, now]);
  }
}
console.log(`[seed] fourth period: ${data.students.length} students on roster, ${added} new, all brokerage accounts $0.`);
console.log(`[seed] pending: ${(data.pending || []).join(" | ")}`);
process.exit(0);
