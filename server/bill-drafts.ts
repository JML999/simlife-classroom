import { newId, nowIso, withTx } from "./db.js";
import { BankError, issueBillInTx } from "./bank.js";

type DraftInput = {
  studentId: string;
  classId: string;
  title: string;
  amountCents: number;
  dueAt: string;
  sender?: string | null;
  lateFeeCents?: number;
  documentTitle?: string | null;
  documentBody?: string | null;
};

function clean(input: DraftInput) {
  const title = String(input.title || "").trim();
  const amountCents = Number(input.amountCents);
  const lateFeeCents = Number(input.lateFeeCents || 0);
  const due = new Date(input.dueAt);
  if (title.length < 2 || title.length > 120) throw new BankError("INVALID_INPUT", "Bill title must be 2–120 characters.");
  if (!Number.isInteger(amountCents) || amountCents <= 0 || amountCents > 10_000_000) throw new BankError("INVALID_AMOUNT", "Bill amount must be between $0.01 and $100,000.");
  if (!Number.isInteger(lateFeeCents) || lateFeeCents < 0 || lateFeeCents > 1_000_000) throw new BankError("INVALID_AMOUNT", "Late fee must be $0–$10,000.");
  if (isNaN(due.getTime())) throw new BankError("INVALID_INPUT", "Pick a valid due date.");
  return {
    title, amountCents, lateFeeCents, dueAt: due.toISOString(),
    sender: String(input.sender || "").trim().slice(0, 120) || null,
    documentTitle: String(input.documentTitle || "").trim().slice(0, 160) || null,
    documentBody: String(input.documentBody || "").trim().slice(0, 8000) || null,
  };
}

export async function listBillDrafts(classId: string) {
  if (!classId) return [];
  return withTx((t) => t.q<any>(
    `SELECT d.*, u.name AS student_name
     FROM bill_drafts d JOIN users u ON u.id = d.user_id
     WHERE d.class_id = ? ORDER BY CASE d.status WHEN 'draft' THEN 0 ELSE 1 END, u.name, d.created_at`,
    [classId],
  ));
}

export async function createBillDraft(input: DraftInput & { createdBy: string; sourceKey?: string | null }) {
  const values = clean(input);
  return withTx(async (t) => {
    const student = await t.one<any>(`SELECT id FROM users WHERE id = ? AND class_id = ? AND role = 'student'`, [input.studentId, input.classId]);
    if (!student) throw new BankError("NOT_FOUND", "Student is not in that class.");
    if (input.sourceKey) {
      const existing = await t.one<any>(`SELECT * FROM bill_drafts WHERE source_key = ?`, [input.sourceKey]);
      if (existing) return { draft: existing, deduped: true };
    }
    const id = newId("bd");
    const now = nowIso();
    await t.run(
      `INSERT INTO bill_drafts (id, class_id, user_id, title, amount_cents, late_fee_cents, due_at, sender, document_title, document_body, status, source_key, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
      [id, input.classId, input.studentId, values.title, values.amountCents, values.lateFeeCents, values.dueAt, values.sender, values.documentTitle, values.documentBody, input.sourceKey || null, input.createdBy, now, now],
    );
    return { draft: await t.one<any>(`SELECT * FROM bill_drafts WHERE id = ?`, [id]), deduped: false };
  });
}

export async function updateBillDraft(id: string, input: DraftInput & { actorId: string }) {
  const values = clean(input);
  return withTx(async (t) => {
    const draft = await t.one<any>(`SELECT * FROM bill_drafts WHERE id = ?`, [id]);
    if (!draft) throw new BankError("NOT_FOUND", "Bill draft not found.");
    if (draft.status !== "draft") throw new BankError("INVALID_INPUT", "A sent bill can no longer be edited.");
    const student = await t.one<any>(`SELECT id FROM users WHERE id = ? AND class_id = ? AND role = 'student'`, [input.studentId, input.classId]);
    if (!student) throw new BankError("NOT_FOUND", "Student is not in that class.");
    await t.run(
      `UPDATE bill_drafts SET class_id = ?, user_id = ?, title = ?, amount_cents = ?, late_fee_cents = ?, due_at = ?, sender = ?, document_title = ?, document_body = ?, updated_at = ? WHERE id = ?`,
      [input.classId, input.studentId, values.title, values.amountCents, values.lateFeeCents, values.dueAt, values.sender, values.documentTitle, values.documentBody, nowIso(), id],
    );
    return { draft: await t.one<any>(`SELECT * FROM bill_drafts WHERE id = ?`, [id]) };
  });
}

export async function sendBillDraft(id: string, actorId: string) {
  return withTx(async (t) => {
    const fu = t.dialect === "pg" ? " FOR UPDATE" : "";
    const draft = await t.one<any>(`SELECT * FROM bill_drafts WHERE id = ?${fu}`, [id]);
    if (!draft) throw new BankError("NOT_FOUND", "Bill draft not found.");
    if (draft.status === "sent") return { billId: draft.bill_id, deduped: true };
    if (draft.status !== "draft") throw new BankError("INVALID_INPUT", "This draft cannot be sent.");
    const bill = await issueBillInTx(t, {
      userId: draft.user_id, title: draft.title, amountCents: Number(draft.amount_cents),
      lateFeeCents: Number(draft.late_fee_cents), dueAt: draft.due_at,
      issuedBy: actorId, idempotencyKey: `bill-draft:${draft.id}`, sender: draft.sender,
      documentTitle: draft.document_title, documentBody: draft.document_body,
    });
    await t.run(`UPDATE bill_drafts SET status = 'sent', bill_id = ?, sent_at = ?, updated_at = ? WHERE id = ?`, [bill.id, nowIso(), nowIso(), id]);
    return { billId: bill.id, deduped: false };
  });
}
