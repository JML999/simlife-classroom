import { test } from "node:test";
import assert from "node:assert";
import { StooqQuoteProvider } from "./quotes.js";

test("Stooq quotes preserve the provider timestamp instead of request time", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    "Symbol,Date,Time,Open,High,Low,Close,Volume\nAAPL.US,2026-09-09,20:00:00,230,233,229,232.50,1000\n",
    { status: 200 },
  );
  try {
    const quote = await new StooqQuoteProvider().getQuote("AAPL");
    assert.equal(quote.priceCents, 23250);
    assert.equal(quote.asOf, "2026-09-09T20:00:00.000Z");
    assert.equal(quote.delayed, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("directory search finds S&P 500 names beyond the classroom list", async () => {
  const { MockQuoteProvider, searchDirectory } = await import("./quotes.js");
  const byName = searchDirectory("Berkshire");
  assert.ok(byName.some((s) => s.ticker === "BRK.B" || s.ticker === "BRK.A"), JSON.stringify(byName));
  const byPrefix = searchDirectory("JNJ");
  assert.equal(byPrefix[0].ticker, "JNJ");
  assert.ok(searchDirectory("").length === 0);
  assert.ok(searchDirectory("xyz-no-such-company").length === 0);
  // Classroom picks rank first.
  const voo = searchDirectory("VOO");
  assert.equal(voo[0].ticker, "VOO");
  // Both providers share the directory.
  const stooq = await new (await import("./quotes.js")).StooqQuoteProvider().search("Procter");
  assert.ok(stooq.some((s) => s.ticker === "PG"));
});

test("mock quotes: fixed classroom prices, stable stand-ins elsewhere", async () => {
  const { MockQuoteProvider, pseudoPriceCents } = await import("./quotes.js");
  const m = new MockQuoteProvider();
  assert.equal((await m.getQuote("AAPL")).priceCents, 23250);
  const a = await m.getQuote("BRK.B");
  const b = await m.getQuote("BRK.B");
  assert.equal(a.priceCents, b.priceCents);
  assert.equal(a.priceCents, pseudoPriceCents("BRK.B"));
  assert.equal(a.source, "mock");
  assert.equal(a.delayed, true);
});

test("classroom meme picks: GME + BBW are searchable with fixed mock prices", async () => {
  const { MockQuoteProvider, searchDirectory } = await import("./quotes.js");
  assert.ok(searchDirectory("GME").some((s) => s.ticker === "GME"), "GME by ticker");
  assert.ok(searchDirectory("gamestop").some((s) => s.ticker === "GME"), "GME by company name");
  assert.ok(searchDirectory("BBW").some((s) => s.ticker === "BBW"), "BBW by ticker");
  assert.ok(searchDirectory("bear").some((s) => s.ticker === "BBW"), "BBW by company name");
  const m = new MockQuoteProvider();
  assert.equal((await m.getQuote("GME")).priceCents, 2250);
  assert.equal((await m.getQuote("BBW")).priceCents, 4525);
});

test("classroom ADR picks: TM + ADDYY are searchable with fixed mock prices", async () => {
  const { MockQuoteProvider, searchDirectory, normalizeTicker } = await import("./quotes.js");
  assert.equal(normalizeTicker("tm"), "TM");
  assert.equal(normalizeTicker("addyy"), "ADDYY");
  assert.ok(searchDirectory("TM").some((s) => s.ticker === "TM"), "TM by ticker");
  assert.ok(searchDirectory("toyota").some((s) => s.ticker === "TM"), "TM by company name");
  assert.ok(searchDirectory("ADDYY").some((s) => s.ticker === "ADDYY"), "ADDYY by ticker");
  assert.ok(searchDirectory("adidas").some((s) => s.ticker === "ADDYY"), "ADDYY by company name");
  const m = new MockQuoteProvider();
  assert.equal((await m.getQuote("TM")).priceCents, 19800);
  assert.equal((await m.getQuote("ADDYY")).priceCents, 11250);
});

test("Chime is searchable and classified as a Financials stock", async () => {
  const { MockQuoteProvider, searchDirectory } = await import("./quotes.js");
  const fs = await import("node:fs");
  const directory = JSON.parse(fs.readFileSync(new URL("./ticker-directory.json", import.meta.url), "utf8"));
  assert.ok(searchDirectory("CHYM").some((s) => s.ticker === "CHYM"));
  assert.ok(searchDirectory("Chime Financial").some((s) => s.ticker === "CHYM"));
  assert.deepEqual(directory.rows.find((row: string[]) => row[0] === "CHYM"), ["CHYM", "Chime Financial, Inc.", "STOCK"]);
  assert.equal(directory.meta.CHYM.sector, "Financials");
  assert.ok((await new MockQuoteProvider().getQuote("CHYM")).priceCents > 0);
});

test("finnhub adapter parses live quotes and handles gaps", async () => {
  const { FinnhubQuoteProvider } = await import("./quotes.js");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ c: 232.5, t: 1757966400 }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
  try {
    const quote = await new FinnhubQuoteProvider("test-key").getQuote("AAPL");
    assert.equal(quote.priceCents, 23250);
    assert.equal(quote.asOf, "2025-09-15T20:00:00.000Z");
    assert.equal(quote.source, "finnhub");
    assert.equal(quote.delayed, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
  globalThis.fetch = async () => new Response(JSON.stringify({ c: 0, t: 0 }), { status: 200 });
  try {
    await assert.rejects(
      new FinnhubQuoteProvider("test-key").getQuote("NOPE"),
      (e: any) => e.code === "NOT_FOUND",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  await assert.rejects(
    new FinnhubQuoteProvider("").getQuote("AAPL"),
    (e: any) => e.code === "UNAVAILABLE",
  );
});
