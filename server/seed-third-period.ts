/**
 * Seed the real third-period roster (brokerage accounts at $0).
 * Run: npm run seed:third
 *
 * Starting cash is NOT seeded here — the teacher enters each student's
 * approved self-reported investment amount through the teacher dashboard,
 * which records the required reason in the ledger.
 */
import "./env.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initSchema, one, run, newId, nowIso } from "./db.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(fs.readFileSync(path.join(here, "seed-data", "third-period.json"), "utf8"));

await initSchema();
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
    await run(`INSERT INTO users (id, email, name, role, class_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [s.id, null, s.name, "student", cls.id, now]);
    added++;
  }
  if (!(await one(`SELECT id FROM accounts WHERE user_id = ?`, [s.id]))) {
    await run(`INSERT INTO accounts (id, user_id, cash_cents, created_at) VALUES (?, ?, 0, ?)`,
      [newId("acct"), s.id, now]);
  }
}
console.log(`[seed] third period: ${data.students.length} students on roster, ${added} new, all brokerage accounts $0.`);
console.log(`[seed] pending: ${(data.pending || []).join(" | ")}`);
process.exit(0);
