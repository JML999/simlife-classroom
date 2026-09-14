import "../server/env.js";
import { db, initSchema, one, q } from "../server/db.js";
import { createBillDraft } from "../server/bill-drafts.js";
import { normalizeStudentName } from "../server/onboarding.js";

const classId = "class-p3-2026";
const dueAt = "2026-09-21T12:00:00Z";
const apply = process.argv.includes("--apply");
const rents = [
  ["Aniya Bates", 829], ["Cameron Samuel", 900], ["Christopher Tims", 1000],
  ["Teonni Bethea", 1028], ["Lemariah Johnson", 522], ["Ty'Tiana Edwards", 325],
  ["Jeh'Niyah Wheeler", 750], ["Ja'Nya Randall", 325], ["Jeremiah Henry", 828],
  ["Lucas Barfield", 325], ["Jordin Hamm", 829], ["Zorriyah McCoy", 1000],
  ["Ma'Khia Banks", 726], ["Princess Blake", 800], ["Jayden Jones", 600],
] as const;

await initSchema();
const teacher = await one<any>(`SELECT id FROM users WHERE role = 'teacher' ORDER BY created_at LIMIT 1`);
if (!teacher) throw new Error("No teacher account found.");
const users = await q<any>(`SELECT id, name FROM users WHERE class_id = ? AND role = 'student' AND google_sub IS NOT NULL ORDER BY name`, [classId]);
const matched: Array<{ user: any; amount: number }> = [];
const unmatched: string[] = [];
for (const [name, amount] of rents) {
  const candidates = users.filter((u) => normalizeStudentName(u.name) === normalizeStudentName(name));
  if (candidates.length === 1) matched.push({ user: candidates[0], amount });
  else unmatched.push(`${name} (${candidates.length} matches)`);
}

console.log(`${apply ? "APPLY" : "DRY RUN"}: ${matched.length} matched; ${unmatched.length} unmatched`);
for (const row of matched) console.log(`${row.user.name}: $${row.amount.toFixed(2)}`);
if (unmatched.length) console.log(`UNMATCHED: ${unmatched.join(" | ")}`);

if (apply) {
  for (const row of matched) {
    await createBillDraft({
      classId, studentId: row.user.id, title: "Rent", amountCents: row.amount * 100,
      dueAt, sender: "SimLife Housing", documentTitle: "Monthly rent statement",
      documentBody: "Your monthly rent is due. Review the amount and pay this bill from checking by the due date.",
      createdBy: teacher.id, sourceKey: `p3-rent-2026-09:${normalizeStudentName(row.user.name)}`,
    });
  }
  console.log(`Verified ${(await q(`SELECT id FROM bill_drafts WHERE class_id = ? AND status = 'draft' AND source_key LIKE 'p3-rent-2026-09:%'`, [classId])).length} staged rent drafts.`);
}
await (await db()).close();
