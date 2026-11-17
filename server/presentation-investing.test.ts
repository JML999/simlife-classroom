import './env.js';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
process.env.SIMLIFE_DB_PATH=path.join(os.tmpdir(),`simlife-presentation-test-${process.pid}.db`);
delete process.env.SIMLIFE_DATABASE_URL;
const db=await import('./db.js'), activity=await import('./presentation-investing.js');
const {checkInvariant,holdingsFor,sell}=await import('./ledger.js');
const {getClassPost}=await import('./class-posts.js');
const {saveModuleDraft}=await import('./module-drafts.js');
const {studentModuleDetail}=await import('./module-progress.js');
const {MockQuoteProvider,CachedQuotes}=await import('./quotes.js');
const {PRESENTATION_POST_ID}=await import('../shared/presentation-investing.js');
const quotes=new CachedQuotes(new MockQuoteProvider(),0);
let serial=0;
before(async()=>{
 await db.initSchema();
 await db.run(`INSERT INTO users(id,name,role,created_at) VALUES ('pitch-teacher','Teacher','teacher',?)`,[db.nowIso()]);
 await activity.ensurePresentationAssignment();
});
async function fixture(){
 const id=`pitch-${++serial}`;
 await db.run(`INSERT INTO classes(id,name,join_code,created_at) VALUES (?,?,?,?)`,[id,id,id,db.nowIso()]);
 const ids:string[]=[];
 for(let n=0;n<5;n++){const s=`${id}-${n}`;ids.push(s);await db.run(`INSERT INTO users(id,name,role,class_id,created_at) VALUES (?,?,'student',?,?)`,[s,s,id,db.nowIso()]);}
 const companies=['AAPL','MSFT','NVDA','AMZN'].map((ticker,i)=>({ticker,studentId:ids[i]}));
 const config={companies,opensAt:null as string|null,reveal:false};
 await activity.configurePresentation(id,'pitch-teacher',config);
 return {id,ids,config,response:{allocations:[{ticker:'AAPL',cents:20000},{ticker:'MSFT',cents:20000},{ticker:'NVDA',cents:10000}]}};
}
async function open(f:Awaited<ReturnType<typeof fixture>>){f.config.opensAt='2026-01-01T00:00:00Z';await activity.configurePresentation(f.id,'pitch-teacher',f.config);}
test('drafts autosave while locked; future opening and hidden/unpublished modules cannot purchase',async()=>{
 const f=await fixture(),student=f.ids[4];
 const post=(await getClassPost(PRESENTATION_POST_ID))!;
 await saveModuleDraft(post,student,f.response);
 assert.ok((await studentModuleDetail(student)).find(m=>m.id===post.id)?.status==='in_progress');
 await assert.rejects(activity.investPresentation(student,f.response,quotes),/not opened/);
 f.config.opensAt='2099-01-01T00:00:00Z';await activity.configurePresentation(f.id,'pitch-teacher',f.config);
 assert.equal((await activity.presentationState(student)).open,false);
 await assert.rejects(activity.investPresentation(student,f.response,quotes),/not opened/);
 await db.run(`INSERT INTO class_hidden_modules(class_id,module_key) VALUES (?,?)`,[f.id,`post:${post.id}`]);
 await assert.rejects(activity.savePresentationDraft(student,f.response),/not found/);
 await db.run(`DELETE FROM class_hidden_modules WHERE class_id=?`,[f.id]);
 await db.run(`UPDATE class_posts SET status='draft' WHERE id=?`,[post.id]);
 await assert.rejects(activity.investPresentation(student,f.response,quotes),/not found/);
 await db.run(`UPDATE class_posts SET status='published' WHERE id=?`,[post.id]);
 assert.equal(await db.one(`SELECT id FROM accounts WHERE user_id=?`,[student]),undefined);
});
test('server validates budget, own stock, unsupported choices, presenter membership and teacher permissions',async()=>{
 const f=await fixture();await open(f);
 await assert.rejects(activity.configurePresentation(f.id,f.ids[0],f.config),/Teacher access/);
 await assert.rejects(activity.configurePresentation(f.id,'pitch-teacher',{...f.config,companies:[...f.config.companies,{ticker:'KO',studentId:'foreign'}]}),/belong/);
 await assert.rejects(activity.configurePresentation(f.id,'pitch-teacher',{...f.config,companies:[{ticker:'ETHA',studentId:f.ids[0]}]}),/supported stock/);
 await assert.rejects(activity.investPresentation(f.ids[0],f.response,quotes),/other students/);
 await assert.rejects(activity.investPresentation(f.ids[4],{allocations:[{ticker:'KO',cents:20000},{ticker:'MSFT',cents:20000},{ticker:'NVDA',cents:10000}]},quotes),/other students/);
 await assert.rejects(activity.investPresentation(f.ids[4],{allocations:[{ticker:'AAPL',cents:49900}]},quotes),/exactly/);
 assert.throws(()=>activity.cleanPresentationResponse({allocations:[{ticker:'AAPL',cents:NaN}]}),/amounts/);
 assert.throws(()=>activity.cleanPresentationResponse({allocations:[{ticker:'AAPL',cents:100},{ticker:'AAPL',cents:100}]}),/once/);
 await assert.rejects(activity.investPresentation('pitch-teacher',f.response,quotes),/not found/);
});
test('quote failure and mid-transaction failure credit nothing; retry succeeds',async()=>{
 const f=await fixture();await open(f);const student=f.ids[4];
 await assert.rejects(activity.investPresentation(student,f.response,{getQuote:async()=>{throw Error('Quote offline');}}),/Nothing was purchased/);
 assert.equal(await db.one(`SELECT id FROM accounts WHERE user_id=?`,[student]),undefined);
 await db.run(`CREATE TRIGGER fail_pitch_buy BEFORE INSERT ON ledger WHEN NEW.kind='buy' AND NEW.ticker='MSFT' BEGIN SELECT RAISE(ABORT,'Test purchase failed'); END`);
 try {await assert.rejects(activity.investPresentation(student,f.response,quotes),/Test purchase failed/);}finally{await db.run('DROP TRIGGER fail_pitch_buy');}
 assert.equal(await db.one(`SELECT id FROM accounts WHERE user_id=?`,[student]),undefined);
 assert.equal(await db.one(`SELECT user_id FROM presentation_investing_receipts WHERE user_id=?`,[student]),undefined);
 const result=await activity.investPresentation(student,f.response,quotes);assert.equal(result.receipt.purchases.length,3);
 assert.equal((await checkInvariant(student)).ok,true);
});
test('concurrent submits grant once, buy once and retain exact receipt on retry even if quotes later fail',async()=>{
 const f=await fixture();await open(f);const student=f.ids[4];
 await activity.savePresentationDraft(student,f.response);
 const results=await Promise.all([activity.investPresentation(student,f.response,quotes),activity.investPresentation(student,f.response,quotes)]);
 assert.equal(results.filter(r=>r.deduped).length,1);
 const entries=await db.q<any>(`SELECT l.* FROM ledger l JOIN accounts a ON a.id=l.account_id WHERE a.user_id=?`,[student]);
 assert.equal(entries.length,4);assert.equal(entries.filter(e=>e.kind==='cash_adjust')[0].amount_cents,50000);
 assert.equal((await holdingsFor(student,()=>1000)).holdings.length,3);assert.equal((await checkInvariant(student)).ok,true);
 assert.equal(await db.one(`SELECT post_id FROM class_post_drafts WHERE user_id=?`,[student]),undefined);
 const retry=await activity.investPresentation(student,f.response,{getQuote:async()=>{throw Error('No new quote needed');}});assert.deepEqual(retry.receipt,results[0].receipt);
 await assert.rejects(activity.investPresentation(student,{allocations:[]},quotes),/already final/);
 await assert.rejects(activity.savePresentationDraft(student,f.response),/already final/);
 assert.equal((await studentModuleDetail(student)).find(m=>m.id===PRESENTATION_POST_ID)?.status,'submitted');
});
test('freeze and a teacher closing during quote fetch both prevent all purchases',async()=>{
 const f=await fixture();await open(f);const student=f.ids[4];
 await db.run(`UPDATE classes SET trading_frozen=1 WHERE id=?`,[f.id]);
 await assert.rejects(activity.investPresentation(student,f.response,quotes),/paused/);
 await db.run(`UPDATE classes SET trading_frozen=0 WHERE id=?`,[f.id]);
 let closed=false;
 await assert.rejects(activity.investPresentation(student,f.response,{getQuote:async ticker=>{if(!closed){closed=true;await activity.configurePresentation(f.id,'pitch-teacher',{...f.config,opensAt:null});}return quotes.getQuote(ticker);}}),/not opened/);
 assert.equal(await db.one(`SELECT id FROM accounts WHERE user_id=?`,[student]),undefined);
});
test('results are period-specific, hidden until reveal and do not change after selling',async()=>{
 const f=await fixture(),other=await fixture();await open(f);const student=f.ids[4];
 const result=await activity.investPresentation(student,f.response,quotes);
 assert.equal((await activity.presentationState(student)).results,null);
 assert.equal((await activity.teacherPresentationState(other.id)).results.submitted,0);
 f.config.reveal=true;await activity.configurePresentation(f.id,'pitch-teacher',f.config);
 const before=await activity.presentationResults(f.id);
 assert.equal((await activity.presentationState(student)).results?.submitted,1);
 await sell({userId:student,ticker:'AAPL',sellAll:true,priceCents:50000,quoteTs:db.nowIso(),quoteSource:'mock',idempotencyKey:'pitch-sale',tradingFrozen:false});
 assert.deepEqual(await activity.presentationResults(f.id),before);
 assert.equal(before.totals.reduce((s,p)=>s+p.cents,0),result.receipt.spentCents);
 await assert.rejects(activity.configurePresentation(f.id,'pitch-teacher',{...f.config,companies:f.config.companies.slice(0,3)}),/unchanged/);
 // Changing periods must not enable a second grant.
 await db.run(`UPDATE users SET class_id=? WHERE id=?`,[other.id,student]);
 const retried=await activity.investPresentation(student,f.response,quotes);assert.equal(retried.deduped,true);
 assert.equal((await checkInvariant(student)).ok,true);
});
