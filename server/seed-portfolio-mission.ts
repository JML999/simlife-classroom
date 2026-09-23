/**
 * Idempotently publish the Week 2 balanced-portfolio mission.
 *
 * Upserts on title: re-running updates the summary/body/spec in place (so copy
 * iterations reach an already-published prod row) without touching status,
 * class scope, or submissions. It never un-publishes what a teacher chose.
 */
import "./env.js";
import { initSchema, run } from "./db.js";
import { createClassPost, listClassPosts, setClassPostStatus } from "./class-posts.js";

const TITLE = "Build a five-sector portfolio";
const SUMMARY = "Hold at least six individual stocks across at least five sectors, then explain how your portfolio is diversified.";
const BODY = "Build a portfolio that currently holds at least six individual stocks across at least five different sectors. You may buy and sell as you choose; only your current holdings count. Multiple stocks in the same sector count as one sector. ETFs do not count toward the six-stock target.";
const SPEC = { minCompanies: 6, minSectors: 5, pickThesisMinWords: 12, reflectionMinWords: 40 };

await initSchema();
const existing = (await listClassPosts({})).find((post) => post.kind === "portfolio_mission" && post.title === TITLE);
if (existing) {
  await run(`UPDATE class_posts SET summary = ?, body = ?, spec = ?, hero_url = ? WHERE id = ?`,
    [SUMMARY, BODY, JSON.stringify(SPEC), "/module-art/balanced-portfolio.svg", existing.id]);
  console.log(`Already seeded: ${existing.id} (${existing.status}) — summary/body/spec refreshed.`);
  process.exit(0);
}

const mission = await createClassPost({
  kind: "portfolio_mission",
  classId: null,
  title: TITLE,
  summary: SUMMARY,
  body: BODY,
  heroUrl: "/module-art/balanced-portfolio.svg",
  spec: SPEC,
});
await setClassPostStatus(mission.id, "published");
console.log(`Created and published Module 2: "${mission.title}" (${mission.id}).`);
