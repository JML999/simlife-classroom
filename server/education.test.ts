import "./env.js";
import os from "node:os";
import path from "node:path";
import { before, test } from "node:test";
import assert from "node:assert/strict";
process.env.SIMLIFE_DB_PATH = path.join(os.tmpdir(),`simlife-education-${process.pid}.db`);
delete process.env.SIMLIFE_DATABASE_URL;
const db=await import("./db.js"), education=await import("./education.js"), black=await import("./black-monday.js"), posts=await import("./class-posts.js"), bank=await import("./bank.js"), college=await import("./college.js");
const shared=await import("../shared/education-paths.js");
const now=new Date("2026-10-21T14:00:00.000Z");
before(async()=>{
 await db.initSchema();
 await db.run(`INSERT INTO classes (id,name,join_code,created_at) VALUES ('edu-class','Education Class','EDU',?)`,[db.nowIso()]);
 await db.run(`INSERT INTO users (id,name,role,created_at) VALUES ('edu-teacher','Teacher','teacher',?)`,[db.nowIso()]);
 for(const id of ['top','low','safe','college','keep','race','incomplete'])await db.run(`INSERT INTO users (id,name,role,class_id,job_title,job_pay_cents,created_at) VALUES (?,?,'student','edu-class','Original job',?,?)`,[id,id,id==='top'?900000:30000,db.nowIso()]);
 await education.ensureEducationAssignment();
});
const post=async()=>(await posts.getClassPost(shared.EDUCATION_POST_ID))!;
test('Black Monday uses fixed jobs for high and low earners; survives and retries preserve actual state',async()=>{
 const a=await black.spinBlackMonday({classId:'edu-class',studentId:'top',actorId:'edu-teacher',now,drawIndex:0});
 const b=await black.spinBlackMonday({classId:'edu-class',studentId:'low',actorId:'edu-teacher',now,drawIndex:0});
 assert.equal(a.newPayCents,40000);assert.equal(b.newPayCents,40000);
 await db.run(`UPDATE users SET job_title='Later promotion',job_pay_cents=80000 WHERE id='top'`);
 const retry=await black.spinBlackMonday({classId:'edu-class',studentId:'top',actorId:'edu-teacher',now,drawIndex:4});
 assert.equal(retry.id,a.id);assert.equal((await db.one<any>(`SELECT job_title FROM users WHERE id='top'`))?.job_title,'Later promotion');
 const safe=await black.spinBlackMonday({classId:'edu-class',studentId:'safe',actorId:'edu-teacher',now,drawIndex:4});assert.equal(safe.index,4);
 assert.equal((await db.one<any>(`SELECT job_pay_cents FROM users WHERE id='safe'`))?.job_pay_cents,30000);
 await assert.rejects(black.spinBlackMonday({classId:'edu-class',studentId:'safe',actorId:'low',now}),/Teacher access/);
 await assert.rejects(black.spinBlackMonday({classId:'other',studentId:'safe',actorId:'edu-teacher',now}),/selected period/);
 assert.equal(shared.BLACK_MONDAY_OPTIONS.length,5);
});
test('amortization pays off exactly, uses 6% fixed payment and clamps month-end dates',()=>{
 const schedule=shared.repaymentSchedule(2400000);assert.equal(schedule.installments.length,120);assert.ok(schedule.monthlyCents>=26640&&schedule.monthlyCents<=26650);
 let balance=2400000;for(const payment of schedule.installments)balance+=Math.round(balance*.06/12)-payment;
 assert.equal(balance,0);assert.equal(schedule.totalCents-2400000,schedule.interestCents);assert.ok(schedule.installments.at(-1)!<=schedule.monthlyCents);
 assert.equal(education.educationMonth('2026-01-31T12:00:00Z',1).toISOString(),'2026-02-28T12:00:00.000Z');
 assert.equal(education.educationMonth('2026-01-31T12:00:00Z',2).toISOString(),'2026-03-31T12:00:00.000Z');
});
test('teacher opens decisions; missing explanation can be submitted but cannot accidentally take debt',async()=>{
 const p=await post();await assert.rejects(education.chooseEducation({post:p,userId:'college',routeId:'fourYear',reason:'Better career',now}),/not opened/);
 await college.submitCollegePaths({post:p,userId:'incomplete',response:{version:4,routeId:'',reason:''}});
 assert.equal((await posts.latestClassPostSubmission(p.id,'incomplete'))?.response.version,4);
 assert.equal((await education.educationState('incomplete',now)).decision,null);
 await education.setEducationEnabled('edu-class',true);
 await assert.rejects(education.chooseEducation({post:p,userId:'incomplete',routeId:'art',reason:'',now}),/explain your choice/);
});
test('official college spin atomically sets weekly pay, freezes terms, and issues exactly one payable bill',async()=>{
 const result=await education.chooseEducation({post:await post(),userId:'college',routeId:'fourYear',reason:'I accept the fixed payment for the career opportunities.',now,drawIndex:2});
 assert.equal(result.decision?.outcome.title,'Accountant');assert.equal(result.budget.weeklyPayCents,shared.EDUCATION_PATHS[1].jobs[2].weeklyCents);
 assert.equal((await db.q(`SELECT * FROM education_installments WHERE decision_id=?`,[result.decision!.id])).length,1);
 const retry=await education.chooseEducation({post:await post(),userId:'college',routeId:'fourYear',reason:'Different text',now,drawIndex:0});assert.equal(retry.decision?.id,result.decision?.id);assert.equal(retry.decision?.outcome.title,'Accountant');
 await assert.rejects(education.chooseEducation({post:await post(),userId:'college',routeId:'art',reason:'Try reroll',now}),/already chosen/);
 await db.run(`UPDATE users SET job_title='Arby cashier',job_pay_cents=40000 WHERE id='college'`);
 assert.equal((await education.educationState('college',now)).decision?.terms.monthlyCents,result.decision?.terms.monthlyCents);
});
test('loan statements support partial/full payments, catch up after downtime, and stop at scheduled payoff',async()=>{
 const state=await education.educationState('college',now), id=state.decision!.id;
 const first=(await db.one<any>(`SELECT b.* FROM bills b JOIN education_installments i ON i.bill_id=b.id WHERE i.decision_id=? AND i.installment_no=1`,[id]))!;
 await bank.postIncome({userId:'college',actorId:'edu-teacher',label:'Loan test funds',amountCents:5000000,idempotencyKey:'loan-funds'});
 await bank.payBill({userId:'college',billId:first.id,amountCents:10000,idempotencyKey:'loan-partial'});
 assert.equal((await education.educationState('college',now)).decision?.paidCents,10000);
 await bank.payBill({userId:'college',billId:first.id,idempotencyKey:'loan-rest'});
 assert.equal((await education.educationState('college',now)).decision?.paidCents,first.amount_cents);
 await Promise.all([education.ensureEducationBills('college',education.educationMonth(now.toISOString(),1)),education.ensureEducationBills('college',education.educationMonth(now.toISOString(),1))]);
 assert.equal((await db.q(`SELECT * FROM education_installments WHERE decision_id=?`,[id])).length,2);
 const end=education.educationMonth(now.toISOString(),120);await education.ensureEducationBills('college',end);
 const bills=await db.q<any>(`SELECT b.id FROM bills b JOIN education_installments i ON i.bill_id=b.id WHERE i.decision_id=? ORDER BY i.installment_no`,[id]);assert.equal(bills.length,120);
 for(const b of bills.filter(b=>b.id!==first.id))await bank.payBill({userId:'college',billId:b.id,idempotencyKey:'payoff:'+b.id});
 const paid=await education.educationState('college',end);assert.equal(paid.decision?.remainingCents,0);assert.equal(paid.decision?.paidCents,paid.decision?.terms.totalCents);
 await education.ensureEducationBills('college',education.educationMonth(now.toISOString(),150));assert.equal((await db.q(`SELECT * FROM education_installments WHERE decision_id=?`,[id])).length,120);
 assert.equal((await bank.checkBankInvariant('college')).ok,true);
});
test('keeping work leaves job untouched and creates no loan; concurrent route choices cannot double apply',async()=>{
 const kept=await education.chooseEducation({post:await post(),userId:'keep',routeId:'work',reason:'Avoid debt',now});assert.equal(kept.decision?.terms.totalCents,0);assert.equal(kept.budget.weeklyPayCents,30000);
 assert.equal((await db.q(`SELECT * FROM education_installments WHERE decision_id=?`,[kept.decision!.id])).length,0);
 const p=await post();const race=await Promise.allSettled(['art','technical'].map(routeId=>education.chooseEducation({post:p,userId:'race',routeId,reason:'One decision',now,drawIndex:0})));
 assert.equal(race.filter(r=>r.status==='fulfilled').length,1);assert.equal((await db.q(`SELECT * FROM education_decisions WHERE user_id='race'`)).length,1);
});

test('visibility, archived status, and closed decisions block new financial changes; history prevents empty-account deletion',async()=>{
 const p=await post();
 await assert.rejects(education.chooseEducation({post:{...p,status:'archived'},userId:'incomplete',routeId:'work',reason:'Try it',now}),/not found/);
 const modules=await import('./class-modules.js');await modules.replaceHiddenClassModules('edu-class',[`post:${p.id}`]);
 await assert.rejects(education.chooseEducation({post:p,userId:'incomplete',routeId:'work',reason:'Try it',now}),/not found/);
 await modules.replaceHiddenClassModules('edu-class',[]);await education.setEducationEnabled('edu-class',false);
 await assert.rejects(education.chooseEducation({post:p,userId:'incomplete',routeId:'work',reason:'Try it',now}),/not opened/);
 assert.equal((await education.educationState('incomplete',now)).decision,null);
 const admin=await import('./student-admin.js');assert.equal((await admin.deletionStatus('keep')).canDelete,false);assert.equal((await admin.deletionStatus('safe')).canDelete,false);
});

test('budget includes outstanding wage claims without changing the education loan terms',async()=>{
 await bank.createWageClaim({userId:'incomplete',sourceKey:'edu-budget-claim',title:'Existing credit card claim',amountCents:75000});
 const state=await education.educationState('incomplete',now);assert.equal(state.budget.claimBalanceCents,75000);assert.equal(state.decision,null);
});
