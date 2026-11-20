import "./env.js";
import os from "node:os";
import path from "node:path";
import { before, test } from "node:test";
import assert from "node:assert";

process.env["SIMLIFE_DB_PATH"] = path.join(os.tmpdir(), `simlife-class-modules-${process.pid}.db`);
delete process.env["SIMLIFE_DATABASE_URL"];

const db = await import("./db.js");
const sorting = await import("./sorting.js");
const posts = await import("./class-posts.js");
const modules = await import("./class-modules.js");

before(async () => {
  await db.initSchema();
  const now = new Date().toISOString();
  await db.run(`INSERT INTO classes (id, name, join_code, trading_frozen, created_at) VALUES (?, ?, ?, 0, ?)`, ["module-class", "Module Class", "MOD1", now]);
  await db.run(`INSERT INTO classes (id, name, join_code, trading_frozen, created_at) VALUES (?, ?, ?, 0, ?)`, ["module-other", "Other Class", "MOD2", now]);
});

test("published assignments get stable chronological module numbers", async () => {
  const sort = await sorting.createActivity({
    title: "Sector foundations", prompt: "Sort them.", status: "published",
    buckets: ["Consumer Discretionary", "Information Technology"], tokens: [{ ticker: "NKE" }, { ticker: "AAPL" }],
  });
  await db.run(`UPDATE sort_activities SET created_at = ? WHERE id = ?`, ["2026-09-01T00:00:00.000Z", sort.id]);
  const mission = await posts.createClassPost({ kind: "portfolio_mission", title: "Balanced portfolio", body: "Research and explain." });
  await posts.setClassPostStatus(mission.id, "published");
  await db.run(`UPDATE class_posts SET created_at = ? WHERE id = ?`, ["2026-09-02T00:00:00.000Z", mission.id]);
  const catalog = await modules.classModuleCatalog("module-class");
  assert.deepEqual(catalog.map((item) => [item.key, item.moduleNumber]), [
    [`sort:${sort.id}`, 1], [`post:${mission.id}`, 2],
  ]);
  const etf = await posts.createClassPost({ kind: "etf_mission", title: "ETF assignment", body: "Compare two funds." });
  assert.equal((await modules.classModuleCatalog("module-class")).some((item) => item.id === etf.id), false);
  await posts.setClassPostStatus(etf.id, "published");
  const publishedEtf = (await modules.classModuleCatalog("module-class")).find((item) => item.id === etf.id);
  assert.deepEqual([publishedEtf?.moduleNumber, publishedEtf?.postKind], [3, "etf_mission"]);
});

test("hidden modules are class-specific and replacement rejects junk keys", async () => {
  const catalog = await modules.classModuleCatalog("module-class");
  const moduleTwo = catalog[1]!.key;
  const saved = await modules.replaceHiddenClassModules("module-class", [moduleTwo, moduleTwo, "post:not-real"]);
  assert.deepEqual(saved, [moduleTwo]);
  assert.deepEqual([...(await modules.hiddenClassModuleKeys("module-class"))], [moduleTwo]);
  assert.equal((await modules.hiddenClassModuleKeys("module-other")).size, 0);
  await modules.replaceHiddenClassModules("module-class", []);
  assert.equal((await modules.hiddenClassModuleKeys("module-class")).size, 0);
});

test("batched roster progress agrees with individual details for drafts, prior revisions, sales and fund types", async () => {
  const progress = await import("./module-progress.js");
  const now=db.nowIso(),classId="batch-progress-class";
  await db.run(`INSERT INTO classes(id,name,join_code,created_at) VALUES (?,?,?,?)`,[classId,"Batch progress","BATCH",now]);
  for(const id of ["batch-empty","batch-held","batch-sold","batch-crypto"]){
    await db.run(`INSERT INTO users(id,name,role,class_id,created_at) VALUES (?,?,'student',?,?)`,[id,id,classId,now]);
    await db.run(`INSERT INTO accounts(id,user_id,cash_cents,created_at) VALUES (?,?,0,?)`,[`acct-${id}`,id,now]);
  }
  for(const [id,kind,spec]of [["batch-stock","portfolio_mission",{}],["batch-fund","etf_mission",{}],["batch-bond","bond_mission",{}],["batch-college","college_pathways",{responseVersion:2}] ] as const){
    await db.run(`INSERT INTO class_posts(id,kind,class_id,title,summary,body,spec,status,created_at) VALUES (?,?,?,?,'','',?,'published',?)`,[id,kind,classId,id,JSON.stringify(spec),now]);
  }
  for(const [id,ticker]of [["batch-held","AAPL"],["batch-held","VOO"],["batch-held","BND"],["batch-sold","AAPL"],["batch-sold","BND"],["batch-crypto","ETHA"]]){
    await db.run(`INSERT INTO ledger(id,account_id,kind,amount_cents,ticker,qty_micro,price_cents,created_at) VALUES (?,?,'buy',-100,?,1000000,100,?)`,[`${id}-${ticker}`,`acct-${id}`,ticker,now]);
    if(id==="batch-sold")await db.run(`INSERT INTO ledger(id,account_id,kind,amount_cents,ticker,qty_micro,price_cents,created_at) VALUES (?,?,'sell',100,?,-1000000,100,?)`,[`${id}-${ticker}-sell`,`acct-${id}`,ticker,now]);
  }
  await db.run(`INSERT INTO class_post_drafts(post_id,user_id,response,updated_at) VALUES ('batch-bond','batch-empty','{}',?)`,[now]);
  await db.run(`INSERT INTO class_post_submissions(id,post_id,user_id,response,evidence,created_at) VALUES ('batch-prior','batch-college','batch-held','{"version":1}','{}',?)`,[now]);
  await db.run(`INSERT INTO class_post_submissions(id,post_id,user_id,response,evidence,created_at) VALUES ('batch-sub','batch-stock','batch-sold','{}','{}',?)`,[now]);
  const check=async()=>{
    const batch=await progress.moduleProgress(classId);
    for(const id of ["batch-empty","batch-held","batch-sold","batch-crypto"]){
      const details=await progress.studentModuleDetail(id);
      assert.deepEqual(batch.students[id],{assigned:details.length,started:details.filter(m=>m.status!=="not_started").length,completed:details.filter(m=>m.status==="submitted").length});
    }
    assert.equal(batch.students['batch-sold'].completed,1,"submitted work stays complete after a full sale");
    assert.equal(batch.students['batch-held'].completed,0,"old research revision is started, not submitted for the new version");
  };
  await check();
  await modules.replaceHiddenClassModules(classId,["post:batch-fund"]);
  await check();
  const combined=await progress.moduleProgress(null),single=await progress.moduleProgress(classId);
  assert.deepEqual(combined.students['batch-held'],single.students['batch-held']);
});
