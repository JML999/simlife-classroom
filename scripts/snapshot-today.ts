/**
 * Write today's leaderboard snapshot for every student.
 *
 * Snapshots CANNOT be backfilled: valuing a portfolio on a past date needs
 * prices from that date, and the app only ever holds current quotes. A day
 * missed is a day permanently absent from every chart and every competition
 * spanning it. Run this once per school day, after the close.
 *
 *   npm run snapshot                  # today, America/New_York
 *   npm run snapshot -- --dry-run     # show what would be written
 *   npm run snapshot -- --date 2026-09-25
 *   npm run snapshot -- --allow-partial
 *
 * ON QUOTE FAILURES THIS REFUSES TO WRITE. If a held ticker cannot be priced,
 * holdingsFor falls back to that position's cost basis, which silently records
 * the day as "no change" for that student and bakes the error into the
 * cumulative chain forever. A missing day can be re-run tomorrow; a wrong day
 * cannot be undone. So: abort, say which tickers failed, and let a person
 * decide. --allow-partial overrides, and says loudly what it is doing.
 */
import "../server/env.js";
import { initSchema, q } from "../server/db.js";
import { makeQuoteProvider } from "../server/quotes.js";
import { snapshotAll, formatBp } from "../server/leaderboard.js";

const argv = process.argv.slice(2);
const has = (flag: string) => argv.includes(flag);
const valueOf = (flag: string) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

const dryRun = has("--dry-run");
const allowPartial = has("--allow-partial");

/** School-day date in the classroom's timezone, not the server's. */
function todayInNewYork(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

const asOfDate = valueOf("--date") || todayInNewYork();
if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
  console.error(`Bad --date "${asOfDate}". Use YYYY-MM-DD.`);
  process.exit(1);
}

await initSchema();

// Every ticker anyone still holds.
const held = await q<{ ticker: string }>(
  `SELECT ticker FROM ledger WHERE ticker IS NOT NULL
    GROUP BY account_id, ticker HAVING SUM(qty_micro) > 0`,
);
const tickers = [...new Set(held.map((r) => r.ticker))].sort();

console.log(`Snapshot for ${asOfDate} — ${tickers.length} distinct tickers held.`);

const quotes = makeQuoteProvider();
const prices = new Map<string, number>();
const failed: string[] = [];
let source = "";

for (const ticker of tickers) {
  try {
    const { quote } = await quotes.getQuote(ticker);
    prices.set(ticker, quote.priceCents);
    source ||= quote.source;
  } catch (err: any) {
    failed.push(`${ticker} (${err?.code || err?.message || "unknown"})`);
  }
  // Finnhub's free tier allows 60 calls/minute. Stay well inside it.
  await new Promise((r) => setTimeout(r, 1100));
}

if (failed.length) {
  console.error(`\n${failed.length} ticker(s) could not be priced:`);
  for (const f of failed) console.error(`  • ${f}`);
  if (!allowPartial) {
    console.error(
      `\nREFUSING TO WRITE. Valuing an unpriced holding at cost basis would record\n` +
      `today as "no change" for those students and that error cannot be removed\n` +
      `from the cumulative return later. Re-run when quotes recover, or pass\n` +
      `--allow-partial if you accept the distortion.`,
    );
    process.exit(2);
  }
  console.error(`\n--allow-partial: writing anyway. Affected positions are valued at cost basis.\n`);
}

const priceOf = (ticker: string) => prices.get(ticker) ?? null;

if (dryRun) {
  console.log(`\n--dry-run: prices resolved, nothing written.`);
  for (const [t, p] of [...prices].slice(0, 15)) console.log(`  ${t.padEnd(7)} ${(p / 100).toFixed(2)}`);
  process.exit(0);
}

const written = await snapshotAll(asOfDate, priceOf, { quoteSource: source || "unknown" });
console.log(`\nWrote ${written} snapshot row(s) for ${asOfDate} (quote source: ${source || "unknown"}).`);

// Read back a short standings summary so the run is self-verifying.
const classes = await q<{ id: string; name: string }>(`SELECT id, name FROM classes ORDER BY name`);
const { classStandings } = await import("../server/leaderboard.js");
const standings = await classStandings(classes.map((c) => c.id));
console.log(`\nClass standings as of ${asOfDate}:`);
for (const s of standings) {
  const med = s.medianBp == null ? "no data" : formatBp(s.medianBp);
  console.log(`  ${s.name.padEnd(32)} median ${med.padStart(9)}   ${s.participants} of ${s.enrolled} holding`);
}
