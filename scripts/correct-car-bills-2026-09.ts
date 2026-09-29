/** One-time, guarded correction for 3rd Period car bills issued at rent amounts. */
import "../server/env.js";
import { newId, nowIso } from "../server/db.js";

if (process.argv.includes("--session-port")) {
  const url = new URL(process.env["SIMLIFE_DATABASE_URL"] || "");
  url.port = "5432";
  process.env["SIMLIFE_DATABASE_URL"] = url.toString();
}
const { q, withTx } = await import("../server/db.js");

const expectedIds = new Set([
  "bill_ZfxtP1qmFZOFJtg6", "bill_w4mNC3ead5efWuAC", "bill_MLONkDn2fk8zISGi",
  "bill_o-DbnhPfohXnHCqG", "bill_qn3VK2QBFTvUsyl2", "bill_uXOEDx-CAGvQtO18",
  "bill_S_oF8oTLnAmTHBr9", "bill_VPSTZbhOxd_uUa_o", "bill_cd280kLnQCmlBwLv",
  "bill_pO3mgodzbHak2EaE", "bill_0Rj0Fy27zIupkIUE", "bill_YKlRRopWmGPg6_Ws",
  "bill_52PCb2E-yXO1SzxQ", "bill_Qt2ZDpS716dX9pBL", "bill_oWF8yauAxM6hgJ75",
  "bill_IiqDG07Ygk5c-hkY", "bill_AshyySwtLvrB9Iyg", "bill_U1U-WGUyAPIV09d2",
]);

type Row = {
  id: string; user_id: string; name: string; class_id: string; title: string;
  amount_cents: number; car_payment_cents: number; rent_cents: number;
  paid_cents: number; paid_at: string | null; due_at: string; issued_at: string;
  issued_by: string | null;
};
const sql = `SELECT b.id, b.user_id, u.name, u.class_id, b.title, b.amount_cents,
    u.car_payment_cents, u.rent_cents, b.paid_cents, b.paid_at, b.due_at,
    b.issued_at, b.issued_by
  FROM bills b JOIN users u ON u.id = b.user_id
  WHERE u.role = 'student' AND u.class_id IN (?, ?)
    AND b.title = 'Car Payment' AND b.amount_cents <> u.car_payment_cents
  ORDER BY b.id`;
const params = ["class-p3-2026", "class-p4-2026"];
const rows = await q<Row>(sql, params);
if (rows.some((row) => !expectedIds.has(row.id) || row.class_id !== "class-p3-2026" ||
  Number(row.amount_cents) !== Number(row.rent_cents) || Number(row.car_payment_cents) <= 0 ||
  !row.issued_at.startsWith("2026-09-28") || !row.due_at.startsWith("2026-10-02"))) {
  throw new Error("Unexpected car-bill mismatch. Inspect it before applying corrections.");
}
if (rows.length !== 0 && rows.length !== expectedIds.size) {
  throw new Error(`Expected ${expectedIds.size} mismatches or none; found ${rows.length}. Stop for review.`);
}
const refundTotal = rows.reduce((sum, row) => sum + Math.max(0, Number(row.paid_cents) - Number(row.car_payment_cents)), 0);
console.log(JSON.stringify({ billsToCorrect: rows.length, refundsCents: refundTotal,
  rows: rows.map((row) => ({ name: row.name, oldCents: row.amount_cents,
    newCents: row.car_payment_cents, paidCents: row.paid_cents,
    refundCents: Math.max(0, Number(row.paid_cents) - Number(row.car_payment_cents)) })) }, null, 2));

if (process.argv.includes("--apply") && rows.length) {
  await withTx(async (tx) => {
    for (const row of rows) {
      const bill = await tx.one<Row>(`SELECT b.id, b.user_id, u.name, u.class_id, b.title,
          b.amount_cents, u.car_payment_cents, u.rent_cents, b.paid_cents, b.paid_at,
          b.due_at, b.issued_at, b.issued_by
        FROM bills b JOIN users u ON u.id = b.user_id WHERE b.id = ? FOR UPDATE OF b`, [row.id]);
      if (!bill || bill.user_id !== row.user_id || Number(bill.amount_cents) !== Number(row.amount_cents) ||
        Number(bill.paid_cents) !== Number(row.paid_cents) || Number(bill.car_payment_cents) !== Number(row.car_payment_cents)) {
        throw new Error(`Bill changed during correction: ${row.id}`);
      }
      const paidSum = await tx.one<{ cents: number }>(
        `SELECT COALESCE(SUM(amount_cents), 0) AS cents FROM bill_payments WHERE bill_id = ?`, [row.id]);
      if (Number(paidSum?.cents) !== Number(row.paid_cents)) throw new Error(`Payment history mismatch: ${row.id}`);
      const target = Number(row.car_payment_cents);
      const refund = Math.max(0, Number(row.paid_cents) - target);
      const netPaid = Number(row.paid_cents) - refund;
      if (refund) {
        const acct = await tx.one<{ id: string; checking_cents: number; savings_cents: number }>(
          `SELECT id, checking_cents, savings_cents FROM bank_accounts WHERE user_id = ? FOR UPDATE`, [row.user_id]);
        if (!acct) throw new Error(`Missing bank account: ${row.user_id}`);
        const sum = await tx.one<{ checking: number; savings: number }>(
          `SELECT COALESCE(SUM(checking_leg), 0) AS checking, COALESCE(SUM(savings_leg), 0) AS savings
            FROM bank_journal WHERE bank_account_id = ?`, [acct.id]);
        if (Number(sum?.checking) !== Number(acct.checking_cents) ||
            Number(sum?.savings) !== Number(acct.savings_cents)) throw new Error(`Bank invariant failed: ${row.user_id}`);
        const journalId = newId("bj");
        const key = `car-bill-correction-2026-09:${row.id}`;
        await tx.run(`INSERT INTO bank_journal
          (id, bank_account_id, kind, checking_leg, savings_leg, memo, actor_id, idempotency_key, related_id, created_at)
          VALUES (?, ?, 'bank_adjustment', ?, 0, ?, ?, ?, ?, ?)`,
          [journalId, acct.id, refund, "Refund: car payment bill used rent amount", row.issued_by, key, row.id, nowIso()]);
        await tx.run(`UPDATE bank_accounts SET checking_cents = ? WHERE id = ?`,
          [Number(acct.checking_cents) + refund, acct.id]);
        await tx.run(`INSERT INTO bill_payments
          (id, bill_id, user_id, amount_cents, journal_id, idempotency_key, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [newId("bp"), row.id, row.user_id, -refund, journalId, key, nowIso()]);
      }
      await tx.run(`UPDATE bills SET amount_cents = ?, paid_cents = ?, paid_at = ? WHERE id = ?`,
        [target, netPaid, netPaid >= target ? (row.paid_at || nowIso()) : null, row.id]);
      await tx.run(`UPDATE bill_drafts SET amount_cents = ?, updated_at = ? WHERE bill_id = ?`,
        [target, nowIso(), row.id]);
    }
  });
  console.log(`Applied ${rows.length} car-bill corrections and refunded ${refundTotal} cents.`);
}
process.exit(0);
