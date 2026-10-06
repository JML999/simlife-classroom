import "./env.js";
import os from "node:os";
import path from "node:path";
import { before, test } from "node:test";
import assert from "node:assert/strict";
process.env.SIMLIFE_DB_PATH = path.join(os.tmpdir(), `simlife-college-${process.pid}.db`);
delete process.env.SIMLIFE_DATABASE_URL;
const db = await import("./db.js");
const college = await import("./college.js");
const posts = await import("./class-posts.js");
const modules = await import("./class-modules.js");
const progress = await import("./module-progress.js");
const id = "cpost_college_paths_v1";
const shared = await import("../shared/college-research.js");
const response = shared.emptyCollegeResearch();
for (const route of response.routes) {
  for (const topic of shared.COLLEGE_RESEARCH_TOPICS) route.research[topic.id] = {program: "Research example", figure: "$50,000 overall median pay, 2025 / employment measure", source: "https://www.bls.gov/ooh/"};
  for (const program of route.programs) for (const [key] of shared.COLLEGE_PROGRAM_FIELDS) program[key] = `Researched ${key}`;
}
response.reflection = "I would consider two routes based on their pay, tuition, training and fit.";

before(async () => {
  await db.initSchema();
  for (const c of ["college-class", "other-class"]) await db.run(`INSERT INTO classes (id,name,join_code,created_at) VALUES (?,?,?,?)`, [c,c,c,db.nowIso()]);
  for (const [u, role, c] of [["student-a","student","college-class"],["student-b","student","other-class"],["teacher","teacher",null]]) await db.run(`INSERT INTO users (id,name,role,class_id,created_at) VALUES (?,?,?,?,?)`,[u,u,role,c,db.nowIso()]);
  await college.ensureCollegeAssignment();
});
test("college has its own numbering and boot preserves teacher edits", async () => {
  const post = (await posts.getClassPost(id))!;
  const mission = await posts.createClassPost({kind:"portfolio_mission",title:"Investing",body:"Buy stocks"});
  await posts.setClassPostStatus(mission.id,"published");
  const catalog = await modules.classModuleCatalog("college-class");
  assert.equal(catalog.find(m => m.id === id)?.moduleNumber,1);
  assert.equal(catalog.find(m => m.id === id)?.container,"college");
  assert.equal(catalog.find(m => m.id === mission.id)?.moduleNumber,1);
  await db.run(`UPDATE class_posts SET title = ? WHERE id = ?`,["Teacher title",id]);
  await college.ensureCollegeAssignment();
  assert.equal((await posts.getClassPost(id))?.title,"Teacher title");
  await db.run(`UPDATE class_posts SET title = ? WHERE id = ?`,[post.title,id]);
  // Keep this test's portfolio fixture out of the college progress checks.
  await posts.setClassPostStatus(mission.id,"archived");
});
test("incomplete drafts are private, trimmed and appear in teacher progress", async () => {
  const post = (await posts.getClassPost(id))!;
  const draft = shared.emptyCollegeResearch(); draft.routes[0].programs[0].program = "  Nursing  ";
  await college.saveCollegeDraft(post,"student-a",draft);
  assert.equal((await college.collegeDraftFor(id,"student-a"))?.response.routes[0].programs[0].program,"Nursing");
  assert.equal(await college.collegeDraftFor(id,"student-b"),null);
  const detail = (await progress.studentModuleDetail("student-a"))[0];
  assert.equal(detail.status,"in_progress"); assert.equal(detail.partsDone,0); assert.equal(detail.partsTotal,5);
  assert.equal((await progress.moduleProgress("college-class")).students["student-a"].started,1);
  await assert.rejects(college.submitCollegePaths({post,userId:"student-a",response:shared.emptyCollegeResearch()}),/Finish the research/);
});
test("four-route submission needs no holdings and retries safely", async () => {
  const post = (await posts.getClassPost(id))!;
  assert.equal((await college.submitCollegePaths({post,userId:"student-a",response,idempotencyKey:"college-submit"})).deduped,false);
  assert.equal((await college.submitCollegePaths({post,userId:"student-a",response,idempotencyKey:"college-submit"})).deduped,true);
  assert.equal(await college.collegeDraftFor(id,"student-a"),null);
  const detail = (await progress.studentModuleDetail("student-a"))[0];
  assert.equal(detail.status,"submitted"); assert.equal(detail.partsDone,5);
  assert.deepEqual(detail.detail?.response,response);
  await assert.rejects(college.submitCollegePaths({post,userId:"student-b",response,idempotencyKey:"college-submit"}),/already used/);
  await assert.rejects(college.submitCollegePaths({post,userId:"student-a",response:{...response,reflection:"Changed"},idempotencyKey:"college-submit"}),/already used/);
  await college.submitCollegePaths({post,userId:"student-a",response:{...response,reflection:"Changed"},idempotencyKey:"college-revise"});
  assert.equal((await posts.latestClassPostSubmission(id,"student-a"))?.response.reflection,"Changed");
});
test("visibility, class scope, role and status enforce access without deleting work", async () => {
  const post = (await posts.getClassPost(id))!;
  await modules.replaceHiddenClassModules("college-class",[`post:${id}`]);
  await assert.rejects(college.saveCollegeDraft(post,"student-a",response),/not found/);
  assert.equal((await progress.studentModuleDetail("student-a")).length,0);
  await college.saveCollegeDraft(post,"student-b",response);
  await modules.replaceHiddenClassModules("college-class",[]);
  assert.equal((await progress.studentModuleDetail("student-a"))[0].status,"submitted");
  await assert.rejects(college.saveCollegeDraft(post,"teacher",response),/not found/);
  await assert.rejects(college.saveCollegeDraft({...post,classId:"other-class"},"student-a",response),/not found/);
  await assert.rejects(college.saveCollegeDraft({...post,status:"archived"},"student-a",response),/not found/);
  const bad = structuredClone(response); bad.routes[0].institution = "anything";
  assert.throws(() => college.cleanCollegeResponse(bad),/Choose the listed/);
  assert.throws(() => college.cleanCollegeResponse({paths:[{name:42}]}),/must be text/);
});

test("Other requires a name, every route needs evidence, and prior work survives", async () => {
  const post = (await posts.getClassPost(id))!;
  const other = structuredClone(response); other.routes[0].institution = "other";
  await assert.rejects(college.submitCollegePaths({post,userId:"student-b",response:other}),/Finish the research/);
  other.routes[0].otherInstitution = "My university";
  other.routes[3].research.weakEmployment.source = "";
  await assert.rejects(college.submitCollegePaths({post,userId:"student-b",response:other}),/Finish the research/);
  other.routes[3].research.weakEmployment.source = "https://www.bls.gov/ooh/";
  other.previousWork = {paths:[{name:"Earlier option"}],leaning:"",reason:"",nextStep:""};
  await college.saveCollegeDraft(post,"student-b",other);
  assert.equal((await college.collegeDraftFor(id,"student-b"))?.response.previousWork.paths[0].name,"Earlier option");
  await college.submitCollegePaths({post,userId:"student-b",response:other,idempotencyKey:"other-school-submit"});
  await assert.rejects(college.submitCollegePaths({post,userId:"student-b",response:{paths:[]}}),/has been revised/);
});
test("earlier submissions remain reviewable without completing the revised assignment", async () => {
  await db.run(`INSERT INTO users (id,name,role,class_id,created_at) VALUES ('student-legacy','Earlier Student','student','college-class',?)`,[db.nowIso()]);
  const legacy = {paths:[{name:"Original choice"}],leaning:"undecided",reason:"Original reason",nextStep:"Original step"};
  await db.run(`INSERT INTO class_post_submissions (id,post_id,user_id,response,evidence,created_at) VALUES ('legacy-sub',?,'student-legacy',?,'{}',?)`,[id,JSON.stringify(legacy),db.nowIso()]);
  const detail = (await progress.studentModuleDetail("student-legacy"))[0];
  assert.equal(detail.status,"in_progress"); assert.equal(detail.partsDone,0); assert.equal(detail.partsTotal,5);
  assert.deepEqual(detail.detail?.response,legacy); assert.ok(detail.detail?.earlierSubmittedAt);
  assert.equal(detail.detail?.submittedAt,null);
  const roster = (await progress.moduleProgress("college-class")).students["student-legacy"];
  assert.equal(roster.started,1); assert.equal(roster.completed,0);
});
test("brief migrates once without changing visibility or losing earlier submissions", async () => {
  await db.run(`UPDATE class_posts SET spec = '{}', status = 'draft', title = 'Teacher custom title' WHERE id = ?`,[id]);
  const before = await posts.latestClassPostSubmission(id,"student-a");
  await college.ensureCollegeAssignment();
  const migrated = (await posts.getClassPost(id))!;
  assert.equal(migrated.title,"Teacher custom title"); assert.equal(migrated.status,"draft"); assert.equal(migrated.spec.responseVersion,2);
  assert.match(migrated.body,/tuition/);
  assert.deepEqual(await posts.latestClassPostSubmission(id,"student-a"),before);
  await db.run(`UPDATE class_posts SET body = 'Teacher edited brief' WHERE id = ?`,[id]);
  await college.ensureCollegeAssignment();
  assert.equal((await posts.getClassPost(id))?.body,"Teacher edited brief");
});
