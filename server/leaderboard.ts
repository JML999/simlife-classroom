/**
 * Leaderboard snapshots and time-weighted return.
 *
 * WHY TIME-WEIGHTED. Ranking students by percent gain is only fair if a
 * teacher cash adjustment cannot move the number. A naive
 * (value - deposits) / deposits drags a student toward zero the moment they
 * are funded mid-competition, through no action of their own. Time-weighted
 * return splits the timeline at every external cash flow and chains the
 * sub-period returns, so deposits change how much money a student has and
 * never their percentage.
 *
 * Portfolio value at a past date needs prices at that date. Snapshot history
 * accumulates forward; the first row estimates the return already earned from
 * the account's net funding and current value.
 *
 * Flows are ledger rows that move money in or out of the brokerage account
 * from outside it (cash_adjust, cash_reversal, transfer_in, transfer_out).
 * Buys and sells are internal - cash falls, shares rise - and leave portfolio
 * value unchanged, so they are not flows.
 *
 * See LEADERBOARD_PLAN.md.
 */
import fs from "node:fs";
import path from "node:path";
import { q, one, run, newId, nowIso } from "./db.js";
import { holdingsFor } from "./ledger.js";
import { ROOT } from "./env.js";

/** Basis points: 10,000 bp = 100%. Money is cents, returns are bp. */
export const BP = 10_000;

/** Ledger kinds that move money across the account boundary. */
const FLOW_KINDS = ["cash_adjust", "cash_reversal", "transfer_in", "transfer_out"] as const;

export interface SnapshotRow {
  userId: string;
  classId: string | null;
  asOfDate: string;
  valueCents: number;
  cashCents: number;
  holdingsValueCents: number;
  netContributedCents: number;
  periodReturnBp: number;
  twrBp: number;
  holdingsCount: number;
  sectorsHeld: number | null;
  topPositionBp: number | null;
}

// ---------------------------------------------------------------------------
// Ticker classification (written by scripts/build-ticker-directory.mjs).
// Absent or v1 directory -> sector figures report null rather than zero, so a
// missing data file never looks like "this student holds no sectors".
// ---------------------------------------------------------------------------

let metaCache: Map<string, { sector: string; breadth: string }> | null | undefined;

function tickerMeta(): Map<string, { sector: string; breadth: string }> | null {
  if (metaCache !== undefined) return metaCache;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, "server", "ticker-directory.json"), "utf8"));
    if (!raw || typeof raw.meta !== "object" || raw.meta === null) { metaCache = null; return metaCache; }
    const m = new Map<string, { sector: string; breadth: string }>();
    for (const [ticker, v] of Object.entries(raw.meta as Record<string, any>)) {
      m.set(ticker, { sector: String(v?.sector || ""), breadth: String(v?.breadth || "") });
    }
    metaCache = m.size ? m : null;
  } catch {
    metaCache = null;
  }
  return metaCache;
}

/** Test seam: forget the cached directory. */
export function resetTickerMetaCache(): void { metaCache = undefined; }

// ---------------------------------------------------------------------------
// Time-weighted return
// ---------------------------------------------------------------------------

/**
 * One sub-period's return, with flows treated as arriving at the period end.
 *
 *     r = (V_end - flows) / V_start - 1
 *
 * Daily snapshots make the end-of-period assumption a small approximation and
 * a standard one. Returns bp, rounded.
 *
 * A start value of zero has no defined return (there was nothing invested to
 * earn on), so it yields 0 and the chain simply resumes from the new balance -
 * that is how a newly funded student joins without a spurious infinite gain.
 */
export function subPeriodReturnBp(startValueCents: number, endValueCents: number, flowCents: number): number {
  if (startValueCents <= 0) return 0;
  const grown = endValueCents - flowCents;
  return Math.round((grown / startValueCents - 1) * BP);
}

/** Chain a cumulative bp return with one more sub-period. */
export function chainBp(cumulativeBp: number, periodBp: number): number {
  const chained = (1 + cumulativeBp / BP) * (1 + periodBp / BP) - 1;
  return Math.round(chained * BP);
}

/**
 * Return between two cumulative points, e.g. a competition window.
 * Both arguments are cumulative-since-open figures from snapshot rows.
 */
export function returnBetweenBp(startCumulativeBp: number, endCumulativeBp: number): number {
  const start = 1 + startCumulativeBp / BP;
  if (start <= 0) return 0;
  return Math.round(((1 + endCumulativeBp / BP) / start - 1) * BP);
}

// ---------------------------------------------------------------------------
// Building a snapshot
// ---------------------------------------------------------------------------

/** Cumulative external flows into this user's brokerage account, in cents. */
export async function netContributedCents(userId: string): Promise<number> {
  const acct = await one<{ id: string }>(`SELECT id FROM accounts WHERE user_id = ?`, [userId]);
  if (!acct) return 0;
  const marks = FLOW_KINDS.map(() => "?").join(", ");
  const row = await one<{ total: number }>(
    `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM ledger
      WHERE account_id = ? AND kind IN (${marks})`,
    [acct.id, ...FLOW_KINDS],
  );
  return Number(row?.total ?? 0);
}

/**
 * Compute (but do not persist) today's snapshot for one student.
 * `priceOf` returns current price cents, or null when a quote is unavailable -
 * holdingsFor then falls back to cost basis for that position.
 */
export async function buildSnapshot(
  userId: string,
  asOfDate: string,
  priceOf: (ticker: string) => number | null,
): Promise<SnapshotRow> {
  const user = await one<{ class_id: string | null }>(`SELECT class_id FROM users WHERE id = ?`, [userId]);
  const { cashCents, holdings } = await holdingsFor(userId, priceOf);

  const holdingsValueCents = holdings.reduce((sum, h) => sum + h.marketCents, 0);
  const valueCents = cashCents + holdingsValueCents;
  const contributed = await netContributedCents(userId);

  // The diversification columns. They never affect rank; they sit beside it so
  // a first-place row with everything in one stock reads as exactly that.
  const meta = tickerMeta();
  let sectorsHeld: number | null = null;
  if (meta) {
    const sectors = new Set<string>();
    for (const h of holdings) {
      const m = meta.get(h.ticker);
      if (m?.sector) sectors.add(m.sector);
    }
    sectorsHeld = sectors.size;
  }
  const topPositionBp = valueCents > 0 && holdings.length
    ? Math.round((Math.max(...holdings.map((h) => h.marketCents)) / valueCents) * BP)
    : holdings.length ? 0 : null;

  const prev = await one<{ value_cents: number; net_contributed_cents: number; twr_bp: number }>(
    `SELECT value_cents, net_contributed_cents, twr_bp FROM leaderboard_snapshots
      WHERE user_id = ? AND as_of_date < ? ORDER BY as_of_date DESC LIMIT 1`,
    [userId, asOfDate],
  );

  const periodReturnBp = prev
    ? subPeriodReturnBp(prev.value_cents, valueCents, contributed - prev.net_contributed_cents)
    : 0;
  // The first snapshot is an opening estimate: current account value relative
  // to net funding. Earlier cash-flow timing cannot be reconstructed, but
  // starting everyone at 0% discards gains already visible in their accounts.
  const twrBp = prev ? chainBp(prev.twr_bp, periodReturnBp)
    : contributed > 0 ? subPeriodReturnBp(contributed, valueCents, 0) : 0;

  return {
    userId, classId: user?.class_id ?? null, asOfDate,
    valueCents, cashCents, holdingsValueCents,
    netContributedCents: contributed,
    periodReturnBp, twrBp,
    holdingsCount: holdings.length,
    sectorsHeld, topPositionBp,
  };
}

/**
 * Write one student's snapshot for a date. Idempotent: running twice for the
 * same date updates that row in place rather than double-counting a day into
 * the chain. Re-running after a price change is therefore safe.
 */
export async function writeSnapshot(row: SnapshotRow, quoteSource: string | null = null): Promise<void> {
  const existing = await one<{ id: string }>(
    `SELECT id FROM leaderboard_snapshots WHERE user_id = ? AND as_of_date = ?`,
    [row.userId, row.asOfDate],
  );
  if (existing) {
    await run(
      `UPDATE leaderboard_snapshots SET class_id = ?, value_cents = ?, cash_cents = ?,
         holdings_value_cents = ?, net_contributed_cents = ?, period_return_bp = ?, twr_bp = ?,
         holdings_count = ?, sectors_held = ?, top_position_bp = ?, quote_source = ?
       WHERE id = ?`,
      [row.classId, row.valueCents, row.cashCents, row.holdingsValueCents, row.netContributedCents,
       row.periodReturnBp, row.twrBp, row.holdingsCount, row.sectorsHeld, row.topPositionBp,
       quoteSource, existing.id],
    );
    return;
  }
  await run(
    `INSERT INTO leaderboard_snapshots
       (id, user_id, class_id, as_of_date, value_cents, cash_cents, holdings_value_cents,
        net_contributed_cents, period_return_bp, twr_bp, holdings_count, sectors_held,
        top_position_bp, quote_source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [newId("lbs"), row.userId, row.classId, row.asOfDate, row.valueCents, row.cashCents,
     row.holdingsValueCents, row.netContributedCents, row.periodReturnBp, row.twrBp,
     row.holdingsCount, row.sectorsHeld, row.topPositionBp, quoteSource, nowIso()],
  );
}

/** Snapshot every student (optionally one class). Returns how many were written. */
export async function snapshotAll(
  asOfDate: string,
  priceOf: (ticker: string) => number | null,
  opts: { classId?: string; quoteSource?: string } = {},
): Promise<number> {
  const students = opts.classId
    ? await q<{ id: string }>(`SELECT id FROM users WHERE role = 'student' AND class_id = ?`, [opts.classId])
    : await q<{ id: string }>(`SELECT id FROM users WHERE role = 'student'`);
  const rows: SnapshotRow[] = [];
  for (const s of students) {
    rows.push(await buildSnapshot(s.id, asOfDate, priceOf));
  }
  // Validate every valuation before persisting any rows. A newly purchased
  // ticker without a price must not leave a half-updated leaderboard.
  for (const row of rows) await writeSnapshot(row, opts.quoteSource ?? null);
  return rows.length;
}

/** Repair first-day 0% rows written before opening returns were included. */
export async function repairOpeningReturns(classId: string): Promise<number> {
  const rows = await q<{
    id: string; user_id: string; value_cents: number; net_contributed_cents: number;
    period_return_bp: number; twr_bp: number;
  }>(`SELECT id, user_id, value_cents, net_contributed_cents, period_return_bp, twr_bp
        FROM leaderboard_snapshots WHERE class_id = ? ORDER BY user_id, as_of_date`, [classId]);
  let repaired = 0;
  let userId = "";
  let cumulative = 0;
  let repairing = false;
  for (const row of rows) {
    if (row.user_id !== userId) {
      userId = row.user_id;
      const opening = row.net_contributed_cents > 0
        ? subPeriodReturnBp(row.net_contributed_cents, row.value_cents, 0) : 0;
      repairing = row.twr_bp === 0 && opening !== 0;
      cumulative = repairing ? opening : row.twr_bp;
    } else if (repairing) {
      cumulative = chainBp(cumulative, row.period_return_bp);
    }
    if (repairing) {
      await run(`UPDATE leaderboard_snapshots SET twr_bp = ? WHERE id = ?`, [cumulative, row.id]);
      repaired++;
    }
  }
  return repaired;
}

// ---------------------------------------------------------------------------
// Reading the board
// ---------------------------------------------------------------------------

export interface LeaderboardEntry {
  userId: string;
  name: string;
  returnBp: number;
  sectorsHeld: number | null;
  topPositionBp: number | null;
  holdingsCount: number;
  /** Population stdev of daily period returns (bp), null with fewer than 2 days. */
  volBp: number | null;
  /** Snapshot days backing the volatility figure. */
  days: number;
  /** Teacher views only. Never serialized to a student client. */
  valueCents?: number;
}

/** Stable-gains bar: up at least this much, over at least this many snapshot days. */
export const STABLE_MIN_RETURN_BP = 600; // +6.00%
export const STABLE_MIN_DAYS = 3;

/**
 * Population stdev of a daily-return series, in bp. Null below two points —
 * one day of no movement must never read as "perfectly stable".
 */
export function stdevBp(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.round(Math.sqrt(variance));
}

/**
 * Ranked board for a class.
 *
 * `sort: "percent"` (default) — percent return descending, everyone included.
 * `sort: "stable"` — the Stable-gains view: ONLY students at or above the
 * gain bar (6%) with enough history to measure, ordered least volatile first.
 * Empty is a valid answer; nobody qualifying is not an error.
 *
 * `since` scopes it to a competition window: the return becomes the change
 * between that date's cumulative figure and the latest one, so a student who
 * was already up 40% before the event starts at zero like everyone else.
 *
 * valueCents is populated only when includeDollars is set. Students have
 * different jobs and different pay in SimLife, so another student's dollar
 * balance would broadcast who drew the good job. Percentages compare fairly
 * and disclose nothing.
 */
export async function leaderboardFor(
  classId: string,
  opts: {
    since?: string; asOf?: string; includeDollars?: boolean;
    sort?: "percent" | "stable";
    stableMinReturnBp?: number; stableMinDays?: number;
  } = {},
): Promise<{ asOfDate: string | null; entries: LeaderboardEntry[]; sort: "percent" | "stable"; stableMinReturnBp: number }> {
  const sort = opts.sort ?? "percent";
  const stableMinReturnBp = opts.stableMinReturnBp ?? STABLE_MIN_RETURN_BP;
  const stableMinDays = opts.stableMinDays ?? STABLE_MIN_DAYS;
  const latest = opts.asOf
    ?? (await one<{ d: string }>(
      `SELECT MAX(as_of_date) AS d FROM leaderboard_snapshots WHERE class_id = ?`, [classId],
    ))?.d
    ?? null;
  if (!latest) return { asOfDate: null, entries: [], sort, stableMinReturnBp };

  const rows = await q<{
    user_id: string; name: string; twr_bp: number; value_cents: number;
    sectors_held: number | null; top_position_bp: number | null; holdings_count: number;
  }>(
    `SELECT s.user_id, u.name, s.twr_bp, s.value_cents, s.sectors_held, s.top_position_bp, s.holdings_count
       FROM leaderboard_snapshots s JOIN users u ON u.id = s.user_id
      WHERE s.class_id = ? AND s.as_of_date = ?`,
    [classId, latest],
  );

  const baselines = new Map<string, number>();
  if (opts.since) {
    const base = await q<{ user_id: string; twr_bp: number }>(
      `SELECT user_id, twr_bp FROM leaderboard_snapshots WHERE class_id = ? AND as_of_date = ?`,
      [classId, opts.since],
    );
    for (const b of base) baselines.set(b.user_id, b.twr_bp);
  }

  // Daily period-return series per student, for the volatility column. Windowed
  // the same way the return is: all history by default, since `since` when set.
  const daily = new Map<string, number[]>();
  const seriesRows = await q<{ user_id: string; period_return_bp: number }>(
    `SELECT user_id, period_return_bp FROM leaderboard_snapshots
      WHERE class_id = ? AND as_of_date <= ?${opts.since ? " AND as_of_date >= ?" : ""}
      ORDER BY as_of_date`,
    opts.since ? [classId, latest, opts.since] : [classId, latest],
  );
  for (const r of seriesRows) {
    const series = daily.get(r.user_id);
    if (series) series.push(r.period_return_bp);
    else daily.set(r.user_id, [r.period_return_bp]);
  }

  const entries: LeaderboardEntry[] = rows.map((r) => {
    const returnBp = opts.since
      ? returnBetweenBp(baselines.get(r.user_id) ?? 0, r.twr_bp)
      : r.twr_bp;
    const series = daily.get(r.user_id) ?? [];
    const e: LeaderboardEntry = {
      userId: r.user_id, name: r.name, returnBp,
      sectorsHeld: r.sectors_held, topPositionBp: r.top_position_bp,
      holdingsCount: r.holdings_count,
      volBp: stdevBp(series), days: series.length,
    };
    if (opts.includeDollars) e.valueCents = r.value_cents;
    return e;
  });

  if (sort === "stable") {
    // Stable gains: over the bar AND measured over enough days, steadiest
    // first. Below the bar or too little history = not on this board at all.
    const qualified = entries.filter(
      (e) => e.returnBp >= stableMinReturnBp && e.days >= stableMinDays && e.volBp != null,
    );
    qualified.sort((a, b) => (a.volBp! - b.volBp!) || (b.returnBp - a.returnBp) || a.name.localeCompare(b.name));
    return { asOfDate: latest, entries: qualified, sort, stableMinReturnBp };
  }

  entries.sort((a, b) => b.returnBp - a.returnBp || a.name.localeCompare(b.name));
  return { asOfDate: latest, entries, sort, stableMinReturnBp };
}

/**
 * Median return for a class - the period-versus-period team score.
 *
 * Median, not mean, on purpose: one lucky student cannot carry a class. The
 * team score is meant to say "most people here did reasonably", which is the
 * only version of it worth competing over.
 */
export function medianBp(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

export async function classStandings(
  classIds: string[], opts: { since?: string } = {},
): Promise<{ classId: string; name: string; medianBp: number | null; participants: number; enrolled: number }[]> {
  const out = [];
  for (const classId of classIds) {
    const { entries } = await leaderboardFor(classId, opts);
    const cls = await one<{ name: string }>(`SELECT name FROM classes WHERE id = ?`, [classId]);
    const enrolled = await one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM users WHERE role = 'student' AND class_id = ?`, [classId],
    );
    // Only students who actually hold something count toward the team score; a
    // class where half the room never traded should not read the same as one
    // where everybody did, which is what `participants` is there to expose.
    const active = entries.filter((e) => e.holdingsCount > 0);
    out.push({
      classId, name: cls?.name ?? classId,
      medianBp: medianBp(active.map((e) => e.returnBp)),
      participants: active.length,
      enrolled: Number(enrolled?.n ?? 0),
    });
  }
  return out;
}

/** Format bp for display: 1234 -> "+12.34%". */
export function formatBp(bp: number): string {
  return `${bp >= 0 ? "+" : "-"}${(Math.abs(bp) / 100).toFixed(2)}%`;
}
