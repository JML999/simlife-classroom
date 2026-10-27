/**
 * Trade + authorization tests: fractional buys, sells, duplicates,
 * concurrency, frozen trading, stale balances, role enforcement.
 * Run: npm test
 */
import "./env.js";
import os from "node:os";
import path from "node:path";
import { test, before } from "node:test";
import assert from "node:assert";

process.env["SIMLIFE_DB_PATH"] = path.join(os.tmpdir(), `simlife-trades-test-${process.pid}.db`);
// Never touch a real database from tests, even if .env sets SIMLIFE_DATABASE_URL.
delete process.env["SIMLIFE_DATABASE_URL"];

const { initSchema, run } = await import("./db.js");
const { adjustCash, buy, sell, holdingsFor, checkInvariant, LedgerError, MICRO } = await import("./ledger.js");
const { MockQuoteProvider, CachedQuotes } = await import("./quotes.js");
const { requireTeacher, requireAuth, encodeSession, decodeSession } = await import("./session.js");

let n = 0;
const uid = () => `t_trade_${process.pid}_${++n}`;
const mock = new MockQuoteProvider();
const quotes = new CachedQuotes(mock, 0);

async function price(ticker: string): Promise<{ priceCents: number; quoteTs: string; quoteSource: string }> {
  const { quote } = await quotes.getQuote(ticker);
  return { priceCents: quote.priceCents, quoteTs: quote.asOf, quoteSource: quote.source };
}

before(async () => {
  await initSchema();
  await run(`INSERT INTO users (id, email, name, role, created_at) VALUES (?, ?, ?, ?, ?)`,
    ["tteacher", "t@example.school", "Teacher", "teacher", new Date().toISOString()]);
});

async function fundedStudent(cents = 100000): Promise<string> {
  const id = uid();
  await run(`INSERT INTO users (id, email, name, role, created_at) VALUES (?, ?, ?, ?, ?)`,
    [id, `${id}@example.school`, "Stu", "student", new Date().toISOString()]);
  await adjustCash({ userId: id, actorId: "tteacher", amountCents: cents, reason: "Funded for test", idempotencyKey: uid() });
  return id;
}

test("fractional buy records price, qty, and quote metadata", async () => {
  const s = await fundedStudent();
  const p = await price("VOO");
  const r = await buy({ userId: s, ticker: "VOO", qtyMicro: Math.round(0.5 * MICRO), ...p, idempotencyKey: uid(), tradingFrozen: false });
  assert.equal(r.qtyMicro, 500000);
  assert.equal(r.costCents, Math.round(0.5 * p.priceCents));
  assert.equal(r.entry.quote_source, "mock");
  assert.ok(r.entry.quote_ts);
  assert.ok(r.entry.price_cents && r.entry.price_cents > 0);
  const inv = await checkInvariant(s);
  assert.ok(inv.ok);
});

test("buy by dollar amount computes fractional qty", async () => {
  const s = await fundedStudent();
  const p = await price("AAPL");
  const r = await buy({ userId: s, ticker: "AAPL", dollarsCents: 2500, ...p, idempotencyKey: uid(), tradingFrozen: false });
  assert.ok(r.qtyMicro > 0 && r.costCents <= 2500);
});

test("buy with insufficient cash fails; stale browser balance cannot authorize", async () => {
  const s = await fundedStudent(500);
  const p = await price("MSFT");
  await assert.rejects(
    () => buy({ userId: s, ticker: "MSFT", qtyMicro: MICRO, ...p, idempotencyKey: uid(), tradingFrozen: false }),
    (e: any) => e instanceof LedgerError && e.code === "INSUFFICIENT_CASH",
  );
});

test("sell partial then all; oversell rejected", async () => {
  const s = await fundedStudent();
  const p = await price("VTI");
  await buy({ userId: s, ticker: "VTI", qtyMicro: 2 * MICRO, ...p, idempotencyKey: uid(), tradingFrozen: false });
  const p2 = await price("VTI");
  const part = await sell({ userId: s, ticker: "VTI", qtyMicro: Math.round(0.5 * MICRO), ...p2, idempotencyKey: uid(), tradingFrozen: false });
  assert.equal(part.qtyMicro, 500000);
  await assert.rejects(
    () => sell({ userId: s, ticker: "VTI", qtyMicro: 10 * MICRO, ...p2, idempotencyKey: uid(), tradingFrozen: false }),
    (e: any) => e instanceof LedgerError && e.code === "INSUFFICIENT_SHARES",
  );
  const all = await sell({ userId: s, ticker: "VTI", sellAll: true, ...p2, idempotencyKey: uid(), tradingFrozen: false });
  assert.equal(all.qtyMicro, Math.round(1.5 * MICRO));
  const { holdings } = await holdingsFor(s, () => null);
  assert.ok(!holdings.find((h) => h.ticker === "VTI"), "fully sold position disappears");
  const inv = await checkInvariant(s);
  assert.ok(inv.ok);
});

test("duplicate trade submissions execute once (double-click safety)", async () => {
  const s = await fundedStudent();
  const p = await price("QQQ");
  const key = uid();
  const [a, b] = await Promise.all([
    buy({ userId: s, ticker: "QQQ", qtyMicro: Math.round(0.1 * MICRO), ...p, idempotencyKey: key, tradingFrozen: false }),
    buy({ userId: s, ticker: "QQQ", qtyMicro: Math.round(0.1 * MICRO), ...p, idempotencyKey: key, tradingFrozen: false }),
  ]);
  assert.equal(a.entry.id, b.entry.id);
  assert.ok(a.deduped || b.deduped);
  const inv = await checkInvariant(s);
  assert.ok(inv.ok);
});

test("frozen trading blocks buys and sells", async () => {
  const s = await fundedStudent();
  const p = await price("KO");
  await assert.rejects(
    () => buy({ userId: s, ticker: "KO", qtyMicro: MICRO, ...p, idempotencyKey: uid(), tradingFrozen: true }),
    (e: any) => e instanceof LedgerError && e.code === "TRADING_FROZEN",
  );
  await assert.rejects(
    () => sell({ userId: s, ticker: "KO", qtyMicro: MICRO, ...p, idempotencyKey: uid(), tradingFrozen: true }),
    (e: any) => e instanceof LedgerError && e.code === "TRADING_FROZEN",
  );
});

test("holdings math: basis, market value, gain/loss", async () => {
  const s = await fundedStudent();
  mock.setPrice("SCHD", 3000); // $30.00
  const p = await price("SCHD");
  await buy({ userId: s, ticker: "SCHD", qtyMicro: 10 * MICRO, ...p, idempotencyKey: uid(), tradingFrozen: false });
  mock.setPrice("SCHD", 3300); // rises to $33.00
  const { holdings, cashCents } = await holdingsFor(s, (t) => (t === "SCHD" ? 3300 : null));
  const h = holdings.find((x) => x.ticker === "SCHD")!;
  assert.equal(h.costBasisCents, 30000);
  assert.equal(h.marketCents, 33000);
  assert.equal(h.gainLossCents, 3000);
  assert.ok(cashCents === 100000 - 30000);
});

test("student cannot pass teacher middleware; signed-out requests are rejected", async () => {
  const studentCookie = encodeSession({ userId: "some-student", role: "student" });
  let status = 0;
  const res: any = { status: (c: number) => { status = c; return res; }, json: () => res };
  requireTeacher({ cookies: { sl_session: studentCookie } } as any, res, () => { status = 200; });
  assert.equal(status, 403);
  status = 0;
  requireAuth({ cookies: {} } as any, res, () => { status = 200; });
  assert.equal(status, 401);
});

test("sessions expire after the classroom session window", () => {
  const expired = encodeSession({ userId: "some-student", role: "student", issuedAt: Date.now() - 13 * 60 * 60 * 1000 });
  assert.equal(decodeSession(expired), null);
  const current = encodeSession({ userId: "some-student", role: "student" });
  assert.equal(decodeSession(current)?.userId, "some-student");
});

test("teacher Student view stays signed and cannot pass teacher middleware", () => {
  const cookie = encodeSession({ userId: "teacher-id", role: "teacher", viewStudentId: "period-one-student" });
  assert.equal(decodeSession(cookie)?.viewStudentId, "period-one-student");
  let status = 0;
  const res: any = { status: (code: number) => { status = code; return res; }, json: () => res };
  requireTeacher({ cookies: { sl_session: cookie } } as any, res, () => { status = 200; });
  assert.equal(status, 403);
});

test("closing and rebuying a ticker resets cost basis instead of blending sold purchases", async () => {
  const s=await fundedStudent(100000);
  const trade={quoteTs:new Date().toISOString(),quoteSource:'mock',tradingFrozen:false};
  await buy({userId:s,ticker:'RESET',qtyMicro:10*MICRO,priceCents:1000,...trade,idempotencyKey:uid()});
  await sell({userId:s,ticker:'RESET',sellAll:true,priceCents:800,...trade,idempotencyKey:uid()});
  await buy({userId:s,ticker:'RESET',qtyMicro:5*MICRO,priceCents:2000,...trade,idempotencyKey:uid()});
  const {holdings,cashCents,closedTrades,realizedGainLossCents}=await holdingsFor(s,()=>1800);const h=holdings[0];
  assert.equal(realizedGainLossCents,-2000);assert.equal(closedTrades.length,1);assert.equal(closedTrades[0].shares,10);assert.equal(closedTrades[0].costBasisCents,10000);assert.equal(closedTrades[0].proceedsCents,8000);assert.equal(closedTrades[0].returnPct,-20);assert.equal(closedTrades[0].positionClosed,true);
  assert.equal(h.shares,5);assert.equal(h.avgCostCents,2000);assert.equal(h.costBasisCents,10000);assert.equal(h.gainLossCents,-1000);
  assert.equal(cashCents+h.marketCents-100000,-3000,'earlier $20 realized loss plus $10 unrealized loss');
  assert.equal((await checkInvariant(s)).ok,true);
});

test("partial sales remove the sold basis before new buys, including equal-timestamp trades",async()=>{
  const s=await fundedStudent(100000),trade={quoteTs:new Date().toISOString(),quoteSource:'mock',tradingFrozen:false};
  await buy({userId:s,ticker:'PART',qtyMicro:10*MICRO,priceCents:1000,...trade,idempotencyKey:uid()});
  await sell({userId:s,ticker:'PART',qtyMicro:8*MICRO,priceCents:1500,...trade,idempotencyKey:uid()});
  await buy({userId:s,ticker:'PART',qtyMicro:2*MICRO,priceCents:2000,...trade,idempotencyKey:uid()});
  const {one}=await import('./db.js');const acct=await one<any>('SELECT id FROM accounts WHERE user_id=?',[s]);
  // IDs are random, so make timestamp ties deliberate and preserve execution insertion order.
  await run(`UPDATE ledger SET created_at='2026-10-27T14:00:00.000Z' WHERE account_id=? AND ticker='PART'`,[acct!.id]);
  const result=await holdingsFor(s,()=>1400);assert.equal(result.realizedGainLossCents,4000);assert.equal(result.closedTrades[0].positionClosed,false);assert.equal(result.closedTrades[0].costBasisCents,8000);
  const h=result.holdings[0];assert.equal(h.shares,4);assert.equal(h.costBasisCents,6000);assert.equal(h.avgCostCents,1500);assert.equal(h.gainLossCents,-400);
  const fallback=(await holdingsFor(s,()=>null)).holdings[0];assert.equal(fallback.marketCents,6000);assert.equal(fallback.gainLossCents,0);
});


test("sold-share cost allocations conserve fractional cents and all sales remain after full exit",async()=>{
 const {projectTradeHistory}=await import('./ledger.js');
 const row=(id:string,kind:string,qty_micro:number,amount_cents:number)=>({id,kind,qty_micro,amount_cents,ticker:'ROUND',created_at:'2026-10-27T14:00:00Z'});
 const result=projectTradeHistory([row('buy','buy',3,-100),row('one','sell',-1,40),row('two','sell',-1,40),row('three','sell',-1,40)]);
 assert.equal(result.positions.get('ROUND')?.basis,0);assert.equal(result.positions.get('ROUND')?.qty,0);assert.equal(result.realizedGainLossCents,20);
 assert.deepEqual(result.closedTrades.map(s=>s.id),['three','two','one']);assert.equal(result.closedTrades.reduce((sum,s)=>sum+s.costBasisCents,0),100);assert.equal(result.closedTrades.reduce((sum,s)=>sum+s.gainLossCents,0),20);
 const empty=await holdingsFor('no-such-student',()=>100);assert.equal(empty.closedTrades.length,0);assert.equal(empty.realizedGainLossCents,0);
});
