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
