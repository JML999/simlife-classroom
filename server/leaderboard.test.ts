/**
 * Leaderboard tests. The property that matters most is the first group: a
 * teacher cash adjustment must not move a student's percent return, because
 * the whole board is ranked on that number.
 * Run: npm test
 */
import "./env.js";
import os from "node:os";
import path from "node:path";
import { test, before } from "node:test";
import assert from "node:assert";

process.env["SIMLIFE_DB_PATH"] = path.join(os.tmpdir(), `simlife-leaderboard-test-${process.pid}.db`);
// Never touch a real database from tests, even if .env sets SIMLIFE_DATABASE_URL.
delete process.env["SIMLIFE_DATABASE_URL"];

const { initSchema, run, one } = await import("./db.js");
const { adjustCash, buy } = await import("./ledger.js");
const { MockQuoteProvider, CachedQuotes } = await import("./quotes.js");
const lb = await import("./leaderboard.js");

let n = 0;
const uid = () => `t_lb_${process.pid}_${++n}`;
const mock = new MockQuoteProvider();
const quotes = new CachedQuotes(mock, 0);

/**
 * One source of truth for price. Trades execute against the quote provider and
 * snapshots value holdings through priceOf; if those two disagree even slightly
 * the assertions drift by a few basis points and stop meaning anything, so both
 * are driven from here.
 */
const prices = new Map<string, number>();
const priceOf = (ticker: string) => prices.get(ticker) ?? null;
function setPrice(ticker: string, cents: number): void {
  mock.setPrice(ticker, cents);
  prices.set(ticker, cents);
}

async function quoteFor(ticker: string) {
  const { quote } = await quotes.getQuote(ticker);
  return { priceCents: quote.priceCents, quoteTs: quote.asOf, quoteSource: quote.source };
}

before(async () => {
  await initSchema();
  await run(`INSERT INTO users (id, email, name, role, created_at) VALUES (?, ?, ?, ?, ?)`,
    ["lbteacher", "t@example.school", "Teacher", "teacher", new Date().toISOString()]);
  await run(`INSERT INTO classes (id, name, join_code, trading_frozen, created_at) VALUES (?, ?, ?, ?, ?)`,
    ["lbclass", "Test Period", "LBTEST", 0, new Date().toISOString()]);
  await run(`INSERT INTO classes (id, name, join_code, trading_frozen, created_at) VALUES (?, ?, ?, ?, ?)`,
    ["lbclass2", "Other Period", "LBTST2", 0, new Date().toISOString()]);
});

async function student(classId = "lbclass", funded = 100_000, name = "Stu"): Promise<string> {
  const id = uid();
  await run(`INSERT INTO users (id, email, name, role, class_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, `${id}@example.school`, name, "student", classId, new Date().toISOString()]);
  if (funded) {
    await adjustCash({ userId: id, actorId: "lbteacher", amountCents: funded, reason: "Opening balance", idempotencyKey: uid() });
  }
  return id;
}

// ---------------------------------------------------------------------------
// The core property
// ---------------------------------------------------------------------------

test("pure arithmetic: a sub-period return ignores money added at the end", () => {
  // Started at $1,000, ended at $1,600, but $500 of that was a deposit.
  // The earned part is $1,100 on $1,000 = +10%, not +60%.
  assert.equal(lb.subPeriodReturnBp(100_000, 160_000, 50_000), 1000);
  // Same growth with no deposit.
  assert.equal(lb.subPeriodReturnBp(100_000, 110_000, 0), 1000);
  // A withdrawal is a negative flow and is likewise removed.
  assert.equal(lb.subPeriodReturnBp(100_000, 60_000, -50_000), 1000);
});

test("a start value of zero yields no return rather than infinity", () => {
  assert.equal(lb.subPeriodReturnBp(0, 50_000, 50_000), 0);
  assert.equal(lb.subPeriodReturnBp(0, 0, 0), 0);
});

test("first snapshot shows existing gains and subsequent deposits do not inflate them", async () => {
  setPrice("OPN", 100);
  const s = await student("lbclass", 100_000, "OpeningGain");
  await buy({ userId: s, ticker: "OPN", dollarsCents: 100_000, idempotencyKey: uid(), tradingFrozen: false, ...(await quoteFor("OPN")) });
  setPrice("OPN", 120);
  const first = await lb.buildSnapshot(s, "2026-09-21", priceOf);
  assert.equal(first.twrBp, 2000, "existing 20% gain appears on day one");
  await lb.writeSnapshot(first);
  await adjustCash({ userId: s, actorId: "lbteacher", amountCents: 50_000, reason: "Later funding", idempotencyKey: uid() });
  const second = await lb.buildSnapshot(s, "2026-09-22", priceOf);
  assert.equal(second.twrBp, 2000, "new cash leaves the return unchanged");
});

test("refresh uses current quotes and repairs legacy zero opening rows", async () => {
  const classId = uid();
  await run(`INSERT INTO classes (id, name, join_code, trading_frozen, created_at) VALUES (?, ?, ?, 0, ?)`,
    [classId, "Opening Test", uid(), new Date().toISOString()]);
  setPrice("RPR", 100);
  const s = await student(classId, 100_000, "RepairedGain");
  await buy({ userId: s, ticker: "RPR", dollarsCents: 100_000, idempotencyKey: uid(), tradingFrozen: false, ...(await quoteFor("RPR")) });
  setPrice("RPR", 120);
  await lb.writeSnapshot(await lb.buildSnapshot(s, "2026-09-21", priceOf));
  await run(`UPDATE leaderboard_snapshots SET twr_bp = 0 WHERE user_id = ?`, [s]);
  const { refreshClassSnapshot } = await import("./leaderboard-refresh.js");
  await refreshClassSnapshot(classId, quotes, "2026-09-22");
  const first = await one<any>(`SELECT twr_bp FROM leaderboard_snapshots WHERE user_id = ? AND as_of_date = ?`, [s, "2026-09-21"]);
  const second = await one<any>(`SELECT twr_bp FROM leaderboard_snapshots WHERE user_id = ? AND as_of_date = ?`, [s, "2026-09-22"]);
  assert.equal(first.twr_bp, 2000);
  assert.equal(second.twr_bp, 2000);
  setPrice("RPR", 132);
  await refreshClassSnapshot(classId, quotes, "2026-09-23");
  const third = await one<any>(`SELECT twr_bp FROM leaderboard_snapshots WHERE user_id = ? AND as_of_date = ?`, [s, "2026-09-23"]);
  assert.equal(third.twr_bp, 3200, "later 10% growth chains with opening 20%");
});

test("refresh refuses to save a flat return when a held stock has no quote", async () => {
  const classId = uid();
  await run(`INSERT INTO classes (id, name, join_code, trading_frozen, created_at) VALUES (?, ?, ?, 0, ?)`,
    [classId, "Unpriced Test", uid(), new Date().toISOString()]);
  setPrice("NOQ", 100);
  const s = await student(classId, 100_000, "UnpricedHolding");
  await buy({ userId: s, ticker: "NOQ", dollarsCents: 100_000, idempotencyKey: uid(), tradingFrozen: false, ...(await quoteFor("NOQ")) });
  const broken = new CachedQuotes({
    name: "broken", search: async () => [], getQuote: async () => { throw new Error("quote unavailable"); },
  });
  const { refreshClassSnapshot } = await import("./leaderboard-refresh.js");
  await assert.rejects(refreshClassSnapshot(classId, broken, "2026-09-24"), /quote unavailable/);
  const count = await one<{ n: number }>(`SELECT COUNT(*) AS n FROM leaderboard_snapshots WHERE class_id = ?`, [classId]);
  assert.equal(count?.n, 0);
});

test("a mid-window deposit does not change the student's percent return", async () => {
  setPrice("AAA", 100);
  const a = await student("lbclass", 100_000, "NoDeposit");
  const b = await student("lbclass", 100_000, "GetsDeposit");
  for (const s of [a, b]) {
    await buy({ userId: s, ticker: "AAA", dollarsCents: 100_000, idempotencyKey: uid(), tradingFrozen: false, ...(await quoteFor("AAA")) });
  }
  // $1,000 buys exactly 1,000 shares at $1.00, so each starts at exactly $1,000.
  for (const s of [a, b]) await lb.writeSnapshot(await lb.buildSnapshot(s, "2026-09-21", priceOf));

  // The market rises 20% overnight; B also receives a $500 teacher deposit.
  setPrice("AAA", 120);
  await adjustCash({ userId: b, actorId: "lbteacher", amountCents: 50_000, reason: "Extra funding", idempotencyKey: uid() });
  for (const s of [a, b]) await lb.writeSnapshot(await lb.buildSnapshot(s, "2026-09-22", priceOf));

  const rowA = await one<any>(`SELECT twr_bp, value_cents FROM leaderboard_snapshots WHERE user_id = ? AND as_of_date = ?`, [a, "2026-09-22"]);
  const rowB = await one<any>(`SELECT twr_bp, value_cents FROM leaderboard_snapshots WHERE user_id = ? AND as_of_date = ?`, [b, "2026-09-22"]);

  assert.equal(rowA.twr_bp, 2000, "A should be up 20%");
  assert.equal(rowB.twr_bp, 2000, "B got a deposit but earned the same 20%");
  // B does have more money - the deposit is real, it just is not performance.
  assert.ok(rowB.value_cents > rowA.value_cents, "the deposit shows up in dollars");
});

// ---------------------------------------------------------------------------
// Chaining and windows
// ---------------------------------------------------------------------------

test("chaining compounds rather than adding", () => {
  // +10% then +10% is +21%, not +20%.
  assert.equal(lb.chainBp(1000, 1000), 2100);
  assert.equal(lb.chainBp(0, 1000), 1000);
  // +25% then -20% is flat.
  assert.equal(lb.chainBp(2500, -2000), 0);
});

test("a competition window measures only the window", () => {
  // Already up 40% before the event; up 68% by the end. The event return is 20%.
  assert.equal(lb.returnBetweenBp(4000, 6800), 2000);
  // Everyone starts an event at zero regardless of prior gains.
  assert.equal(lb.returnBetweenBp(4000, 4000), 0);
  assert.equal(lb.returnBetweenBp(0, 1500), 1500);
});

test("leaderboard since a baseline date neutralizes prior gains", async () => {
  // Separate tickers so each student can have their own price path.
  setPrice("BBX", 100);
  setPrice("BBY", 100);
  const early = await student("lbclass2", 100_000, "EarlyBird");
  const late = await student("lbclass2", 100_000, "Latecomer");
  await buy({ userId: early, ticker: "BBX", dollarsCents: 100_000, idempotencyKey: uid(), tradingFrozen: false, ...(await quoteFor("BBX")) });
  await buy({ userId: late, ticker: "BBY", dollarsCents: 100_000, idempotencyKey: uid(), tradingFrozen: false, ...(await quoteFor("BBY")) });
  await lb.writeSnapshot(await lb.buildSnapshot(early, "2026-09-01", priceOf));
  await lb.writeSnapshot(await lb.buildSnapshot(late, "2026-09-01", priceOf));

  // EarlyBird's stock doubles BEFORE the competition starts; Latecomer's is flat.
  setPrice("BBX", 200);
  await lb.writeSnapshot(await lb.buildSnapshot(early, "2026-09-25", priceOf));
  await lb.writeSnapshot(await lb.buildSnapshot(late, "2026-09-25", priceOf));

  // During the competition both rise exactly 10%.
  setPrice("BBX", 220);
  setPrice("BBY", 110);
  await lb.writeSnapshot(await lb.buildSnapshot(early, "2026-10-17", priceOf));
  await lb.writeSnapshot(await lb.buildSnapshot(late, "2026-10-17", priceOf));

  const all = await lb.leaderboardFor("lbclass2");
  const early_all = all.entries.find((e) => e.name === "EarlyBird")!;
  assert.ok(early_all.returnBp > 10_000, "all-time, EarlyBird is far ahead");

  const event = await lb.leaderboardFor("lbclass2", { since: "2026-09-25" });
  const e = event.entries.find((x) => x.name === "EarlyBird")!;
  const l = event.entries.find((x) => x.name === "Latecomer")!;
  assert.equal(e.returnBp, 1000, "within the window EarlyBird earned 10%");
  assert.equal(l.returnBp, 1000, "and so did Latecomer");
});

// ---------------------------------------------------------------------------
// Snapshot mechanics
// ---------------------------------------------------------------------------

test("re-running a day updates it instead of double-counting the chain", async () => {
  setPrice("CCC", 100);
  const s = await student("lbclass", 100_000, "Rerun");
  await buy({ userId: s, ticker: "CCC", dollarsCents: 100_000, idempotencyKey: uid(), tradingFrozen: false, ...(await quoteFor("CCC")) });
  await lb.writeSnapshot(await lb.buildSnapshot(s, "2026-09-21", priceOf));

  setPrice("CCC", 110);
  await lb.writeSnapshot(await lb.buildSnapshot(s, "2026-09-22", priceOf));
  await lb.writeSnapshot(await lb.buildSnapshot(s, "2026-09-22", priceOf)); // again, same day

  const rows = await (await import("./db.js")).q<any>(
    `SELECT as_of_date, twr_bp FROM leaderboard_snapshots WHERE user_id = ? ORDER BY as_of_date`, [s]);
  assert.equal(rows.length, 2, "one row per date");
  assert.equal(rows[1].twr_bp, 1000, "still +10%, not +21%");
});

test("snapshotAll writes a row per student in a class", async () => {
  await student("lbclass", 50_000, "Bulk1");
  await student("lbclass", 50_000, "Bulk2");
  const written = await lb.snapshotAll("2026-09-30", priceOf, { classId: "lbclass" });
  assert.ok(written >= 2);
  const row = await one<any>(
    `SELECT COUNT(*) AS n FROM leaderboard_snapshots WHERE as_of_date = ? AND class_id = ?`,
    ["2026-09-30", "lbclass"]);
  assert.equal(Number(row.n), written);
});

test("an uninvested student is flat, not errored", async () => {
  const s = await student("lbclass", 100_000, "AllCash");
  const snap = await lb.buildSnapshot(s, "2026-10-01", priceOf);
  assert.equal(snap.holdingsCount, 0);
  assert.equal(snap.valueCents, 100_000);
  assert.equal(snap.topPositionBp, null, "no positions means no largest position");
});

// ---------------------------------------------------------------------------
// The board itself
// ---------------------------------------------------------------------------

test("board ranks by percent descending and hides dollars by default", async () => {
  const { entries } = await lb.leaderboardFor("lbclass");
  for (let i = 1; i < entries.length; i++) {
    assert.ok(entries[i - 1]!.returnBp >= entries[i]!.returnBp, "sorted descending");
  }
  assert.ok(entries.every((e) => e.valueCents === undefined),
    "a student client must never receive another student's dollar balance");

  const teacher = await lb.leaderboardFor("lbclass", { includeDollars: true });
  assert.ok(teacher.entries.every((e) => typeof e.valueCents === "number"), "teacher view has dollars");
});

test("concentration is reported beside the return, not folded into it", async () => {
  setPrice("DDD", 100);
  const s = await student("lbclass", 100_000, "AllIn");
  await buy({ userId: s, ticker: "DDD", dollarsCents: 100_000, idempotencyKey: uid(), tradingFrozen: false, ...(await quoteFor("DDD")) });
  const snap = await lb.buildSnapshot(s, "2026-10-02", priceOf);
  assert.equal(snap.topPositionBp, 10_000, "100% of the account is one position");
});

test("median is used for the team score so one lucky student cannot carry a class", () => {
  assert.equal(lb.medianBp([100, 200, 300]), 200);
  assert.equal(lb.medianBp([100, 200, 300, 400]), 250);
  // One student up 500% barely moves the median; it would dominate a mean.
  assert.equal(lb.medianBp([0, 100, 200, 300, 50_000]), 200);
  assert.equal(lb.medianBp([]), null);
});

test("class standings report participation alongside the median", async () => {
  const standings = await lb.classStandings(["lbclass"], {});
  const c = standings[0]!;
  assert.equal(c.name, "Test Period");
  assert.ok(c.enrolled >= c.participants, "not everyone enrolled is necessarily competing");
  assert.ok(c.participants > 0);
});

test("formatBp reads as a percentage", () => {
  assert.equal(lb.formatBp(1234), "+12.34%");
  assert.equal(lb.formatBp(-500), "-5.00%");
  assert.equal(lb.formatBp(0), "+0.00%");
});

// ---------------------------------------------------------------------------
// Stable gains sort
// ---------------------------------------------------------------------------

test("stable gains: only >=6% gainers, steadiest daily path first", async () => {
  await run(`INSERT INTO classes (id, name, join_code, trading_frozen, created_at) VALUES (?, ?, ?, 0, ?)`,
    ["lbclass3", "Stable Period", "LBST1", new Date().toISOString()]);
  setPrice("SXX", 100);
  setPrice("VXX", 100);
  setPrice("LXX", 100);
  const steady = await student("lbclass3", 100_000, "SteadyEddie");
  const wild = await student("lbclass3", 100_000, "WildCard");
  const low = await student("lbclass3", 100_000, "SlowLoader");
  for (const [s, t] of [[steady, "SXX"], [wild, "VXX"], [low, "LXX"]] as const) {
    await buy({ userId: s, ticker: t, dollarsCents: 100_000, idempotencyKey: uid(), tradingFrozen: false, ...(await quoteFor(t)) });
  }
  // Four daily snapshots with controlled paths:
  //   Steady: ~+3%/day every day        -> ~+9% total, tiny vol
  //   Wild:   +25% / -15% / +20%        -> ~+27% total, enormous vol
  //   Low:    ~+1%/day                  -> ~+3% total, below the 6% bar
  const days = ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04"];
  const paths: Record<string, number[]> = { SXX: [100, 103, 106, 109], VXX: [100, 125, 106, 127], LXX: [100, 101, 102, 103] };
  for (let d = 0; d < days.length; d++) {
    setPrice("SXX", paths.SXX[d]!);
    setPrice("VXX", paths.VXX[d]!);
    setPrice("LXX", paths.LXX[d]!);
    for (const s of [steady, wild, low]) await lb.writeSnapshot(await lb.buildSnapshot(s, days[d]!, priceOf));
  }

  const pct = await lb.leaderboardFor("lbclass3", { sort: "percent" });
  assert.equal(pct.entries.length, 3, "percent gain shows everyone");
  assert.equal(pct.entries[0]!.name, "WildCard", "the wild path tops percent");

  const stable = await lb.leaderboardFor("lbclass3", { sort: "stable" });
  assert.equal(stable.entries.length, 2, "SlowLoader is out — under the 6% bar");
  assert.equal(stable.entries[0]!.name, "SteadyEddie", "least volatile qualifies first");
  assert.equal(stable.entries[1]!.name, "WildCard");
  assert.ok(stable.entries[0]!.volBp! < stable.entries[1]!.volBp!, "ordered by volatility ascending");
  assert.ok(stable.entries.every((e) => e.returnBp >= 600), "nobody below the bar appears");
});

test("stable gains: legitimately empty when nobody qualifies", async () => {
  await run(`INSERT INTO classes (id, name, join_code, trading_frozen, created_at) VALUES (?, ?, ?, 0, ?)`,
    ["lbclass4", "Quiet Period", "LBST2", new Date().toISOString()]);
  setPrice("QXX", 100);
  const dull = await student("lbclass4", 100_000, "DullButSteady");
  await buy({ userId: dull, ticker: "QXX", dollarsCents: 100_000, idempotencyKey: uid(), tradingFrozen: false, ...(await quoteFor("QXX")) });
  const days = ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04"];
  const prices = [100, 101, 102, 103]; // ~+3% total — steady, but under 6%
  for (let d = 0; d < days.length; d++) {
    setPrice("QXX", prices[d]!);
    await lb.writeSnapshot(await lb.buildSnapshot(dull, days[d]!, priceOf));
  }
  const stable = await lb.leaderboardFor("lbclass4", { sort: "stable" });
  assert.equal(stable.entries.length, 0, "nobody qualifies — empty is the correct answer");
  assert.ok(stable.asOfDate, "the board still reports as-of; empty, not broken");
  const pct = await lb.leaderboardFor("lbclass4", { sort: "percent" });
  assert.equal(pct.entries.length, 1, "percent view still shows the student");
});
