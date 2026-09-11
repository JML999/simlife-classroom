import "./env.js";
import os from "node:os";
import path from "node:path";
import { test, before } from "node:test";
import assert from "node:assert";

process.env["SIMLIFE_DB_PATH"] = path.join(os.tmpdir(), `simlife-admin-test-${process.pid}.db`);
delete process.env["SIMLIFE_DATABASE_URL"];

const { initSchema, run, one } = await import("./db.js");
const { adjustCash } = await import("./ledger.js");
const { deletionStatus, deleteEmptyStudent, StudentAdminError } = await import("./student-admin.js");

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

test("active student cannot be deleted", async () => {
  const id = await makeStudent("Active Student", "active@test.school");
  await adjustCash({ userId: id, actorId: TEACHER, amountCents: 10000, reason: "Starting brokerage cash", idempotencyKey: uid() });
  assert.equal((await deletionStatus(id)).canDelete, false);
  await assert.rejects(() => deleteEmptyStudent({ userId: id, confirmation: "Active Student" }), (e: any) => e instanceof StudentAdminError && e.code === "HAS_ACTIVITY");
  assert.ok(await one(`SELECT id FROM users WHERE id = ?`, [id]));
});
