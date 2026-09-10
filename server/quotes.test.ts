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
