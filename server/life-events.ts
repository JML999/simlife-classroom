/** Teacher-run classroom wheel. Every result changes a real SimLife record. */
import { randomInt } from "node:crypto";
import { newId, nowIso, one, q, run, withTx } from "./db.js";
import { issueBillBatch, postIncome } from "./bank.js";

export class LifeEventError extends Error {
  code: "INVALID_INPUT" | "NOT_FOUND" | "NOT_READY";
  constructor(code: LifeEventError["code"], message: string) { super(message); this.code = code; }
}

export const LIFE_EVENT_OPTIONS = [
  { key: "inheritance", title: "Small inheritance", type: "deposit", amountCents: 20000, description: "$200 arrives in checking." },
  { key: "tax_refund", title: "Tax refund", type: "deposit", amountCents: 10000, description: "$100 arrives in checking." },
  { key: "side_gig", title: "Weekend side gig", type: "deposit", amountCents: 7500, description: "$75 arrives in checking." },
  { key: "rebate", title: "Unexpected rebate", type: "deposit", amountCents: 5000, description: "$50 arrives in checking." },
  { key: "flat_tire", title: "Flat tire", type: "bill", amountCents: 6000, description: "A $60 repair bill arrives, due in 7 days." },
  { key: "phone_repair", title: "Phone repair", type: "bill", amountCents: 9000, description: "A $90 repair bill arrives, due in 7 days." },
  { key: "urgent_care", title: "Urgent care copay", type: "bill", amountCents: 7500, description: "A $75 copay bill arrives, due in 7 days." },
  { key: "parking_ticket", title: "Parking ticket", type: "bill", amountCents: 4000, description: "A $40 ticket arrives, due in 7 days." },
  { key: "promotion", title: "Promotion", type: "job", amountCents: 0, description: "Your next paychecks increase by 10%." },
  { key: "layoff", title: "Laid off, then rehired", type: "job", amountCents: 0, description: "Your new job is Cashier at Arby's. Future paychecks are smaller." },
] as const;

type EventRow = { id: string; user_id: string; class_id: string; event_date: string; event_key: string; payload: string; status: string; created_at: string; applied_at: string | null };

function classDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function publicEvent(row: EventRow) {
  const option = LIFE_EVENT_OPTIONS.find((item) => item.key === row.event_key)!;
  const payload = JSON.parse(row.payload);
  return { id: row.id, userId: row.user_id, classId: row.class_id, date: row.event_date,
    index: LIFE_EVENT_OPTIONS.findIndex((item) => item.key === row.event_key), key: row.event_key,
    title: option.title, description: option.description, type: option.type,
    amountCents: option.amountCents, newJobTitle: payload.newJobTitle ?? null,
    newPayCents: payload.newPayCents ?? null, status: row.status, createdAt: row.created_at, appliedAt: row.applied_at };
}

async function applyEvent(row: EventRow, actorId: string): Promise<void> {
  if (row.status === "applied") return;
  const option = LIFE_EVENT_OPTIONS.find((item) => item.key === row.event_key)!;
  if (option.type === "deposit") {
    await postIncome({ userId: row.user_id, actorId, label: `Life event: ${option.title}`,
      amountCents: option.amountCents, idempotencyKey: `life:${row.id}` });
  } else if (option.type === "bill") {
    await issueBillBatch({ issuedBy: actorId, batchId: `life:${row.id}`,
      items: [{ userId: row.user_id, title: option.title, amountCents: option.amountCents,
        dueAt: new Date(new Date(row.created_at).getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        sender: "SimLife", documentTitle: option.title,
        documentBody: `Life event: ${option.title}. ${option.description} Pay this bill from checking by the due date.` }] });
  } else {
    const payload = JSON.parse(row.payload);
    // Absolute saved values make a retry safe if the first response is lost.
    await run(`UPDATE users SET job_title = ?, job_pay_cents = ?, job_updated_at = ? WHERE id = ?`,
      [payload.newJobTitle, payload.newPayCents, row.created_at, row.user_id]);
  }
  await run(`UPDATE life_events SET status = 'applied', applied_at = ? WHERE id = ? AND status = 'pending'`, [nowIso(), row.id]);
}

export async function spinLifeEvent(opts: { classId: string; studentId: string; actorId: string; now?: Date; drawIndex?: number }) {
  const eventDate = classDate(opts.now);
  const row = await withTx(async (tx) => {
    const student = await tx.one<{ id: string; job_title: string | null; job_pay_cents: number | null }>(
      `SELECT id, job_title, job_pay_cents FROM users WHERE id = ? AND class_id = ? AND role = 'student'${tx.dialect === "pg" ? " FOR UPDATE" : ""}`,
      [opts.studentId, opts.classId]);
    if (!student) throw new LifeEventError("NOT_FOUND", "Choose a student in the selected period.");
    const existing = await tx.one<EventRow>(`SELECT * FROM life_events WHERE user_id = ? AND event_date = ?`, [opts.studentId, eventDate]);
    if (existing) return existing;
    if (!student.job_title || !Number(student.job_pay_cents)) throw new LifeEventError("NOT_READY", "Assign this student a job and paycheck before spinning.");
    const index = opts.drawIndex ?? randomInt(LIFE_EVENT_OPTIONS.length);
    if (!Number.isInteger(index) || index < 0 || index >= LIFE_EVENT_OPTIONS.length) throw new LifeEventError("INVALID_INPUT", "Invalid wheel result.");
    const option = LIFE_EVENT_OPTIONS[index];
    const previousPay = Number(student.job_pay_cents);
    const payload = option.key === "promotion"
      ? { newJobTitle: `${student.job_title} (promoted)`, newPayCents: Math.round(previousPay * 1.1) }
      : option.key === "layoff"
        ? { newJobTitle: "Cashier at Arby's", newPayCents: Math.max(1, Math.min(40000, Math.round(previousPay * .85))) }
        : {};
    const id = newId("life");
    await tx.run(`INSERT INTO life_events (id, user_id, class_id, event_date, event_key, payload, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?) ON CONFLICT(user_id, event_date) DO NOTHING`,
      [id, opts.studentId, opts.classId, eventDate, option.key, JSON.stringify(payload), nowIso()]);
    return (await tx.one<EventRow>(`SELECT * FROM life_events WHERE user_id = ? AND event_date = ?`, [opts.studentId, eventDate]))!;
  });
  await applyEvent(row, opts.actorId);
  const applied = (await one<EventRow>(`SELECT * FROM life_events WHERE id = ?`, [row.id]))!;
  return publicEvent(applied);
}

export async function classLifeEvents(classId: string) {
  const rows = await q<EventRow>(`SELECT * FROM life_events WHERE class_id = ? ORDER BY created_at DESC`, [classId]);
  return rows.map(publicEvent);
}

export async function studentLifeEvents(userId: string) {
  const rows = await q<EventRow>(`SELECT * FROM life_events WHERE user_id = ? AND status = 'applied' ORDER BY created_at DESC LIMIT 10`, [userId]);
  return rows.map(publicEvent);
}
