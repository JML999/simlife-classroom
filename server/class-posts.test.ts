import "./env.js";
import os from "node:os";
import path from "node:path";
import { before, test } from "node:test";
import assert from "node:assert";

process.env["SIMLIFE_DB_PATH"] = path.join(os.tmpdir(), `simlife-class-posts-${process.pid}.db`);
delete process.env["SIMLIFE_DATABASE_URL"];

const db = await import("./db.js");
const posts = await import("./class-posts.js");

const STUDENT = "post-student";
before(async () => {
  await db.initSchema();
  const now = new Date().toISOString();
  await db.run(`INSERT INTO classes (id, name, join_code, trading_frozen, created_at) VALUES (?, ?, ?, 0, ?)`, ["post-class", "Post Class", "POST1", now]);
  await db.run(`INSERT INTO classes (id, name, join_code, trading_frozen, created_at) VALUES (?, ?, ?, 0, ?)`, ["other-post-class", "Other", "POST2", now]);
  await db.run(`INSERT INTO users (id, name, role, class_id, created_at) VALUES (?, ?, 'student', ?, ?)`, [STUDENT, "Mission Student", "post-class", now]);
  await db.run(`INSERT INTO accounts (id, user_id, cash_cents, created_at) VALUES (?, ?, 0, ?)`, ["post-account", STUDENT, now]);
});

async function addHolding(ticker: string, order: number) {
  await db.run(
    `INSERT INTO ledger (id, account_id, kind, amount_cents, ticker, qty_micro, price_cents, idempotency_key, created_at)
     VALUES (?, 'post-account', 'buy', -1000, ?, 1000000, 1000, ?, ?)`,
    [`post-ledger-${order}`, ticker, `post-key-${order}`, `2026-09-21T12:${String(order).padStart(2, "0")}:00.000Z`],
  );
}

test("announcements and missions respect class scope", async () => {
  const global = await posts.createClassPost({ kind: "announcement", title: "Global note", body: "Bring your research." });
  const ours = await posts.createClassPost({ kind: "announcement", classId: "post-class", title: "Our note", body: "Third period only." });
  const other = await posts.createClassPost({ kind: "announcement", classId: "other-post-class", title: "Other note", body: "Other class." });
  await Promise.all([global, ours, other].map((post) => posts.setClassPostStatus(post.id, "published")));
  const visible = await posts.listClassPosts({ classId: "post-class", publishedOnly: true });
  assert.ok(visible.some((post) => post.id === global.id));
  assert.ok(visible.some((post) => post.id === ours.id));
  assert.ok(!visible.some((post) => post.id === other.id));
});

test("portfolio mission uses only current stock and sector totals", async () => {
  for (const [i, ticker] of ["NKE", "AAPL", "KO", "JNJ", "JPM", "NEE"].entries()) await addHolding(ticker, i);
  const mission = await posts.createClassPost({
    kind: "portfolio_mission", classId: "post-class", title: "Build five sectors",
    summary: "Six companies across five sectors.", body: "Research, buy, explain.",
  });
  await posts.setClassPostStatus(mission.id, "published");
  mission.status = "published";
  const state = await posts.portfolioMissionState(mission, STUDENT);
  assert.equal(state.counts.companies, 6);
  assert.equal(state.counts.sectors, 6);
  assert.deepEqual(state.checks, { companies: true, sectors: true });
  assert.equal(state.met, true);

  const response = {
    picks: [
      { ticker: "NKE", thesis: "Nike sells consumer products, so its demand can vary with household spending and changing fashion preferences." },
      { ticker: "JPM", thesis: "A bank earns from lending and financial services and responds to rates, credit, and business activity." },
      { ticker: "NEE", thesis: "A utility sells essential electric power, giving the portfolio customers with a very different spending pattern." },
    ],
    reflection: "My original basket depended heavily on consumer spending, technology demand, and familiar brands. The new health care, financial, and utility holdings respond to different needs and economic conditions. That does not remove risk, but one weak shopping season is less likely to hurt every company at the same time.",
  };
  const submitted = await posts.submitPortfolioMission({ post: mission, userId: STUDENT, response, idempotencyKey: "mission-submit-one" });
  assert.equal(submitted.deduped, false);
  assert.ok((await posts.latestClassPostSubmission(mission.id, STUDENT))?.evidence.met);
  assert.equal((await posts.submitPortfolioMission({ post: mission, userId: STUDENT, response, idempotencyKey: "mission-submit-one" })).deduped, true);
});

test("mission rejects a pick that is not currently held", async () => {
  const mission = (await posts.listClassPosts({})).find((post) => post.kind === "portfolio_mission")!;
  await assert.rejects(() => posts.submitPortfolioMission({
    post: mission, userId: STUDENT, response: {
      picks: [
        { ticker: "TM", thesis: "This is deliberately long enough but is not one of the currently held stocks." },
        { ticker: "JPM", thesis: "This bank adds exposure to rates lending credit and financial services." },
        { ticker: "NEE", thesis: "This utility provides essential power demand rather than optional consumer products." },
      ],
      reflection: "This reflection has enough words to pass the length rule, but the first claimed company is not currently held. The server should reject the response because live portfolio evidence, not a student's typed claim, decides whether each selected company qualifies for the assignment.",
    },
  }), /must be a current stock holding/);
});

test("selling a stock and buying a replacement can still complete the mission", async () => {
  const mission = (await posts.listClassPosts({})).find((post) => post.kind === "portfolio_mission")!;
  await db.run(
    `INSERT INTO ledger (id, account_id, kind, amount_cents, ticker, qty_micro, price_cents, idempotency_key, created_at)
     VALUES (?, 'post-account', 'sell', 1000, 'KO', -1000000, 1000, ?, ?)`,
    ["post-sell-ko", "post-sell-ko-key", "2026-09-22T12:00:00.000Z"],
  );
  await addHolding("CVX", 7);
  const state = await posts.portfolioMissionState(mission, STUDENT);
  assert.equal(state.counts.companies, 6);
  assert.equal(state.checks.companies, true);
  assert.ok(state.companies.some((holding: any) => holding.ticker === "CVX" && holding.sector === "Energy"));
  assert.ok(!state.companies.some((holding: any) => holding.ticker === "KO"));
  assert.deepEqual(state.checks, { companies: true, sectors: true });
  assert.equal(state.met, true);
});

test("mission explains the five-company four-sector portfolio shown by the student", async () => {
  const mission = (await posts.listClassPosts({})).find((post) => post.kind === "portfolio_mission")!;
  await db.run(`INSERT INTO users (id, name, role, class_id, created_at) VALUES ('post-scenario', 'Scenario', 'student', 'post-class', ?)`, [new Date().toISOString()]);
  await db.run(`INSERT INTO accounts (id, user_id, cash_cents, created_at) VALUES ('post-scenario-account', 'post-scenario', 0, ?)`, [new Date().toISOString()]);
  const tickers = ["AAPL", "META", "CAT", "NKE", "SBAC", "CVX", "TM"];
  for (const [i, ticker] of tickers.entries()) {
    await db.run(`INSERT INTO ledger (id, account_id, kind, amount_cents, ticker, qty_micro, price_cents, idempotency_key, created_at)
      VALUES (?, 'post-scenario-account', 'buy', -1000, ?, 1000000, 1000, ?, ?)`, [
      `scenario-buy-${i}`, ticker, `scenario-buy-key-${i}`, `2026-09-21T12:${String(i).padStart(2, "0")}:00.000Z`,
    ]);
  }
  for (const ticker of ["META", "CAT"]) {
    await db.run(`INSERT INTO ledger (id, account_id, kind, amount_cents, ticker, qty_micro, price_cents, idempotency_key, created_at)
      VALUES (?, 'post-scenario-account', 'sell', 1000, ?, -1000000, 1000, ?, ?)`, [
      `scenario-sell-${ticker}`, ticker, `scenario-sell-key-${ticker}`, "2026-09-22T12:00:00.000Z",
    ]);
  }
  const state = await posts.portfolioMissionState(mission, "post-scenario");
  assert.deepEqual(state.companies.map((holding: any) => holding.ticker).sort(), ["AAPL", "NKE", "SBAC", "CVX", "TM"].sort());
  assert.equal(state.counts.companies, 5);
  assert.equal(state.counts.sectors, 4);
  assert.ok(state.companies.some((holding: any) => holding.ticker === "CVX" && holding.sector === "Energy"));
  assert.ok(state.companies.some((holding: any) => holding.ticker === "TM" && holding.sector === "Consumer Discretionary"));
  assert.deepEqual(state.checks, { companies: false, sectors: false });
});

test("teacher progress ignores the removed historical goal in older submissions", async () => {
  const { studentModuleDetail } = await import("./module-progress.js");
  const mission = (await posts.listClassPosts({})).find((post) => post.kind === "portfolio_mission")!;
  const submission = await posts.latestClassPostSubmission(mission.id, STUDENT);
  const evidence = { ...submission.evidence, checks: { baselineReady: true, companies: true, sectors: true } };
  await db.run(`UPDATE class_post_submissions SET evidence = ? WHERE id = ?`, [JSON.stringify(evidence), submission.id]);
  const detail = (await studentModuleDetail(STUDENT)).find((item) => item.id === mission.id)!;
  assert.equal(detail.partsDone, 2);
  assert.equal(detail.partsTotal, 2);
  assert.deepEqual(detail.detail?.checks, { companies: true, sectors: true });
});
