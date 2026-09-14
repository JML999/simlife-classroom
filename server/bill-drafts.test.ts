import test, { before } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env["SIMLIFE_DB_PATH"] = path.join(os.tmpdir(), `simlife-bill-drafts-${process.pid}.db`);
process.env["SIMLIFE_DATABASE_URL"] = "";

const { initSchema, one, run } = await import("./db.js");
const { createBillDraft, listBillDrafts, sendBillDraft, updateBillDraft } = await import("./bill-drafts.js");

before(async () => {
  await initSchema();
  const now = new Date().toISOString();
  await run(`INSERT INTO classes (id, name, join_code, trading_frozen, created_at) VALUES ('draft-class', 'Draft Class', 'DRAFT1', 0, ?)`, [now]);
  await run(`INSERT INTO users (id, name, role, class_id, created_at) VALUES ('draft-teacher', 'Teacher', 'teacher', NULL, ?)`, [now]);
  await run(`INSERT INTO users (id, name, role, class_id, created_at) VALUES ('draft-student', 'Student One', 'student', 'draft-class', ?)`, [now]);
});

test("teacher can prepare, edit, and idempotently send a student bill draft", async () => {
  const created: any = await createBillDraft({
    studentId: "draft-student", classId: "draft-class", title: "Rent", amountCents: 80000,
    dueAt: "2026-09-21T12:00:00Z", sender: "SimLife Housing", createdBy: "draft-teacher", sourceKey: "rent:one",
  });
  const duplicate: any = await createBillDraft({
    studentId: "draft-student", classId: "draft-class", title: "Rent", amountCents: 80000,
    dueAt: "2026-09-21T12:00:00Z", createdBy: "draft-teacher", sourceKey: "rent:one",
  });
  assert.equal(duplicate.deduped, true);
  assert.equal((await listBillDrafts("draft-class")).length, 1);

  await updateBillDraft(created.draft.id, {
    studentId: "draft-student", classId: "draft-class", title: "Monthly rent", amountCents: 82500,
    dueAt: "2026-09-22T12:00:00Z", sender: "SimLife Housing", actorId: "draft-teacher",
  });
  const sent: any = await sendBillDraft(created.draft.id, "draft-teacher");
  assert.equal(sent.deduped, false);
  assert.equal((await sendBillDraft(created.draft.id, "draft-teacher") as any).deduped, true);
  const bill = await one<any>(`SELECT * FROM bills WHERE id = ?`, [sent.billId]);
  assert.equal(bill.title, "Monthly rent");
  assert.equal(Number(bill.amount_cents), 82500);
  assert.equal((await listBillDrafts("draft-class"))[0].status, "sent");
});
