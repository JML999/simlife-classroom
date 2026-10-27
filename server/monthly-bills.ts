import { q, one, run, withTx } from './db.js';
import { issueBillInTx } from './bank.js';
import { schoolDate, nextMonthlyDate, monthlyDate, billDueAt, statementReady } from './billing-dates.js';
const types = [
  { kind: 'rent', day: 1, field: 'rent_cents', title: 'Rent', sender: 'SimLife Housing', match: /^(rent|housing|house payment|mortgage)(\s|$|[·:—-])/i },
  { kind: 'car', day: 10, field: 'car_payment_cents', title: 'Car Payment', sender: 'SimLife Auto Finance', match: /^(car payment|auto payment)(\s|$|[·:—-])/i },
];
export async function setMonthlyBilling(classId: string, enabled: boolean, now = new Date()) {
  if (!await one('SELECT id FROM classes WHERE id=?', [classId])) throw new Error('Class not found.');
  await run(`INSERT INTO monthly_billing_classes (class_id,enabled,started_at) VALUES (?,?,?) ON CONFLICT(class_id) DO UPDATE SET enabled=excluded.enabled`, [classId,enabled?1:0,now.toISOString()]);
  if (enabled) await ensureMonthlyBills(undefined,now,classId);
}
/** Opt-in by class. New amounts apply to unissued future cycles, never rewrite paid bills. */
export async function ensureMonthlyBills(userId?: string, now = new Date(), classId?: string) {
  const students = await q<any>(`SELECT u.id FROM users u JOIN monthly_billing_classes c ON c.class_id=u.class_id AND c.enabled=1 WHERE u.role='student'${userId?' AND u.id=?':''}${classId?' AND u.class_id=?':''}`, [...(userId?[userId]:[]),...(classId?[classId]:[])]);
  for (const student of students) await withTx(async t => {
    const user = await t.one<any>(`SELECT * FROM users WHERE id=?${t.dialect==='pg'?' FOR UPDATE':''}`, [student.id]);
    if (!await t.one(`SELECT class_id FROM monthly_billing_classes WHERE class_id=? AND enabled=1`,[user.class_id])) return;
    for (const type of types) {
      if (!(Number(user[type.field]) > 0)) continue;
      await t.run(`INSERT INTO monthly_bill_schedules (user_id,kind,first_due_date) VALUES (?,?,?) ON CONFLICT(user_id,kind) DO NOTHING`, [user.id,type.kind,nextMonthlyDate(now,type.day)]);
      const schedule = (await t.one<any>(`SELECT first_due_date FROM monthly_bill_schedules WHERE user_id=? AND kind=?`,[user.id,type.kind]))!;
      for (let month=0;;month++) {
        const due = monthlyDate(schedule.first_due_date,month,type.day);
        if (!statementReady(due,now)) break;
        if (await t.one(`SELECT bill_id FROM monthly_bill_cycles WHERE user_id=? AND kind=? AND due_date=?`,[user.id,type.kind,due])) continue;
        // Adopt a nearby existing teacher bill, including one already paid, rather than double charge.
        const existing = await t.q<any>(`SELECT b.* FROM bills b WHERE b.user_id=? AND NOT EXISTS (SELECT 1 FROM monthly_bill_cycles c WHERE c.bill_id=b.id) ORDER BY b.due_at DESC`,[user.id]);
        const duplicate = existing.find(b => type.match.test(b.title) && Math.abs(new Date(`${schoolDate(new Date(b.due_at))}T12:00:00Z`).getTime()-new Date(`${due}T12:00:00Z`).getTime())<=7*86400000);
        const bill = duplicate ?? await issueBillInTx(t, { userId:user.id,title:type.title,amountCents:Number(user[type.field]),lateFeeCents:0,dueAt:billDueAt(due),issuedBy:'SimLife Monthly Billing',idempotencyKey:`monthly:${user.id}:${type.kind}:${due}`,sender:type.sender,documentTitle:`Monthly ${type.title.toLowerCase()} statement`,documentBody:`Your assigned monthly ${type.kind==='rent'?'housing':'car'} payment. Due on the ${type.day===1?'1st':'10th'} of each month. Pay from checking. This bill is not an automatic withdrawal. Future unissued bills use your assigned amount at the time they are issued.` });
        await t.run(`INSERT INTO monthly_bill_cycles (user_id,kind,due_date,bill_id) VALUES (?,?,?,?)`,[user.id,type.kind,due,bill.id]);
      }
    }
  });
}
export async function monthlyBillingSummary(userId: string, now = new Date()) {
  const user = await one<any>('SELECT * FROM users WHERE id=?',[userId]);
  const enabled = !!(await one<any>('SELECT enabled FROM monthly_billing_classes WHERE class_id=? AND enabled=1',[user?.class_id]));
  return { enabled, items: await Promise.all(types.map(async type => {
    const last = await one<any>('SELECT due_date FROM monthly_bill_cycles WHERE user_id=? AND kind=? ORDER BY due_date DESC LIMIT 1',[userId,type.kind]);
    const schedule = await one<any>('SELECT first_due_date FROM monthly_bill_schedules WHERE user_id=? AND kind=?',[userId,type.kind]);
    const unpaid=await one<any>(`SELECT b.* FROM monthly_bill_cycles c JOIN bills b ON b.id=c.bill_id WHERE c.user_id=? AND c.kind=? AND b.paid_at IS NULL AND b.paid_cents<b.amount_cents ORDER BY b.due_at LIMIT 1`,[userId,type.kind]);
    const nextStatementDate=last?monthlyDate(last.due_date,1,type.day):schedule?.first_due_date??nextMonthlyDate(now,type.day);
    return {kind:type.kind,title:type.title,day:type.day,amountCents:Number(user?.[type.field]||0),nextDueDate:unpaid?schoolDate(new Date(unpaid.due_at)):nextStatementDate,nextStatementDate,nextAmountCents:unpaid?Math.max(0,Number(unpaid.amount_cents)-Number(unpaid.paid_cents||0)):Number(user?.[type.field]||0)};
  })) };
}
