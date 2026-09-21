/**
 * Sector sort tests. The important ones: grading reads the ticker directory
 * rather than a stored key, an unclassifiable ticker is excluded from the score
 * instead of counted wrong, and a student cannot invent a bucket.
 * Run: npm test
 */
import "./env.js";
import os from "node:os";
import path from "node:path";
import { test, before } from "node:test";
import assert from "node:assert";

process.env["SIMLIFE_DB_PATH"] = path.join(os.tmpdir(), `simlife-sorting-test-${process.pid}.db`);
delete process.env["SIMLIFE_DATABASE_URL"];

const { initSchema, run } = await import("./db.js");
const s = await import("./sorting.js");

let n = 0;
const uid = () => `t_sort_${process.pid}_${++n}`;

before(async () => {
  await initSchema();
  await run(`INSERT INTO classes (id, name, join_code, trading_frozen, created_at) VALUES (?, ?, ?, ?, ?)`,
    ["sclass", "Sort Period", "SORT1", 0, new Date().toISOString()]);
});

async function student(): Promise<string> {
  const id = uid();
  await run(`INSERT INTO users (id, email, name, role, class_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, `${id}@example.school`, "Stu", "student", "sclass", new Date().toISOString()]);
  return id;
}

const BUCKETS = ["Consumer Discretionary", "Information Technology", "Consumer Staples"];
async function activity(tokens = ["NKE", "AAPL", "KO"], status = "published") {
  return s.createActivity({
    classId: null, title: `Sort ${uid()}`, prompt: "Sort them.",
    buckets: BUCKETS, tokens: tokens.map((ticker) => ({ ticker })), status,
  });
}

test("the directory supplies the answers, not the activity", () => {
  // These come from ticker-directory.json; nothing in the activity stores them.
  assert.equal(s.sectorOf("NKE"), "Consumer Discretionary");
  assert.equal(s.sectorOf("AAPL"), "Information Technology");
  assert.equal(s.sectorOf("KO"), "Consumer Staples");
  assert.equal(s.sectorOf("NOTATICKER"), null);
});

test("grading counts only what it can check", () => {
  const tokens = [{ ticker: "NKE" }, { ticker: "AAPL" }];
  const g = s.grade(tokens, { NKE: "Consumer Discretionary", AAPL: "Consumer Staples" });
  assert.equal(g.correctCount, 1);
  assert.equal(g.totalCount, 2);
  assert.equal(g.results.find((r) => r.ticker === "NKE")!.correct, true);
  assert.equal(g.results.find((r) => r.ticker === "AAPL")!.correct, false);
});

test("a ticker the directory cannot classify is excluded, never marked wrong", () => {
  const g = s.grade([{ ticker: "NKE" }, { ticker: "ZZZZ" }], { NKE: "Consumer Discretionary", ZZZZ: "Consumer Staples" });
  assert.equal(g.totalCount, 1, "the unknown ticker is not part of the score");
  assert.equal(g.correctCount, 1);
  assert.deepEqual(g.unknownTickers, ["ZZZZ"]);
  const z = g.results.find((r) => r.ticker === "ZZZZ")!;
  assert.equal(z.unknown, true, "and it is reported as unknown so the gap is visible");
});

test("an unplaced ticker is simply not correct", () => {
  const g = s.grade([{ ticker: "NKE" }], {});
  assert.equal(g.correctCount, 0);
  assert.equal(g.totalCount, 1);
  assert.equal(g.results[0]!.placed, null);
});

test("submitting records an attempt and scores it", async () => {
  const act = await activity();
  const stu = await student();
  const r = await s.submit({ activityId: act.id, userId: stu, placements: {
    NKE: "Consumer Discretionary", AAPL: "Information Technology", KO: "Consumer Staples" } });
  assert.equal(r.attemptNo, 1);
  assert.equal(r.correctCount, 3);
  assert.equal(r.totalCount, 3);
});

test("retries are kept as separate attempts", async () => {
  const act = await activity();
  const stu = await student();
  await s.submit({ activityId: act.id, userId: stu, placements: { NKE: "Consumer Staples" } });
  const second = await s.submit({ activityId: act.id, userId: stu, placements: {
    NKE: "Consumer Discretionary", AAPL: "Information Technology", KO: "Consumer Staples" } });
  assert.equal(second.attemptNo, 2);
  const attempts = await s.attemptsFor(act.id, stu);
  assert.equal(attempts.length, 2, "the first attempt is not overwritten");
  assert.equal(attempts[0].attempt_no, 2, "newest first");
});

test("a repeated submission with the same key does not create a second attempt", async () => {
  const act = await activity();
  const stu = await student();
  const key = uid();
  const a = await s.submit({ activityId: act.id, userId: stu, placements: { NKE: "Consumer Discretionary" }, idempotencyKey: key });
  const b = await s.submit({ activityId: act.id, userId: stu, placements: { NKE: "Consumer Discretionary" }, idempotencyKey: key });
  assert.equal(b.deduped, true);
  assert.equal(a.attemptNo, b.attemptNo);
  assert.equal((await s.attemptsFor(act.id, stu)).length, 1);
});

test("a bucket the activity did not define is discarded", async () => {
  const act = await activity();
  const stu = await student();
  const r = await s.submit({ activityId: act.id, userId: stu, placements: {
    NKE: "Not A Real Bucket", AAPL: "Information Technology" } });
  assert.equal(r.correctCount, 1, "the invented bucket cannot score");
  const nke = r.results.find((x) => x.ticker === "NKE")!;
  assert.equal(nke.placed, null, "it was dropped rather than stored");
});

test("an unpublished activity cannot be submitted to", async () => {
  const act = await activity(["NKE", "AAPL"], "draft");
  const stu = await student();
  await assert.rejects(
    () => s.submit({ activityId: act.id, userId: stu, placements: { NKE: "Consumer Discretionary" } }),
    (err: any) => err instanceof s.SortError && err.code === "NOT_FOUND",
  );
});

test("teacher progress reports best attempt per student", async () => {
  const act = await activity();
  const a = await student();
  const b = await student();
  await s.submit({ activityId: act.id, userId: a, placements: { NKE: "Consumer Staples" } });
  await s.submit({ activityId: act.id, userId: a, placements: {
    NKE: "Consumer Discretionary", AAPL: "Information Technology", KO: "Consumer Staples" } });
  await s.submit({ activityId: act.id, userId: b, placements: { NKE: "Consumer Discretionary" } });
  const rows = await s.progressFor(act.id, "sclass");
  const ra = rows.find((r) => r.userId === a)!;
  assert.equal(ra.attempts, 2);
  assert.equal(ra.bestCorrect, 3, "best, not latest");
  const rb = rows.find((r) => r.userId === b)!;
  assert.equal(rb.bestCorrect, 1);
  assert.ok(rows.every((r) => r.attempts >= 0));
});

test("the miss list surfaces what the class got wrong and where they put it", async () => {
  const act = await activity();
  for (let i = 0; i < 3; i++) {
    const stu = await student();
    // Everyone files AAPL under Consumer Discretionary.
    await s.submit({ activityId: act.id, userId: stu, placements: {
      NKE: "Consumer Discretionary", AAPL: "Consumer Discretionary", KO: "Consumer Staples" } });
  }
  const misses = await s.missesFor(act.id, "sclass");
  const aapl = misses.find((m) => m.ticker === "AAPL")!;
  assert.equal(aapl.wrong, 3);
  assert.equal(aapl.commonWrongBucket, "Consumer Discretionary", "tells the teacher the misconception, not just the miss");
  assert.equal(misses[0]!.ticker, "AAPL", "worst first");
});

test("an activity needs buckets and tickers", async () => {
  await assert.rejects(() => s.createActivity({ title: "x", prompt: "", buckets: ["a"], tokens: [{ ticker: "NKE" }] }));
  await assert.rejects(() => s.createActivity({ title: "", prompt: "", buckets: BUCKETS, tokens: [{ ticker: "NKE" }] }));
});

test("a draft saves partial progress and is not a submission", async () => {
  const act = await activity();
  const stu = await student();
  const d = await s.saveDraft({ activityId: act.id, userId: stu, placements: { NKE: "Consumer Discretionary" } });
  assert.deepEqual(d.placements, { NKE: "Consumer Discretionary" });
  assert.equal((await s.attemptsFor(act.id, stu)).length, 0, "saving is not submitting");
  const back = await s.draftFor(act.id, stu);
  assert.deepEqual(back!.placements, { NKE: "Consumer Discretionary" });
});

test("a draft drops invented buckets and is cleared by submit", async () => {
  const act = await activity();
  const stu = await student();
  await s.saveDraft({ activityId: act.id, userId: stu, placements: { NKE: "Not A Real Bucket" } });
  assert.deepEqual((await s.draftFor(act.id, stu))!.placements, {}, "invented bucket dropped");
  await s.saveDraft({ activityId: act.id, userId: stu, placements: { NKE: "Consumer Discretionary" } });
  await s.submit({ activityId: act.id, userId: stu, placements: {
    NKE: "Consumer Discretionary", AAPL: "Information Technology", KO: "Consumer Staples" } });
  assert.equal(await s.draftFor(act.id, stu), null, "submit supersedes the draft");
});
