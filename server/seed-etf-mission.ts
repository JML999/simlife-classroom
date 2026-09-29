/** Seed the shared ETF assignment if it does not already exist. */
import "./env.js";
import { initSchema } from "./db.js";
import { createClassPost, listClassPosts } from "./class-posts.js";

const title = "Use two ETFs for two portfolio goals";
await initSchema();
const existing = (await listClassPosts({})).find((post) => post.kind === "etf_mission");
if (existing) {
  console.log(`Already seeded: ${existing.id} (${existing.status}).`);
} else {
  const post = await createClassPost({
    kind: "etf_mission", classId: null, title,
    summary: "Fill a gap in your portfolio and back an investing idea with two different ETFs.",
    body: "Identify a sector or investing area where you currently have little or no exposure. Hold one ETF that adds that exposure and explain how it helps. Then identify a different area you are bullish on. Hold a second, different ETF that increases your exposure to that idea and explain why it fits and what could go wrong. Look through each fund's holdings, overlap, fees, and risks. Only your current ETF holdings count; there is no minimum purchase amount.",
    heroUrl: "/module-art/balanced-portfolio.svg",
  });
  console.log(`Created draft ETF mission: ${post.id}. Publish it in Teacher → Class when ready.`);
}
