/** Idempotently publish the Week 2 balanced-portfolio mission. */
import "./env.js";
import { initSchema } from "./db.js";
import { createClassPost, listClassPosts, setClassPostStatus } from "./class-posts.js";

const TITLE = "Build a five-sector portfolio";
await initSchema();
const existing = (await listClassPosts({})).find((post) => post.kind === "portfolio_mission" && post.title === TITLE);
if (existing) {
  console.log(`Already seeded: ${existing.id} (${existing.status}).`);
  process.exit(0);
}

const mission = await createClassPost({
  kind: "portfolio_mission",
  classId: null,
  title: TITLE,
  summary: "Research beyond your first three picks. Add companies until you hold at least six across five sectors, then explain why each addition changes the risk you are taking.",
  body: "Your first three stock purchases are your starting basket. Do not just collect three more logos: research companies outside those original sectors, buy them in SimLife, and explain what each business adds. If your original three were concentrated in one sector, you may need more than three additions to reach five sectors. ETFs do not count toward the six-company target for this mission.",
  heroUrl: "/module-art/balanced-portfolio.svg",
  spec: { minCompanies: 6, minSectors: 5, minNewCompanies: 3, minNewSectorCompanies: 3, pickThesisMinWords: 12, reflectionMinWords: 40 },
});
await setClassPostStatus(mission.id, "published");
console.log(`Created and published Module 2: "${mission.title}" (${mission.id}).`);
