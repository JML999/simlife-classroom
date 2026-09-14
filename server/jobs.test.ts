import "./env.js";
import os from "node:os";
import path from "node:path";
import { test, before } from "node:test";
import assert from "node:assert";

process.env["SIMLIFE_DB_PATH"] = path.join(os.tmpdir(), `simlife-jobs-test-${process.pid}.db`);
delete process.env["SIMLIFE_DATABASE_URL"];

const { initSchema, ensureColumn, run, one } = await import("./db.js");

before(async () => {
  await initSchema();
  await ensureColumn("users", "job_title", "TEXT");
  await ensureColumn("users", "job_pay_cents", "INTEGER");
  await ensureColumn("users", "job_updated_at", "TEXT");
});

test("student job title + pay can be set and cleared", async () => {
  const id = `t_job_${process.pid}_1`;
  await run(`INSERT INTO users (id, email, name, role, class_id, created_at) VALUES (?, ?, ?, 'student', ?, ?)`,
    [id, `${id}@example.school`, "Job Stu", "class-p3-2026", new Date().toISOString()]);
  let u = await one<{ job_title: string | null; job_pay_cents: number | null }>(
    `SELECT job_title, job_pay_cents FROM users WHERE id = ?`, [id]);
  assert.equal(u?.job_title, null); // fresh row has no job yet
  assert.equal(u?.job_pay_cents, null);
  await run(`UPDATE users SET job_title = ?, job_pay_cents = ?, job_updated_at = ? WHERE id = ?`,
    ["Electrician", 85000, new Date().toISOString(), id]);
  u = await one(`SELECT job_title, job_pay_cents FROM users WHERE id = ?`, [id]);
  assert.equal(u?.job_title, "Electrician");
  assert.equal(Number(u?.job_pay_cents), 85000);
  await run(`UPDATE users SET job_title = ?, job_pay_cents = ? WHERE id = ?`, [null, null, id]);
  u = await one(`SELECT job_title, job_pay_cents FROM users WHERE id = ?`, [id]);
  assert.equal(u?.job_title, null);
  assert.equal(u?.job_pay_cents, null);
});

test("seed backfill never overwrites a teacher-set job", async () => {
  const id = `t_job_${process.pid}_2`;
  await run(`INSERT INTO users (id, email, name, role, class_id, job_title, created_at) VALUES (?, ?, ?, 'student', ?, ?, ?)`,
    [id, `${id}@example.school`, "Custom Stu", "class-p3-2026", "Custom Title", new Date().toISOString()]);
  await run(`UPDATE users SET job_title = ? WHERE id = ? AND (job_title IS NULL OR job_title = '')`,
    ["Snapshot Title", id]);
  const u = await one<{ job_title: string }>(`SELECT job_title FROM users WHERE id = ?`, [id]);
  assert.equal(u?.job_title, "Custom Title");
});
