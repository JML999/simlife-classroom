import { withTx, newId, nowIso, type Tx } from "./db.js";

export class StudentAdminError extends Error {
  constructor(public code: "NOT_FOUND" | "INVALID_INPUT" | "HAS_ACTIVITY" | "CONFLICT", message: string) {
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
    if (count) throw new StudentAdminError("HAS_ACTIVITY", "This account has financial history and cannot be deleted. Merge it into the correct account instead.");
    await t.run(`DELETE FROM users WHERE id = ?`, [u.id]);
    return { deleted: true, name: u.name };
  });
}

async function addAlias(t: Tx, userId: string, email: string | null, googleSub: string | null) {
  if (!email && !googleSub) return;
  await t.run(
    `INSERT INTO user_aliases (id, user_id, email, google_sub, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    [newId("alias"), userId, email, googleSub, nowIso()],
  );
}

/** Merge source into target without deleting any financial rows. Cached
 * balances are summed, and every journal/ledger row is re-parented. */
export async function mergeStudents(opts: { targetUserId: string; sourceUserId: string; actorId: string; reason: string; confirmation: string }) {
  if (!opts.targetUserId || !opts.sourceUserId || opts.targetUserId === opts.sourceUserId) throw new StudentAdminError("INVALID_INPUT", "Choose two different student accounts.");
  const reason = opts.reason.trim();
  if (reason.length < 3 || reason.length > 200) throw new StudentAdminError("INVALID_INPUT", "Give a reason for the merge (3–200 characters).");
  if (opts.confirmation !== "MERGE") throw new StudentAdminError("INVALID_INPUT", "Type MERGE to confirm.");
  return withTx(async (t) => {
    // Deterministic lock order avoids two simultaneous opposite merges deadlocking.
    const ids = [opts.targetUserId, opts.sourceUserId].sort();
    const locked = new Map<string, Awaited<ReturnType<typeof student>>>();
    for (const id of ids) locked.set(id, await student(t, id));
    const target = locked.get(opts.targetUserId);
    const source = locked.get(opts.sourceUserId);
    if (!target || !source) throw new StudentAdminError("NOT_FOUND", "One of those student accounts no longer exists.");

    const fu = t.dialect === "pg" ? " FOR UPDATE" : "";
    const targetBroker = await t.one<any>(`SELECT * FROM accounts WHERE user_id = ?${fu}`, [target.id]);
    const sourceBroker = await t.one<any>(`SELECT * FROM accounts WHERE user_id = ?${fu}`, [source.id]);
    if (sourceBroker && targetBroker) {
      await t.run(`UPDATE ledger SET account_id = ? WHERE account_id = ?`, [targetBroker.id, sourceBroker.id]);
      await t.run(`UPDATE accounts SET cash_cents = ? WHERE id = ?`, [Number(targetBroker.cash_cents) + Number(sourceBroker.cash_cents), targetBroker.id]);
      await t.run(`DELETE FROM accounts WHERE id = ?`, [sourceBroker.id]);
    } else if (sourceBroker) {
      await t.run(`UPDATE accounts SET user_id = ? WHERE id = ?`, [target.id, sourceBroker.id]);
    }

    const targetBank = await t.one<any>(`SELECT * FROM bank_accounts WHERE user_id = ?${fu}`, [target.id]);
    const sourceBank = await t.one<any>(`SELECT * FROM bank_accounts WHERE user_id = ?${fu}`, [source.id]);
    if (sourceBank && targetBank) {
      await t.run(`UPDATE bank_journal SET bank_account_id = ? WHERE bank_account_id = ?`, [targetBank.id, sourceBank.id]);
      await t.run(
        `UPDATE bank_accounts SET checking_cents = ?, savings_cents = ?, interest_residual_micros = ?, interest_accrued_at = ? WHERE id = ?`,
        [Number(targetBank.checking_cents) + Number(sourceBank.checking_cents), Number(targetBank.savings_cents) + Number(sourceBank.savings_cents), Number(targetBank.interest_residual_micros || 0) + Number(sourceBank.interest_residual_micros || 0), nowIso(), targetBank.id],
      );
      await t.run(`DELETE FROM bank_accounts WHERE id = ?`, [sourceBank.id]);
    } else if (sourceBank) {
      await t.run(`UPDATE bank_accounts SET user_id = ? WHERE id = ?`, [target.id, sourceBank.id]);
    }

    await t.run(`UPDATE bills SET user_id = ? WHERE user_id = ?`, [target.id, source.id]);
    await t.run(`UPDATE bill_payments SET user_id = ? WHERE user_id = ?`, [target.id, source.id]);
    await t.run(`UPDATE bill_disputes SET user_id = ? WHERE user_id = ?`, [target.id, source.id]);
    await t.run(`UPDATE income_postings SET user_id = ? WHERE user_id = ?`, [target.id, source.id]);
    await t.run(`UPDATE user_aliases SET user_id = ? WHERE user_id = ?`, [target.id, source.id]);
    await addAlias(t, target.id, source.email, source.google_sub);
    await t.run(
      `INSERT INTO student_account_merges (id, target_user_id, source_user_id, source_email, source_name, actor_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId("merge"), target.id, source.id, source.email, source.name, opts.actorId, reason, nowIso()],
    );
    await t.run(`DELETE FROM users WHERE id = ?`, [source.id]);
    return { merged: true, targetUserId: target.id, sourceName: source.name };
  });
}
