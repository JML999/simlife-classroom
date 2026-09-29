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
    body: "Identify a sector or investing area where you currently have little or no exposure. Hold one ETF that adds that exposure and explain how it helps. Then identify a different area where you have a reasoned investment idea. Hold a second, different ETF that increases your exposure to that idea. Explain what each fund owns, how it fits your goal, overlap, fees, and risks. For your second idea, describe evidence that would make you reconsider it. Only your current ETF holdings count; there is no minimum purchase amount.",
    heroUrl: "/module-art/two-etf-goals.svg",
  });
  console.log(`Created draft ETF mission: ${post.id}. Publish it in Teacher → Class when ready.`);
}
