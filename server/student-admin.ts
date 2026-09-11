import { withTx, type Tx } from "./db.js";

export class StudentAdminError extends Error {
  constructor(public code: "NOT_FOUND" | "INVALID_INPUT" | "HAS_ACTIVITY", message: string) {
    super(message);
  }
}

async function student(t: Tx, id: string) {
  const fu = t.dialect === "pg" ? " FOR UPDATE" : "";
  return t.one<{ id: string; name: string; email: string | null; google_sub: string | null }>(
    `SELECT id, name, email, google_sub FROM users WHERE id = ? AND role = 'student'${fu}`, [id],
  );
}

async function activityCount(t: Tx, userId: string): Promise<number> {
  const row = await t.one<{ n: number }>(
    `SELECT
      (SELECT COUNT(*) FROM ledger l JOIN accounts a ON a.id = l.account_id WHERE a.user_id = ?) +
      (SELECT COUNT(*) FROM bank_journal j JOIN bank_accounts b ON b.id = j.bank_account_id WHERE b.user_id = ?) +
      (SELECT COUNT(*) FROM bills WHERE user_id = ?) +
      (SELECT COUNT(*) FROM bill_payments WHERE user_id = ?) +
      (SELECT COUNT(*) FROM bill_disputes WHERE user_id = ?) +
      (SELECT COUNT(*) FROM income_postings WHERE user_id = ?) +
      (SELECT COUNT(*) FROM student_account_merges WHERE target_user_id = ?) AS n`,
    [userId, userId, userId, userId, userId, userId, userId],
  );
  return Number(row?.n || 0);
}

export async function deletionStatus(userId: string) {
  return withTx(async (t) => {
    const u = await student(t, userId);
    if (!u) throw new StudentAdminError("NOT_FOUND", "Student not found.");
    const count = await activityCount(t, userId);
    return { canDelete: count === 0, activityCount: count };
  });
}

export async function deleteEmptyStudent(opts: { userId: string; confirmation: string }) {
  return withTx(async (t) => {
    const u = await student(t, opts.userId);
    if (!u) throw new StudentAdminError("NOT_FOUND", "Student not found.");
    if (opts.confirmation.trim() !== u.name) throw new StudentAdminError("INVALID_INPUT", `Type ${u.name} exactly to confirm deletion.`);
    const count = await activityCount(t, u.id);
    if (count) throw new StudentAdminError("HAS_ACTIVITY", "This account has financial history and cannot be deleted.");
    await t.run(`DELETE FROM users WHERE id = ?`, [u.id]);
    return { deleted: true, name: u.name };
  });
}
