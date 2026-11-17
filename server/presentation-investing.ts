import { PRESENTATION_POST_ID, PRESENTATION_BUDGET_CENTS, type PresentationResponse } from "../shared/presentation-investing.js";
import { one, q, run, withTx, newId, nowIso, type Tx } from "./db.js";
import { ClassPostError } from "./class-posts.js";
import { loadDirectory, type CachedQuotes } from "./quotes.js";
import { MICRO, costFor } from "./ledger.js";

const fail = (message: string, code: ClassPostError["code"] = "INVALID_INPUT"): never => { throw new ClassPostError(code, message); };
export async function ensurePresentationAssignment() {
  await run(`INSERT INTO class_posts(id,kind,class_id,title,summary,body,spec,hero_url,status,created_at)
    VALUES (?,'presentation_investing',NULL,?,?,?,'{}','/module-art/presentation-investing.svg','published',?) ON CONFLICT(id) DO NOTHING`,
    [PRESENTATION_POST_ID, "Buy or Bye: Class Investment Day", "Listen to the pitches. Divide $500 among at least three presented companies.", "Build one $500 allocation across the presentation week. Your choices autosave. Final submission stays locked until your teacher opens it. Then review and confirm one set of purchases.", nowIso()]);
}
export function cleanPresentationResponse(value: any): PresentationResponse {
  if (!Array.isArray(value?.allocations) || value.allocations.length > 100) fail("Enter an allocation list.");
  const seen = new Set<string>();
  return { allocations: value.allocations.map((a: any) => {
    if (typeof a?.ticker !== "string" || !/^[A-Z]{1,5}(\.[A-Z])?$/.test(a.ticker) || seen.has(a.ticker)) fail("Each ticker must appear once.");
    seen.add(a.ticker);
    if (!Number.isSafeInteger(a.cents) || a.cents < 0 || a.cents > PRESENTATION_BUDGET_CENTS) fail("Use dollar amounts from $0 to $500.");
    return { ticker: a.ticker, cents: a.cents };
  }).sort((a: any,b: any) => a.ticker.localeCompare(b.ticker)) };
}
async function access(t: Pick<Tx,"one">, userId: string) {
  const user = await t.one<any>(`SELECT id,role,class_id FROM users WHERE id=?`,[userId]);
  if (!user || user.role !== "student" || !user.class_id) fail("Assignment not found.","NOT_FOUND");
  const classroom = await t.one<any>(`SELECT * FROM classes WHERE id=?`,[user.class_id]);
  const post = await t.one<any>(`SELECT status FROM class_posts WHERE id=?`,[PRESENTATION_POST_ID]);
  const hidden = await t.one(`SELECT module_key FROM class_hidden_modules WHERE class_id=? AND module_key=?`,[user.class_id,`post:${PRESENTATION_POST_ID}`]);
  if (!classroom || post?.status !== "published" || hidden) fail("Assignment not found.","NOT_FOUND");
  return {user,classroom};
}
async function lockClass(t: Tx, classId: string) {
  if (!await t.one(`SELECT id FROM classes WHERE id=?${t.dialect === "pg" ? " FOR UPDATE" : ""}`,[classId])) fail("Class not found.","NOT_FOUND");
}
async function settings(t: Pick<Tx,"one">, classId: string) {
  const row = await t.one<any>(`SELECT * FROM presentation_investing_settings WHERE class_id=?`,[classId]);
  return { opensAt: row?.opens_at ?? null, reveal: !!row?.reveal, companies: JSON.parse(row?.companies || "[]") as {ticker:string;studentId:string}[], actorId: row?.actor_id };
}
export async function presentationState(userId: string) {
  const {user,classroom}=await access({one},userId), config=await settings({one},user.class_id);
  const roster=await q<any>(`SELECT id,name FROM users WHERE role='student' AND class_id=?`,[user.class_id]);
  const directory=new Map(loadDirectory().map(s=>[s.ticker,s.name]));
  const receipt=await one<any>(`SELECT receipt FROM presentation_investing_receipts WHERE user_id=?`,[userId]);
  return { studentId:userId, budgetCents:PRESENTATION_BUDGET_CENTS, opensAt:config.opensAt,
    open:!!config.opensAt && Date.now()>=Date.parse(config.opensAt) && !classroom.trading_frozen,
    tradingFrozen:!!classroom.trading_frozen,
    companies:config.companies.map(c=>({ticker:c.ticker,name:directory.get(c.ticker)||c.ticker,presenter:roster.find(u=>u.id===c.studentId)?.name||"Class presentation",own:c.studentId===userId})),
    receipt:receipt?JSON.parse(receipt.receipt):null,
    results:config.reveal?await presentationResults(user.class_id):null };
}
export async function savePresentationDraft(userId:string,value:any) {
  const response=cleanPresentationResponse(value);
  return withTx(async t=>{
    const before=await access(t,userId); await lockClass(t,before.user.class_id);
    const {user}=await access(t,userId);
    if(user.class_id!==before.user.class_id) fail("Your period changed. Reopen the assignment.");
    await t.one(`SELECT id FROM users WHERE id=?${t.dialect==='pg'?' FOR UPDATE':''}`,[userId]);
    if(await t.one(`SELECT user_id FROM presentation_investing_receipts WHERE user_id=?`,[userId])) fail("Your purchases are already final.");
    const updatedAt=nowIso();
    // Keep allocations even when the teacher revises the list; review will flag unavailable choices.
    await t.run(`INSERT INTO class_post_drafts(post_id,user_id,response,updated_at) VALUES (?,?,?,?) ON CONFLICT(post_id,user_id) DO UPDATE SET response=excluded.response,updated_at=excluded.updated_at`,[PRESENTATION_POST_ID,userId,JSON.stringify(response),updatedAt]);
    return {response,updatedAt};
  });
}
export async function configurePresentation(classId:string,actorId:string,value:any) {
  if(!await one(`SELECT id FROM users WHERE id=? AND role='teacher'`,[actorId])) fail("Teacher access required.","NOT_FOUND");
  if(!Array.isArray(value?.companies) || value.companies.length>100 || typeof value.reveal!=="boolean") fail("Choose the companies and result visibility.");
  let opensAt:string|null=null;
  if(value.opensAt!=null && value.opensAt!=="") {
    if(typeof value.opensAt!=="string" || !/(Z|[+-]\d\d:\d\d)$/.test(value.opensAt) || !Number.isFinite(Date.parse(value.opensAt))) fail("Choose a valid opening date and time.");
    opensAt=new Date(value.opensAt).toISOString();
  }
  const directory=new Map(loadDirectory().filter(s=>s.kind==='STOCK').map(s=>[s.ticker,s]));
  const tickers=new Set(), students=new Set();
  const companies=value.companies.map((c:any)=>{
    if(!directory.has(c?.ticker) || tickers.has(c.ticker) || typeof c.studentId!=='string' || students.has(c.studentId)) fail("Use a different supported stock and presenter for each entry.");
    tickers.add(c.ticker);students.add(c.studentId);return {ticker:c.ticker,studentId:c.studentId};
  }).sort((a:any,b:any)=>a.ticker.localeCompare(b.ticker));
  return withTx(async t=>{
    await lockClass(t,classId);
    for(const c of companies) if(!await t.one(`SELECT id FROM users WHERE id=? AND role='student' AND class_id=?`,[c.studentId,classId])) fail("Each presenter must belong to this period.");
    const prev=await settings(t,classId);
    if(await t.one(`SELECT user_id FROM presentation_investing_receipts WHERE class_id=?`,[classId]) && JSON.stringify(prev.companies)!==JSON.stringify(companies)) fail("Purchases have begun. Keep this period's company list unchanged.");
    if(opensAt && companies.length<4) fail("Add at least four presentations so everyone has three other companies to choose from.");
    await t.run(`INSERT INTO presentation_investing_settings(class_id,opens_at,reveal,companies,actor_id) VALUES (?,?,?,?,?) ON CONFLICT(class_id) DO UPDATE SET opens_at=excluded.opens_at,reveal=excluded.reveal,companies=excluded.companies,actor_id=excluded.actor_id`,[classId,opensAt,value.reveal?1:0,JSON.stringify(companies),actorId]);
    return {ok:true};
  });
}
export async function presentationResults(classId:string) {
  const rows=await q<any>(`SELECT receipt FROM presentation_investing_receipts WHERE class_id=?`,[classId]);
  const totals=new Map<string,number>();
  for(const row of rows) for(const p of JSON.parse(row.receipt).purchases) totals.set(p.ticker,(totals.get(p.ticker)||0)+p.costCents);
  return {submitted:rows.length,totals:[...totals].map(([ticker,cents])=>({ticker,cents})).sort((a,b)=>b.cents-a.cents||a.ticker.localeCompare(b.ticker))};
}
export async function teacherPresentationState(classId:string) {
  if(!await one(`SELECT id FROM classes WHERE id=?`,[classId])) fail("Class not found.","NOT_FOUND");
  const config=await settings({one},classId);
  const roster=await q<any>(`SELECT id,name FROM users WHERE class_id=? AND role='student' ORDER BY name`,[classId]);
  const rows=await q<any>(`SELECT r.user_id,u.name,r.receipt FROM presentation_investing_receipts r JOIN users u ON u.id=r.user_id WHERE r.class_id=?`,[classId]);
  return {...config,actorId:undefined,roster,results:await presentationResults(classId),receipts:rows.map(r=>({studentId:r.user_id,name:r.name,...JSON.parse(r.receipt)}))};
}
/** Grant and all buys are one transaction. Failed quotes or a failed insert spend/credit nothing. */
export async function investPresentation(userId:string,value:any,quotes:Pick<CachedQuotes,'getQuote'>) {
  const response=cleanPresentationResponse(value), encoded=JSON.stringify(response);
  await access({one},userId);
  const previous=await one<any>(`SELECT response,receipt FROM presentation_investing_receipts WHERE user_id=?`,[userId]);
  if(previous){if(previous.response!==encoded)fail("Your one-time purchases are already final.");return {receipt:JSON.parse(previous.receipt),deduped:true};}
  const selected=response.allocations.filter(a=>a.cents>0);
  if(selected.length<3 || selected.some(a=>a.cents<100) || selected.reduce((n,a)=>n+a.cents,0)!==PRESENTATION_BUDGET_CENTS) fail("Divide exactly $500 among at least three companies, with at least $1 per purchase.");
  // Validate access/choices before requesting quotes; repeat under locks after network work.
  const validate=async(t:Pick<Tx,'one'>)=>{
    const {user,classroom}=await access(t,userId),config=await settings(t,user.class_id);
    if(!config.opensAt || Date.now()<Date.parse(config.opensAt)) fail("Investing has not opened yet. Your allocation can still autosave.","NOT_READY");
    if(classroom.trading_frozen)fail("Trading is paused by your teacher.","NOT_READY");
    for(const a of selected){const company=config.companies.find(c=>c.ticker===a.ticker);if(!company || company.studentId===userId)fail("Choose only other students' presented companies.");}
    return {user,config};
  };
  const initial=await validate({one});
  const purchases=await Promise.all(selected.map(async a=>{
    const {quote}=await quotes.getQuote(a.ticker).catch(()=>fail(`Could not get a quote for ${a.ticker}. Nothing was purchased. Try again.`,"NOT_READY"));
    if(quote.ticker!==a.ticker || !Number.isSafeInteger(quote.priceCents) || quote.priceCents<=0 || !Number.isFinite(Date.parse(quote.asOf)) || !quote.source) fail(`A valid quote is unavailable for ${a.ticker}. Nothing was purchased.`,"NOT_READY");
    const qtyMicro=Math.floor(a.cents*MICRO/quote.priceCents),costCents=costFor(qtyMicro,quote.priceCents);
    if(!Number.isSafeInteger(qtyMicro)||qtyMicro<=0||costCents<=0||costCents>a.cents)fail(`This allocation is too small for ${a.ticker}.`);
    return {ticker:a.ticker,allocatedCents:a.cents,qtyMicro,costCents,priceCents:quote.priceCents,quoteTs:quote.asOf,quoteSource:quote.source};
  }));
  return withTx(async t=>{
    await lockClass(t,initial.user.class_id);
    await t.one(`SELECT id FROM users WHERE id=?${t.dialect==='pg'?' FOR UPDATE':''}`,[userId]);
    const prev=await t.one<any>(`SELECT response,receipt FROM presentation_investing_receipts WHERE user_id=?`,[userId]);
    if(prev){if(prev.response!==encoded)fail("Your one-time purchases are already final.");return {receipt:JSON.parse(prev.receipt),deduped:true};}
    const {user,config}=await validate(t);
    if(user.class_id!==initial.user.class_id)fail("Your period changed. Reopen this assignment.");
    let account=await t.one<any>(`SELECT id,cash_cents FROM accounts WHERE user_id=?${t.dialect==='pg'?' FOR UPDATE':''}`,[userId]);
    if(!account){account={id:newId('acct'),cash_cents:0};await t.run(`INSERT INTO accounts(id,user_id,cash_cents,created_at) VALUES (?,?,0,?)`,[account.id,userId,nowIso()]);}
    const at=nowIso(),key=`presentation:${userId}`;
    await t.run(`INSERT INTO ledger(id,account_id,kind,amount_cents,reason,actor_id,idempotency_key,created_at) VALUES (?,?,'cash_adjust',?,?,?,?,?)`,[newId('le'),account.id,PRESENTATION_BUDGET_CENTS,'Class Investment Day: one-time $500 grant',config.actorId,`${key}:grant`,at]);
    for(const p of purchases) await t.run(`INSERT INTO ledger(id,account_id,kind,amount_cents,ticker,qty_micro,price_cents,reason,idempotency_key,quote_ts,quote_source,created_at) VALUES (?,?,'buy',?,?,?,?,?,?,?,?,?)`,[newId('le'),account.id,-p.costCents,p.ticker,p.qtyMicro,p.priceCents,'Class Investment Day',`${key}:${p.ticker}`,p.quoteTs,p.quoteSource,at]);
    const spentCents=purchases.reduce((s,p)=>s+p.costCents,0),receipt={purchases,grantCents:PRESENTATION_BUDGET_CENTS,spentCents,remainderCents:PRESENTATION_BUDGET_CENTS-spentCents,submittedAt:at};
    await t.run(`UPDATE accounts SET cash_cents=? WHERE id=?`,[account.cash_cents+receipt.remainderCents,account.id]);
    await t.run(`INSERT INTO presentation_investing_receipts(user_id,class_id,response,receipt) VALUES (?,?,?,?)`,[userId,user.class_id,encoded,JSON.stringify(receipt)]);
    await t.run(`INSERT INTO class_post_submissions(id,post_id,user_id,response,evidence,idempotency_key,created_at) VALUES (?,?,?,?,?,?,?)`,[newId('csub'),PRESENTATION_POST_ID,userId,encoded,JSON.stringify(receipt),`${key}:submit`,at]);
    await t.run(`DELETE FROM class_post_drafts WHERE post_id=? AND user_id=?`,[PRESENTATION_POST_ID,userId]);
    return {receipt,deduped:false};
  });
}
