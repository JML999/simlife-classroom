/**
 * Create the Week 2 sector sort activity.
 *
 * Every ticker in this basket is one a student in 3rd or 4th period actually
 * owns, so the exercise is about their own portfolio rather than a generic
 * list. Four of the twelve are here specifically because students get them
 * wrong in a way worth talking about:
 *
 *   AMZN  feels like technology; GICS calls it Consumer Discretionary
 *   WMT   feels like retail/discretionary; it is Consumer Staples
 *   GOOGL feels like technology; it is Communication Services
 *   CEG   Constellation Energy - almost nobody knows it is a Utility
 *
 * Correct answers are NOT stored here; grading reads ticker-directory.json.
 * Run: npm run seed:sort
 */
import "./env.js";
import { initSchema, one } from "./db.js";
import { createActivity, listActivities, sectorOf } from "./sorting.js";

const TITLE = "Sort the basket: which sector?";
const TICKERS = ["NKE", "AMZN", "TSLA", "AAPL", "AVGO", "KO", "WMT", "PEP", "BAC", "COIN", "GOOGL", "CEG"];
const BUCKETS = [
  "Consumer Discretionary",
  "Consumer Staples",
  "Information Technology",
  "Communication Services",
  "Financials",
  "Utilities",
];

await initSchema();

// Refuse to seed an activity that cannot be graded. Better to stop here than to
// hand students a question with no right answer.
const missing = TICKERS.filter((t) => !sectorOf(t));
if (missing.length) {
  console.error(`These tickers have no sector in ticker-directory.json: ${missing.join(", ")}`);
  console.error(`Run: node scripts/build-ticker-directory.mjs`);
  process.exit(1);
}
const offBucket = TICKERS.filter((t) => !BUCKETS.includes(sectorOf(t)!));
if (offBucket.length) {
  console.error(`These tickers' sectors are not among the buckets: ${offBucket.map((t) => `${t} (${sectorOf(t)})`).join(", ")}`);
  process.exit(1);
}

const existing = (await listActivities({})).find((a) => a.title === TITLE);
if (existing) {
  console.log(`Already seeded: ${existing.id} (${existing.status}).`);
  process.exit(0);
}

const act = await createActivity({
  classId: null,                    // offered to every class
  title: TITLE,
  prompt:
    "Every company below is one somebody in this room owns. Put each into the sector it belongs to. " +
    "Guess if you are unsure - you can try again as many times as you like.",
  buckets: BUCKETS,
  tokens: TICKERS.map((ticker) => ({ ticker })),
  status: "published",
});

console.log(`Created "${act.title}" (${act.id}), published to all classes.`);
console.log(`${act.tokens.length} tickers, ${act.buckets.length} buckets.`);
for (const t of act.tokens) console.log(`  ${t.ticker.padEnd(6)} -> ${sectorOf(t.ticker)}`);
