import './env.js';
import os from 'node:os';import path from 'node:path';import {before,test} from 'node:test';import assert from 'node:assert/strict';
process.env.SIMLIFE_DB_PATH=path.join(os.tmpdir(),`simlife-gross-${process.pid}.db`);delete process.env.SIMLIFE_DATABASE_URL;
const db=await import('./db.js'),ledger=await import('./ledger.js'),lb=await import('./leaderboard.js'),gross=await import('./gross-gains.js');
const start=new Date('2026-10-27T14:00:00Z'),prices=new Map<string,number>();const priceOf=(t:string)=>prices.get(t)??null;
const trade={quoteTs:start.toISOString(),quoteSource:'mock',tradingFrozen:false};
async function capture(classId:string,date:string,time:string){await lb.snapshotAll(date,priceOf,{classId});await gross.recordGrossGainSnapshot(classId,date,new Date(time));}
before(async()=>{
 await db.initSchema();for(const id of ['gross3','gross4','bad'])await db.run(`INSERT INTO classes (id,name,join_code,created_at) VALUES (?,?,?,?)`,[id,id,id,start.toISOString()]);
 await db.run(`INSERT INTO users (id,name,role,created_at) VALUES ('gross-teacher','Teacher','teacher',?)`,[start.toISOString()]);
 for(const id of ['alpha','beta']){await db.run(`INSERT INTO users (id,name,role,class_id,created_at) VALUES (?,?,'student','gross3',?)`,[id,id,start.toISOString()]);await ledger.adjustCash({userId:id,actorId:'gross-teacher',amountCents:100000,reason:'Initial funding',idempotencyKey:'fund:'+id});}
 prices.set('AAA',11000);prices.set('BBB',10000);
 await ledger.buy({userId:'alpha',ticker:'AAA',qtyMicro:10e6,priceCents:10000,...trade,idempotencyKey:'alpha-buy'});
 await ledger.buy({userId:'beta',ticker:'BBB',qtyMicro:10e6,priceCents:10000,...trade,idempotencyKey:'beta-buy'});
 await gross.ensureGrossGainRound(start);
});
test('fresh baseline ignores earlier gains, survives refreshes and leaves percentage returns intact',async()=>{
 await capture('gross3','2026-10-27',start.toISOString());let board=await gross.grossGainsFor('gross3');assert.equal(board.startsAt,start.toISOString());assert.deepEqual(board.entries.map(e=>e.gainCents),[0,0]);
 assert.equal((await lb.leaderboardFor('gross3')).entries.find(e=>e.userId==='alpha')?.returnBp,1000);
 prices.set('AAA',12000);prices.set('BBB',10500);await capture('gross3','2026-10-27','2026-10-27T15:00:00Z');
 board=await gross.grossGainsFor('gross3');assert.deepEqual(board.entries.map(e=>[e.userId,e.gainCents]),[['alpha',10000],['beta',5000]]);
 await gross.ensureGrossGainRound(new Date('2026-10-28T14:00:00Z'));await capture('gross3','2026-10-27','2026-10-27T16:00:00Z');assert.equal((await gross.grossGainsFor('gross3')).entries[0].gainCents,10000);
 assert.equal((await db.one<any>(`SELECT baseline_value_cents FROM gross_gain_entries WHERE user_id='alpha'`))?.baseline_value_cents,110000);
});
test('deposits and withdrawals do not count as profits; selling preserves change since baseline',async()=>{
 await ledger.adjustCash({userId:'beta',actorId:'gross-teacher',amountCents:200000,reason:'Additional funding',idempotencyKey:'beta-more'});
 await ledger.sell({userId:'alpha',ticker:'AAA',sellAll:true,priceCents:12000,...trade,idempotencyKey:'alpha-sale'});
 await ledger.adjustCash({userId:'alpha',actorId:'gross-teacher',amountCents:-100000,reason:'Withdraw cash',idempotencyKey:'alpha-withdraw'});
 await capture('gross3','2026-10-28','2026-10-28T14:00:00Z');const board=await gross.grossGainsFor('gross3');assert.deepEqual(board.entries.map(e=>e.gainCents),[10000,5000]);
 assert.equal(board.entries[0].holdingsCount,0);assert.equal((await ledger.checkInvariant('alpha')).ok,true);
});
test('negative gains sort below positive gains and class transfers retain the original baseline',async()=>{
 prices.set('BBB',9000);await capture('gross3','2026-10-29','2026-10-29T14:00:00Z');assert.deepEqual((await gross.grossGainsFor('gross3')).entries.map(e=>e.gainCents),[10000,-10000]);
 await db.run(`UPDATE users SET class_id='gross4' WHERE id='alpha'`);await capture('gross4','2026-10-29','2026-10-29T15:00:00Z');assert.equal((await gross.grossGainsFor('gross4')).entries[0].gainCents,10000);assert.equal((await gross.grossGainsFor('gross3')).entries.length,1);
});
test('later arrivals begin at zero and older refreshes cannot overwrite newer entries',async()=>{
 await db.run(`INSERT INTO users (id,name,role,class_id,created_at) VALUES ('late','Late','student','gross4',?)`,[start.toISOString()]);
 await ledger.adjustCash({userId:'late',actorId:'gross-teacher',amountCents:50000,reason:'New account',idempotencyKey:'late-funding'});
 await capture('gross4','2026-10-30','2026-10-30T14:00:00Z');const first=(await gross.grossGainsFor('gross4')).entries.find(e=>e.userId==='late');assert.equal(first?.gainCents,0);
 await gross.recordGrossGainSnapshot('gross4','2026-10-30',new Date('2026-10-29T14:00:00Z'));assert.equal((await gross.grossGainsFor('gross4')).entries.find(e=>e.userId==='late')?.baselineAt,'2026-10-30T14:00:00.000Z');
 const empty=await gross.grossGainsFor('bad');assert.equal(empty.asOfDate,null);assert.deepEqual(empty.entries,[]);
});
test('historical or incomplete quote refreshes cannot create fresh-round baselines',async()=>{
 await db.run(`INSERT INTO users (id,name,role,class_id,created_at) VALUES ('unpriced','Unpriced','student','bad',?)`,[start.toISOString()]);
 await ledger.adjustCash({userId:'unpriced',actorId:'gross-teacher',amountCents:10000,reason:'Test funding',idempotencyKey:'bad-funding'});
 await ledger.buy({userId:'unpriced',ticker:'BAD',qtyMicro:1e6,priceCents:10000,...trade,idempotencyKey:'bad-buy'});
 prices.set('BAD',10000);await lb.snapshotAll('2026-10-26',priceOf,{classId:'bad'});await gross.recordGrossGainSnapshot('bad','2026-10-26',start);assert.equal((await gross.grossGainsFor('bad')).entries.length,0);
 const {CachedQuotes}=await import('./quotes.js'),{refreshClassSnapshot}=await import('./leaderboard-refresh.js');
 const broken=new CachedQuotes({name:'broken',search:async()=>[],getQuote:async()=>{throw new Error('No quote');}});
 await assert.rejects(refreshClassSnapshot('bad',broken),/No quote/);assert.equal((await gross.grossGainsFor('bad')).entries.length,0);
});
