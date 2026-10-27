import { schoolDate, nextMonthlyDate, monthlyDate, billDueAt, statementReady } from "./billing-dates.js";
import { randomInt } from "node:crypto";
import { one, q, run, withTx, newId, nowIso, type Tx } from "./db.js";
import { type ClassPost, ClassPostError } from "./class-posts.js";
import { classModuleKey, hiddenClassModuleKeys } from "./class-modules.js";
import { issueBillInTx } from "./bank.js";
import { EDUCATION_PATHS, EDUCATION_POST_ID, EDUCATION_APR_BPS, EDUCATION_MONTHS, repaymentSchedule, monthlyFromWeekly } from "../shared/education-paths.js";

export async function ensureEducationAssignment() {
  await run(`INSERT INTO class_posts (id,kind,class_id,title,summary,body,spec,hero_url,status,created_at)
    VALUES (?,'college_pathways',NULL,?,?,?,'{"responseVersion":4}','/module-art/education-decision.svg','published',?) ON CONFLICT(id) DO NOTHING`,
    [EDUCATION_POST_ID, "Choose Your Path: Education & Debt", "Compare the costs. Choose your path. Discover your next job and monthly loan payment.",
     "Compare keeping your job with four education routes. Explain your choice before spinning. Your school choice fixes your monthly loan bill, even if your job changes later. No reflection after the spin.", nowIso()]);
}
export async function educationAccess(post: ClassPost, userId: string) {
  const user = await one<any>(`SELECT * FROM users WHERE id = ?`, [userId]);
  if (!user || user.role !== "student" || post.id !== EDUCATION_POST_ID || post.kind !== "college_pathways" || post.status !== "published"
    || (post.classId && post.classId !== user.class_id) || (await hiddenClassModuleKeys(user.class_id)).has(classModuleKey("post", post.id))) throw new ClassPostError("NOT_FOUND", "Assignment not found.");
  return user;
}
export async function setEducationEnabled(classId: string, enabled: boolean) {
  if (!(await one(`SELECT id FROM classes WHERE id = ?`, [classId]))) throw new ClassPostError("NOT_FOUND", "Class not found.");
  await run(`INSERT INTO education_class_settings (class_id,spins_enabled) VALUES (?,?) ON CONFLICT(class_id) DO UPDATE SET spins_enabled=excluded.spins_enabled`, [classId, enabled ? 1 : 0]);
}
export async function educationEnabled(classId: string | null) {
  return !!(classId && Number((await one<any>(`SELECT spins_enabled FROM education_class_settings WHERE class_id = ?`, [classId]))?.spins_enabled));
}
/** Month arithmetic keeps Jan 31 -> Feb 28 -> Mar 31 anchored to the original date. */
export function educationMonth(start: string, months: number) {
  const original = new Date(start), d = new Date(start);
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(original.getUTCDate(), last)); return d;
}
async function issueInstallments(t: Tx, decision: any, now: Date) {
  const terms = JSON.parse(decision.terms);
  if (!terms.installments.length) return;
  await t.run(`INSERT INTO education_billing_schedules (decision_id,first_due_date) VALUES (?,?) ON CONFLICT(decision_id) DO NOTHING`,[decision.id,nextMonthlyDate(new Date(decision.created_at),27)]);
  const schedule=(await t.one<any>(`SELECT first_due_date FROM education_billing_schedules WHERE decision_id=?`,[decision.id]))!;
  for (let i = 0; i < terms.installments.length; i++) {
    const dueDate=monthlyDate(schedule.first_due_date,i,27), dueAt=billDueAt(dueDate);
    const existing=await t.one<any>(`SELECT b.* FROM education_installments ei JOIN bills b ON b.id=ei.bill_id WHERE ei.decision_id=? AND ei.installment_no=?`,[decision.id,i+1]);
    if (existing) {
      // Keep every payment, bill ID and installment. Only align open statements to the requested due day.
      if (!existing.paid_at && existing.due_at!==dueAt) await t.run(`UPDATE bills SET due_at=? WHERE id=?`,[dueAt,existing.id]);
      continue;
    }
    if (i>0&&!statementReady(dueDate,now)) break;
    const bill = await issueBillInTx(t, { userId: decision.user_id, title: `Student loan · payment ${i + 1} of ${terms.installments.length}`,
      amountCents: terms.installments[i], lateFeeCents: 0, dueAt,
      issuedBy: "SimLife Education", idempotencyKey: `education:${decision.id}:${i + 1}`, sender: "SimLife Student Loans",
      documentTitle: "Student loan monthly statement", documentBody: `${terms.school}. Fixed classroom loan: ${terms.aprBps / 100}% APR over ${terms.months} months. Due on the 27th each month. Your payment stays the same when your job changes. Final payment may be slightly smaller. This payment includes scheduled principal and interest. Pay from checking. No extra late interest or fees in this classroom scenario.` });
    await t.run(`INSERT INTO education_installments (decision_id,installment_no,bill_id) VALUES (?,?,?)`, [decision.id, i + 1, bill.id]);
  }
}
/** Safe on restart and after downtime. A user lock serializes issuance with decisions. */
export async function ensureEducationBills(userId?: string, now = new Date()) {
  const rows = await q<any>(`SELECT * FROM education_decisions${userId ? " WHERE user_id = ?" : ""}`, userId ? [userId] : []);
  for (const row of rows) await withTx(async t => {
    await t.one(`SELECT id FROM users WHERE id = ?${t.dialect === "pg" ? " FOR UPDATE" : ""}`, [row.user_id]);
    await issueInstallments(t, row, now);
  });
}
export async function educationState(userId: string, now = new Date()) {
  await ensureEducationBills(userId, now);
  const decision = await one<any>(`SELECT * FROM education_decisions WHERE user_id = ?`, [userId]);
  const user = await one<any>(`SELECT name,job_title,job_pay_cents,rent_cents,car_payment_cents,class_id FROM users WHERE id = ?`, [userId]);
  const paid = decision ? await one<any>(`SELECT COALESCE(SUM(b.paid_cents),0) AS cents FROM education_installments i JOIN bills b ON b.id=i.bill_id WHERE i.decision_id=?`, [decision.id]) : null;
  const other = await q<any>(`SELECT b.title,b.amount_cents,b.paid_cents,b.due_at FROM bills b
    WHERE b.user_id=? AND b.paid_at IS NULL AND NOT EXISTS (SELECT 1 FROM education_installments i WHERE i.bill_id=b.id)`, [userId]);
  const rent = Number(user?.rent_cents || 0), car = Number(user?.car_payment_cents || 0);
  const claims = await one<any>(`SELECT COALESCE(SUM(amount_cents-paid_cents),0) AS cents FROM wage_claims WHERE user_id=?`, [userId]);
  const cutoff = new Date(now.getTime() + 30 * 86400000).toISOString();
  const otherDue = other.filter(b => b.due_at <= cutoff && !(rent && /rent/i.test(b.title)) && !(car && /car payment|auto payment/i.test(b.title)))
    .reduce((sum, b) => sum + Math.max(0, Number(b.amount_cents) - Number(b.paid_cents || 0)), 0);
  const terms = decision ? JSON.parse(decision.terms) : null;
  let billing: any = null;
  if (decision && terms.principalCents>0) {
    const schedule=(await one<any>(`SELECT first_due_date FROM education_billing_schedules WHERE decision_id=?`,[decision.id]))!;
    const statements=await q<any>(`SELECT i.installment_no,b.* FROM education_installments i JOIN bills b ON b.id=i.bill_id WHERE i.decision_id=? ORDER BY i.installment_no`,[decision.id]);
    const byNumber=new Map(statements.map(b=>[Number(b.installment_no),b]));
    let principal=terms.principalCents, principalPaid=0, interestPaid=0, actualPaid=0, dueNow=0, overdue=0, complete=0, next: any=null;
    for(let i=0;i<terms.installments.length;i++) {
      const interest=Math.round(principal*terms.aprBps/10000/12), installment=terms.installments[i];
      const bill=byNumber.get(i+1), payment=bill?Math.min(installment,bill.paid_at&&!Number(bill.paid_cents)?Number(bill.amount_cents):Number(bill.paid_cents||0)):0;
      interestPaid+=Math.min(payment,interest);principalPaid+=Math.max(0,payment-interest);actualPaid+=payment;
      principal=principal+interest-installment;
      const remaining=installment-payment, dueDate=monthlyDate(schedule.first_due_date,i,27), dueAt=bill?.due_at??billDueAt(dueDate);
      if(remaining===0){complete++;continue;}
      if(!next)next={amountCents:remaining,dueAt,billId:bill?.id??null,installment:i+1};
      if(new Date(dueAt).getTime()<now.getTime())overdue+=remaining;
      // Due today or earlier, using the school calendar date rather than UTC midnight.
      if(dueDate<=schoolDate(now))dueNow+=remaining;
    }
    billing={dueDay:27,nextPayment:next,amountDueCents:dueNow,overdueCents:overdue,remainingPrincipalCents:Math.max(0,terms.principalCents-principalPaid),interestRemainingCents:Math.max(0,terms.interestCents-interestPaid),paidInstallments:complete,installmentsRemaining:terms.installments.length-complete,actualPaidCents:actualPaid};
  }
  return { studentName: user?.name || "", enabled: await educationEnabled(user?.class_id),
    decision: decision ? { id: decision.id, routeId: decision.route_id, reason: decision.reason, terms, outcome: JSON.parse(decision.outcome), createdAt: decision.created_at,
      billing, paidCents: billing?.actualPaidCents ?? Number(paid?.cents || 0), remainingCents: Math.max(0, terms.totalCents - (billing?.actualPaidCents ?? Number(paid?.cents || 0))) } : null,
    budget: { jobTitle: user?.job_title, weeklyPayCents: Number(user?.job_pay_cents || 0), monthlyPayCents: monthlyFromWeekly(Number(user?.job_pay_cents || 0)),
      rentCents: rent, carCents: car, otherDueCents: otherDue, claimBalanceCents: Number(claims?.cents || 0), existingExpensesCents: rent + car + otherDue } };
}
/** A financial decision is one-shot, server-drawn, and atomic with the job and first bill. */
export async function chooseEducation(opts: { post: ClassPost; userId: string; routeId: string; reason: string; signature?: string; now?: Date; drawIndex?: number }) {
  await educationAccess(opts.post, opts.userId);
  const route = EDUCATION_PATHS.find(p => p.id === opts.routeId);
  if (!route || typeof opts.reason !== "string" || !opts.reason.trim() || opts.reason.length > 6000) throw new ClassPostError("INVALID_INPUT", "Choose a path and explain your choice before making your final decision. You can submit unfinished work separately.");
  const now = opts.now ?? new Date();
  await withTx(async t => {
    const user = await t.one<any>(`SELECT * FROM users WHERE id = ?${t.dialect === "pg" ? " FOR UPDATE" : ""}`, [opts.userId]);
    const existing = await t.one<any>(`SELECT * FROM education_decisions WHERE user_id = ?`, [opts.userId]);
    if (existing) {
      if (existing.route_id !== route.id) throw new ClassPostError("INVALID_INPUT", "Your official path is already chosen. You cannot reroll or take another loan.");
      return;
    }
    const signature = typeof opts.signature === "string" ? opts.signature.trim() : "";
    const normalize = (name: string) => name.normalize("NFKC").replace(/\s+/g, " ").toLocaleLowerCase();
    if (!signature || signature.length > 120 || normalize(signature) !== normalize(user.name)) throw new ClassPostError("INVALID_INPUT", "Sign with your account name to accept this path and its payment terms.");
    if (!await t.one(`SELECT class_id FROM education_class_settings WHERE class_id = ? AND spins_enabled = 1`, [user.class_id])) throw new ClassPostError("NOT_READY", "Your teacher has not opened career decisions for this period yet.");
    if (!user.job_title || !(Number(user.job_pay_cents) > 0)) throw new ClassPostError("NOT_READY", "Ask your teacher to assign your current job first.");
    const index = route.id === "work" ? -1 : opts.drawIndex ?? randomInt(route.jobs.length);
    if (route.id !== "work" && (!Number.isInteger(index) || !route.jobs[index])) throw new ClassPostError("INVALID_INPUT", "Invalid spin result.");
    const outcome = index < 0 ? { index: -1, title: user.job_title, weeklyCents: Number(user.job_pay_cents) } : { ...route.jobs[index], index };
    const terms = { ...route, ...repaymentSchedule(route.principalCents), aprBps: EDUCATION_APR_BPS, months: route.principalCents ? EDUCATION_MONTHS : 0, signature, signedAt: now.toISOString(), financingVersion: 2 };
    const id = newId("education"), createdAt = now.toISOString();
    const decision = { id, user_id: user.id, terms: JSON.stringify(terms), created_at: createdAt };
    await t.run(`INSERT INTO education_decisions (id,user_id,post_id,route_id,reason,terms,outcome,created_at) VALUES (?,?,?,?,?,?,?,?)`,
      [id,user.id,opts.post.id,route.id,opts.reason.trim(),decision.terms,JSON.stringify(outcome),createdAt]);
    if (index >= 0) await t.run(`UPDATE users SET job_title=?,job_pay_cents=?,job_updated_at=? WHERE id=?`, [outcome.title,outcome.weeklyCents,createdAt,user.id]);
    await issueInstallments(t, decision, now);
    await t.run(`INSERT INTO class_post_submissions (id,post_id,user_id,response,evidence,idempotency_key,created_at) VALUES (?,?,?,?,?,?,?)`,
      [newId("csub"),opts.post.id,user.id,JSON.stringify({version:4,routeId:route.id,reason:opts.reason.trim(),signature}),JSON.stringify({kind:"education_decision",outcome,terms}),`education:${id}`,createdAt]);
    await t.run(`DELETE FROM class_post_drafts WHERE post_id=? AND user_id=?`, [opts.post.id,user.id]);
  });
  return educationState(opts.userId, now);
}
