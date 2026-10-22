import { randomInt } from "node:crypto";
import { q, withTx, newId, nowIso } from "./db.js";
import { BLACK_MONDAY_OPTIONS } from "../shared/education-paths.js";
import { LifeEventError } from "./life-events.js";
export async function blackMondayEvents(classId?: string, userId?: string) {
  const rows = await q<any>(`SELECT * FROM black_monday_events WHERE ${userId ? "user_id = ?" : "class_id = ?"} ORDER BY created_at DESC`, [userId || classId!]);
  return rows.map(row => ({ ...JSON.parse(row.payload), id: row.id, userId: row.user_id, date: row.event_date, createdAt: row.created_at, status: "applied" }));
}
export async function spinBlackMonday(opts: { classId: string; studentId: string; actorId: string; now?: Date; drawIndex?: number }) {
  const now = opts.now ?? new Date();
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  return withTx(async t => {
    const teacher = await t.one(`SELECT id FROM users WHERE id = ? AND role = 'teacher'`, [opts.actorId]);
    if (!teacher) throw new LifeEventError("NOT_FOUND", "Teacher access required.");
    const student = await t.one<any>(`SELECT * FROM users WHERE id = ? AND class_id = ? AND role = 'student'${t.dialect === "pg" ? " FOR UPDATE" : ""}`, [opts.studentId, opts.classId]);
    if (!student) throw new LifeEventError("NOT_FOUND", "Choose a student in the selected period.");
    const existing = await t.one<any>(`SELECT * FROM black_monday_events WHERE user_id = ? AND event_date = ?`, [opts.studentId, day]);
    if (existing) return { ...JSON.parse(existing.payload), id: existing.id, userId: student.id, date: day, createdAt: existing.created_at, status: "applied" };
    if (!student.job_title || !(Number(student.job_pay_cents) > 0)) throw new LifeEventError("NOT_READY", "Assign this student a job and paycheck before spinning.");
    const index = opts.drawIndex ?? randomInt(BLACK_MONDAY_OPTIONS.length);
    if (!Number.isInteger(index) || index < 0 || index >= BLACK_MONDAY_OPTIONS.length) throw new LifeEventError("INVALID_INPUT", "Invalid wheel result.");
    const option = BLACK_MONDAY_OPTIONS[index];
    const id = newId("black"), createdAt = now.toISOString();
    const payload = { ...option, index, previousJobTitle: student.job_title, previousPayCents: Number(student.job_pay_cents) };
    if (option.newJobTitle) await t.run(`UPDATE users SET job_title = ?, job_pay_cents = ?, job_updated_at = ? WHERE id = ?`, [option.newJobTitle, option.newPayCents, createdAt, student.id]);
    await t.run(`INSERT INTO black_monday_events (id,user_id,class_id,event_date,payload,actor_id,created_at) VALUES (?,?,?,?,?,?,?)`, [id,student.id,opts.classId,day,JSON.stringify(payload),opts.actorId,createdAt]);
    return { ...payload, id, userId: student.id, date: day, createdAt, status: "applied" };
  });
}
