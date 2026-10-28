import "./env.js";
import os from "node:os";
import path from "node:path";
import { before, test } from "node:test";
import assert from "node:assert/strict";
process.env.SIMLIFE_DB_PATH=path.join(os.tmpdir(),`simlife-bonds-${process.pid}.db`);
delete process.env.SIMLIFE_DATABASE_URL;
const db=await import("./db.js"), bonds=await import("./bonds.js"), posts=await import("./class-posts.js"), modules=await import("./class-modules.js");
const progress=await import("./module-progress.js"), drafts=await import("./module-drafts.js"), shared=await import("../shared/bonds.js"), quotes=await import("./quotes.js");
const post=()=>posts.getClassPost(shared.BOND_POST_ID).then(p=>p!);
before(async()=>{
  await db.initSchema();
  for(const id of ["bond-class","other-class"])await db.run(`INSERT INTO classes(id,name,join_code,created_at) VALUES (?,?,?,?)`,[id,id,id,db.nowIso()]);
  for(const [id,role] of [["bond-a","student"],["bond-b","student"],["bond-teacher","teacher"]])await db.run(`INSERT INTO users(id,name,role,class_id,created_at) VALUES (?,?,?,'bond-class',?)`,[id,id,role,db.nowIso()]);
  await db.run(`INSERT INTO accounts(id,user_id,cash_cents,created_at) VALUES ('bond-account','bond-a',0,?)`,[db.nowIso()]);
  await bonds.ensureBondAssignment();
});
test("bond module belongs to Investing, preserves teacher settings, and shortlist is searchable",async()=>{
  const row=(await modules.classModuleCatalog("bond-class")).find(x=>x.id===shared.BOND_POST_ID)!;
  assert.equal(row.container,"investing");assert.equal(row.postKind,"bond_mission");
  await db.run(`UPDATE class_posts SET summary='Teacher wording' WHERE id=?`,[row.id]);await bonds.ensureBondAssignment();assert.equal((await post()).summary,"Teacher wording");
  for(const fund of shared.BOND_PRODUCTS){const security=quotes.searchDirectory(fund.ticker).find(f=>f.ticker===fund.ticker);assert.equal(security?.assetClass,"BOND");assert.equal(security?.kind,"ETF");}
});
test("drafts and blank submissions save without a bond or correct answers",async()=>{
  const p=await post();await drafts.saveModuleDraft(p,"bond-b",{answers:{lender:"0"},explanation:"A brief answer"});
  let detail=(await progress.studentModuleDetail("bond-b"))[0];assert.equal(detail.status,"in_progress");assert.equal(detail.detail?.response.explanation,"A brief answer");
  await bonds.submitBondMission({post:p,userId:"bond-b",response:{},idempotencyKey:"blank-bond"});
  const saved=await posts.latestClassPostSubmission(p.id,"bond-b");assert.equal(saved.evidence.met,false);assert.equal(saved.evidence.answered,0);assert.equal(saved.evidence.correct,0);
  assert.equal(await(await import("./college.js")).collegeDraftFor(p.id,"bond-b"),null);
  assert.equal((await progress.studentModuleDetail("bond-b"))[0].status,"submitted");
});
test("current ledger holdings qualify, sales remove them, submitted evidence stays frozen",async()=>{
  const p=await post();
  for(const [i,ticker]of ["BND","TLT","AGG","BNDX","IEF","SGOV","LQD","AAPL","VOO","ETHA"].entries())await db.run(`INSERT INTO ledger(id,account_id,kind,amount_cents,ticker,qty_micro,price_cents,created_at) VALUES (?,'bond-account','buy',-1000,?,1000000,1000,?)`,[`bond-buy-${i}`,ticker,`2026-10-28T10:${String(i).padStart(2,"0")}:00Z`]);
  let state=await bonds.bondMissionState(p,"bond-a");assert.equal(state.bonds.length,7);assert.ok(!state.bonds.some(b=>b.ticker==="VOO"));
  const response={answers:Object.fromEntries(shared.BOND_QUESTIONS.map(q=>[q.id,String(q.answer)])),ticker:"SGOV",explanation:"Very short Treasury bills add a different asset. Income can fall as rates fall."};
  await bonds.submitBondMission({post:p,userId:"bond-a",response,idempotencyKey:"complete-bond"});
  assert.equal((await posts.latestClassPostSubmission(p.id,"bond-a")).evidence.correct,5);
  await db.run(`INSERT INTO ledger(id,account_id,kind,amount_cents,ticker,qty_micro,price_cents,created_at) VALUES ('bond-sold','bond-account','sell',1000,'SGOV',-1000000,1000,'2026-10-28T11:00:00Z')`);
  state=await bonds.bondMissionState(p,"bond-a");assert.equal(state.bonds.length,6);assert.ok(!state.bonds.some(b=>b.ticker==="SGOV"));
  const detail=(await progress.studentModuleDetail("bond-a"))[0];assert.equal(detail.detail?.evidence.selectedHeld,true);assert.ok(!detail.detail?.liveBonds.some((b:any)=>b.ticker==="SGOV"));
});
test("student cannot invent ownership or a score, retries are scoped to student and answers",async()=>{
  const p=await post(),response={answers:{lender:"1"},ticker:"BND",explanation:"",correct:5,bonds:[{ticker:"BND"}]};
  await bonds.submitBondMission({post:p,userId:"bond-b",response,idempotencyKey:"forged-bond"});
  const evidence=(await posts.latestClassPostSubmission(p.id,"bond-b")).evidence;assert.equal(evidence.correct,0);assert.equal(evidence.selectedHeld,false);assert.equal(evidence.met,false);
  assert.equal((await bonds.submitBondMission({post:p,userId:"bond-b",response,idempotencyKey:"forged-bond"})).deduped,true);
  await assert.rejects(bonds.submitBondMission({post:p,userId:"bond-a",response,idempotencyKey:"forged-bond"}),/already used/);
  await assert.rejects(bonds.submitBondMission({post:p,userId:"bond-b",response:{...response,explanation:"Changed"},idempotencyKey:"forged-bond"}),/already used/);
  assert.throws(()=>bonds.cleanBondResponse({answers:{rates:"999"}}),/listed answers/);
  assert.throws(()=>bonds.cleanBondResponse({explanation:{bad:true}}),/must be text/);
});
test("teacher, hidden, unpublished and other-class assignments reject student writes",async()=>{
  const p=await post();await assert.rejects(bonds.saveBondDraft(p,"bond-teacher",{}),/not found/);
  await assert.rejects(bonds.submitBondMission({post:{...p,classId:"other-class"},userId:"bond-a",response:{}}),/not found/);
  await modules.replaceHiddenClassModules("bond-class",[modules.classModuleKey("post",p.id)]);
  await assert.rejects(bonds.saveBondDraft(p,"bond-a",{}),/not found/);
  await assert.rejects(bonds.submitBondMission({post:p,userId:"bond-a",response:{}}),/not found/);
  assert.equal((await progress.moduleProgress("bond-class")).modules.length,0);
  await modules.replaceHiddenClassModules("bond-class",[]);
  await assert.rejects(bonds.saveBondDraft({...p,status:"draft"},"bond-a",{}),/not found/);
});
