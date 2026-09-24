/** Refresh classroom standings from held shares and current market quotes. */
import { q } from "./db.js";
import { repairOpeningReturns, snapshotAll } from "./leaderboard.js";
import type { CachedQuotes } from "./quotes.js";

const FRESH_MS = 15 * 60_000;
const RETRY_MS = 60_000;
const quotePaceMs = 1100; // below Finnhub's 60 calls/minute free-tier limit
const states = new Map<string, { promise: Promise<void> | null; lastAttempt: number; lastSuccess: number; error: string }>();
let queue: Promise<void> = Promise.resolve();

export function schoolDate(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

export async function refreshClassSnapshot(classId: string, quotes: CachedQuotes, asOfDate = schoolDate()): Promise<void> {
  const held = await q<{ ticker: string }>(
    `SELECT l.ticker FROM ledger l
       JOIN accounts a ON a.id = l.account_id
       JOIN users u ON u.id = a.user_id
      WHERE u.role = 'student' AND u.class_id = ? AND l.ticker IS NOT NULL
      GROUP BY l.account_id, l.ticker HAVING SUM(l.qty_micro) > 0`,
    [classId],
  );
  const tickers = [...new Set(held.map((row) => row.ticker))].sort();
  const prices = new Map<string, number>();
  let quoteSource = "";
  for (const ticker of tickers) {
    const { quote, cached } = await quotes.getQuote(ticker);
    prices.set(ticker, quote.priceCents);
    quoteSource ||= quote.source;
    if (!cached && quotes.providerName === "finnhub") {
      await new Promise((resolve) => setTimeout(resolve, quotePaceMs));
    }
  }
  // Never write a partly priced board: a cost-basis fallback looks like a
  // genuine flat return and cannot later be distinguished from market data.
  await repairOpeningReturns(classId);
  await snapshotAll(asOfDate, (ticker) => {
    const price = prices.get(ticker);
    if (price == null) throw new Error(`No current quote for ${ticker}`);
    return price;
  }, {
    classId, quoteSource: quoteSource || quotes.providerName,
  });
}

/** Start a bounded background refresh; callers can keep serving saved rows. */
export function ensureLeaderboardFresh(classId: string, quotes: CachedQuotes): { refreshing: boolean; refreshError: string | null } {
  const state = states.get(classId) ?? { promise: null, lastAttempt: 0, lastSuccess: 0, error: "" };
  states.set(classId, state);
  const now = Date.now();
  if (!state.promise && now - state.lastSuccess >= FRESH_MS && now - state.lastAttempt >= RETRY_MS) {
    state.lastAttempt = now;
    state.error = "";
    const task = queue.then(() => refreshClassSnapshot(classId, quotes));
    state.promise = task;
    queue = task.catch(() => {}); // one global quote queue across both periods
    void task.then(() => {
      state.lastSuccess = Date.now();
      state.promise = null;
    }).catch((err) => {
      console.error("[simlife leaderboard] refresh failed:", classId, err instanceof Error ? err.message : String(err));
      state.error = "Latest prices are temporarily unavailable. Showing the last saved standings.";
      state.promise = null;
    });
  }
  return { refreshing: !!state.promise, refreshError: state.error || null };
}
