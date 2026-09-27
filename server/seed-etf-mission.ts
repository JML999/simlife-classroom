/** Create the next assignment as a draft. Publishing remains the teacher's choice. */
import "./env.js";
import { initSchema } from "./db.js";
import { createClassPost, listClassPosts } from "./class-posts.js";

const title = "Choose an ETF for your portfolio";
await initSchema();
const existing = (await listClassPosts({})).find((post) => post.kind === "etf_mission" && post.title === title);
if (existing) {
  console.log(`Already seeded: ${existing.id} (${existing.status}).`);
} else {
  const post = await createClassPost({
    kind: "etf_mission", classId: null, title,
    summary: "Find a portfolio gap, compare two ETFs, and hold a broad fund that addresses it.",
    body: "Review your current holdings and identify a gap or concentration. Compare two ETFs by what they own, overlap with your portfolio, fees, and risk. Hold at least one broad stock or bond ETF that fits your goal. Explain why you chose it and what risk remains. You may buy or sell as you choose; only your current holdings count.",
    heroUrl: "/module-art/balanced-portfolio.svg",
  });
  console.log(`Created draft ETF mission: ${post.id}. Publish it in Teacher → Class when ready.`);
}
