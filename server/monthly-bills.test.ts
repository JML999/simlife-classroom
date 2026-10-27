import './env.js';
import os from 'node:os';
import path from 'node:path';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
process.env.SIMLIFE_DB_PATH=path.join(os.tmpdir(),`simlife-monthly-${process.pid}.db`);delete process.env.SIMLIFE_DATABASE_URL;
const db=await import('./db.js'), monthly=await import('./monthly-bills.js'), bank=await import('./bank.js'), dates=await import('./billing-dates.js');
const now=new Date('2026-10-27T14:00:00Z');
before(async()=>{
 await db.initSchema();await db.run(`INSERT INTO classes (id,name,join_code,created_at) VALUES ('monthly','Monthly','MONTHLY',?)`,[now.toISOString()]);
 for(const id of ['assigned','missing','existing','later'])await db.run(`INSERT INTO users (id,name,role,class_id,rent_cents,car_payment_cents,created_at) VALUES (?,?,'student','monthly',?,?,?)`,[id,id,id==='missing'?null:60000,id==='missing'?0:28600,now.toISOString()]);
 await db.run(`INSERT INTO users (id,name,role,created_at) VALUES ('monthly-teacher','Teacher','teacher',?)`,[now.toISOString()]);
});
test('school calendar dates respect New York midnight and DST end-of-day deadlines',()=>{
 assert.equal(dates.schoolDate(new Date('2026-10-28T02:00:00Z')),'2026-10-27');
 assert.equal(dates.billDueAt('2026-10-27'),'2026-10-28T03:59:59.999Z');
 assert.equal(dates.billDueAt('2026-11-10'),'2026-11-11T04:59:59.999Z');
 assert.equal(dates.nextMonthlyDate(now,27),'2026-10-27');assert.equal(dates.nextMonthlyDate(new Date('2026-10-29T14:00:00Z'),27),'2026-11-27');
});
test('class activation issues the coming rent, skips missing amounts and avoids historical charges',async()=>{
 await monthly.ensureMonthlyBills(undefined,now);assert.equal((await db.q('SELECT * FROM bills')).length,0);
 await monthly.setMonthlyBilling('monthly',true,now);
 const bills=await db.q<any>(`SELECT * FROM bills WHERE user_id='assigned'`);assert.equal(bills.length,1);assert.equal(bills[0].title,'Rent');assert.equal(bills[0].amount_cents,60000);assert.equal(dates.schoolDate(new Date(bills[0].due_at)),'2026-11-01');
 assert.equal((await db.q(`SELECT * FROM bills WHERE user_id='missing'`)).length,0);
});
test('paid nearby manual bills count for the cycle and future car charges use car rather than rent',async()=>{
 // Replace this fixture's initially generated rent with a genuinely pre-existing paid manual statement.
 await db.run(`INSERT INTO users (id,name,role,class_id,rent_cents,car_payment_cents,created_at) VALUES ('manual','Manual','student','monthly',100000,28600,?)`,[now.toISOString()]);
 const bill=await db.withTx(t=>bank.issueBillInTx(t,{userId:'manual',title:'Rent',amountCents:100000,dueAt:'2026-10-30T12:00:00Z',issuedBy:'monthly-teacher',idempotencyKey:'manual-oct30'}));
 await bank.postIncome({userId:'manual',actorId:'monthly-teacher',label:'Test funds',amountCents:200000,idempotencyKey:'manual-funds'});
 await bank.payBill({userId:'manual',billId:bill.id,idempotencyKey:'manual-paid'});
 await monthly.ensureMonthlyBills('manual',now);
 assert.equal((await db.q(`SELECT * FROM bills WHERE user_id='manual' AND title='Rent'`)).length,1);
 assert.equal((await db.one<any>(`SELECT bill_id FROM monthly_bill_cycles WHERE user_id='manual' AND kind='rent'`))?.bill_id,bill.id);
 await monthly.ensureMonthlyBills('manual',new Date('2026-11-03T15:00:00Z'));
 const car=await db.one<any>(`SELECT * FROM bills WHERE user_id='manual' AND title='Car Payment'`);assert.equal(car.amount_cents,28600);assert.equal(dates.schoolDate(new Date(car.due_at)),'2026-11-10');
});
test('concurrent refreshes, restart catch-up, changed amounts and pause retain one bill per cycle',async()=>{
 await Promise.all([monthly.ensureMonthlyBills('assigned',new Date('2026-11-25T15:00:00Z')),monthly.ensureMonthlyBills('assigned',new Date('2026-11-25T15:00:00Z'))]);
 assert.equal((await db.q(`SELECT * FROM monthly_bill_cycles WHERE user_id='assigned' AND kind='rent'`)).length,2);
 await db.run(`UPDATE users SET rent_cents=70000,car_payment_cents=30000 WHERE id='assigned'`);
 await monthly.ensureMonthlyBills('assigned',new Date('2026-12-03T15:00:00Z'));
 const rents=await db.q<any>(`SELECT b.amount_cents,c.due_date FROM bills b JOIN monthly_bill_cycles c ON c.bill_id=b.id WHERE c.user_id='assigned' AND c.kind='rent' ORDER BY c.due_date`);
 assert.deepEqual(rents.map(b=>b.amount_cents),[60000,60000]);
 const car=await db.one<any>(`SELECT b.amount_cents FROM bills b JOIN monthly_bill_cycles c ON c.bill_id=b.id WHERE c.user_id='assigned' AND c.kind='car' AND c.due_date='2026-12-10'`);assert.equal(car.amount_cents,30000);
 const count=(await db.q(`SELECT * FROM bills WHERE user_id='assigned'`)).length;
 await monthly.setMonthlyBilling('monthly',false,now);await monthly.ensureMonthlyBills('assigned',new Date('2027-01-01T15:00:00Z'));
 assert.equal((await db.q(`SELECT * FROM bills WHERE user_id='assigned'`)).length,count);
 await monthly.setMonthlyBilling('monthly',true,new Date('2027-01-01T15:00:00Z'));
 const jan=await db.one<any>(`SELECT b.amount_cents FROM bills b JOIN monthly_bill_cycles c ON c.bill_id=b.id WHERE c.user_id='assigned' AND c.kind='rent' AND c.due_date='2027-01-01'`);assert.equal(jan.amount_cents,70000);
});
test('newly assigned amounts start at the next due date rather than backbilling months without an obligation',async()=>{
 await db.run(`UPDATE users SET rent_cents=50000,car_payment_cents=20000 WHERE id='missing'`);
 await monthly.ensureMonthlyBills('missing',new Date('2027-01-15T15:00:00Z'));
 assert.equal((await db.q(`SELECT * FROM bills WHERE user_id='missing'`)).length,0);
 const schedule=await monthly.monthlyBillingSummary('missing',new Date('2027-01-15T15:00:00Z'));assert.equal(schedule.items[0].nextDueDate,'2027-02-01');assert.equal(schedule.items[1].nextDueDate,'2027-02-10');
 await monthly.ensureMonthlyBills('missing',new Date('2027-01-25T15:00:00Z'));
 assert.equal((await db.q(`SELECT * FROM bills WHERE user_id='missing'`)).length,1);
});
