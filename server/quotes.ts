/**
 * Market-data provider abstraction. The app never depends on one vendor:
 * add a class implementing QuoteProvider and select it with
 * SIMLIFE_QUOTE_PROVIDER. Keys stay server-side; the browser only ever
 * sees cached quotes from /api/quotes.
 */
export interface Quote {
  ticker: string;
  priceCents: number;
  asOf: string;      // ISO timestamp of the quote
  source: string;    // provider name
  delayed: boolean;  // always true for classroom data
}

export interface SecurityInfo {
  ticker: string;
  name: string;
}

export class QuoteError extends Error {
  code: "NOT_FOUND" | "UNAVAILABLE" | "INVALID_TICKER";
  constructor(code: QuoteError["code"], msg: string) {
    super(msg);
    this.code = code;
  }
}

export function normalizeTicker(raw: unknown): string {
  const t = typeof raw === "string" ? raw.trim().toUpperCase().replace(/[^A-Z.]/g, "") : "";
  if (!/^[A-Z]{1,5}(\.[A-Z])?$/.test(t)) throw new QuoteError("INVALID_TICKER", "Enter a valid U.S. ticker symbol (e.g. AAPL, VOO).");
  return t;
}

export interface QuoteProvider {
  readonly name: string;
  search(q: string): Promise<SecurityInfo[]>;
  getQuote(ticker: string): Promise<Quote>;
}

/** Curated classroom directory: widely-held U.S. stocks + index ETFs. */
export const SECURITY_DIRECTORY: SecurityInfo[] = [
  { ticker: "AAPL", name: "Apple Inc." },
  { ticker: "MSFT", name: "Microsoft Corp." },
  { ticker: "NVDA", name: "NVIDIA Corp." },
  { ticker: "AMZN", name: "Amazon.com Inc." },
  { ticker: "TSLA", name: "Tesla Inc." },
  { ticker: "GOOGL", name: "Alphabet Inc. (Class A)" },
  { ticker: "META", name: "Meta Platforms Inc." },
  { ticker: "JNJ", name: "Johnson & Johnson" },
  { ticker: "KO", name: "Coca-Cola Co." },
  { ticker: "DIS", name: "Walt Disney Co." },
  { ticker: "VOO", name: "Vanguard S&P 500 ETF" },
  { ticker: "VTI", name: "Vanguard Total Stock Market ETF" },
  { ticker: "QQQ", name: "Invesco QQQ (Nasdaq 100) ETF" },
  { ticker: "SCHD", name: "Schwab U.S. Dividend Equity ETF" },
  { ticker: "BND", name: "Vanguard Total Bond Market ETF" },
];

/** Deterministic mock for local dev + automated tests. Prices in cents. */
export class MockQuoteProvider implements QuoteProvider {
  readonly name = "mock";
  private prices = new Map<string, number>([
    ["AAPL", 23250], ["MSFT", 42800], ["NVDA", 13100], ["AMZN", 19700],
    ["TSLA", 24800], ["GOOGL", 17800], ["META", 58500], ["JNJ", 15400],
    ["KO", 6400], ["DIS", 11400], ["VOO", 58500], ["VTI", 28900],
    ["QQQ", 51200], ["SCHD", 2820], ["BND", 7300],
  ]);

  setPrice(ticker: string, priceCents: number): void {
    this.prices.set(ticker.toUpperCase(), priceCents);
  }

  async search(q: string): Promise<SecurityInfo[]> {
    const needle = q.trim().toUpperCase();
    if (!needle) return [];
    return SECURITY_DIRECTORY.filter(
      (s) => s.ticker.includes(needle) || s.name.toUpperCase().includes(needle),
    ).slice(0, 8);
  }

  async getQuote(ticker: string): Promise<Quote> {
    const t = normalizeTicker(ticker);
    const price = this.prices.get(t);
    if (price === undefined) throw new QuoteError("NOT_FOUND", `No quote for ${t}. Try a ticker from the classroom list.`);
    return { ticker: t, priceCents: price, asOf: new Date().toISOString(), source: "mock", delayed: true };
  }
}

/**
 * Optional free delayed-quote adapter (no subscription, no key).
 * Uses the Stooq free CSV endpoint server-side. Always marked delayed.
 * Any failure surfaces as UNAVAILABLE — the caller returns a clean 503.
 */
export class StooqQuoteProvider implements QuoteProvider {
  readonly name = "stooq";
  async search(q: string): Promise<SecurityInfo[]> {
    const needle = q.trim().toUpperCase();
    if (!needle) return [];
    return SECURITY_DIRECTORY.filter(
      (s) => s.ticker.includes(needle) || s.name.toUpperCase().includes(needle),
    ).slice(0, 8);
  }
  async getQuote(ticker: string): Promise<Quote> {
    const t = normalizeTicker(ticker);
    let text: string;
    try {
      const resp = await fetch(
        `https://stooq.com/q/l/?s=${t.toLowerCase()}.us&f=sd2t2ohlcv&h&e=csv`,
        { signal: AbortSignal.timeout(8000) },
      );
      if (!resp.ok) throw new Error(`http ${resp.status}`);
      text = await resp.text();
    } catch {
      throw new QuoteError("UNAVAILABLE", "Live quotes are unavailable right now. Try again later.");
    }
    const lines = text.trim().split("\n");
    const row = lines[1]?.split(",");
    const close = row ? Number(row[6]) : NaN;
    if (!row || !Number.isFinite(close) || close <= 0) {
      throw new QuoteError("NOT_FOUND", `No quote for ${t}. Try a ticker from the classroom list.`);
    }
    // Preserve the provider's market timestamp. Using request time here makes
    // an old delayed close look current, which is misleading in a trade log.
    const providerTime = new Date(`${row[1]}T${row[2] || "00:00:00"}Z`);
    if (!Number.isFinite(providerTime.getTime())) {
      throw new QuoteError("UNAVAILABLE", "The quote provider returned an invalid timestamp. Try again later.");
    }
    return {
      ticker: t,
      priceCents: Math.round(close * 100),
      asOf: providerTime.toISOString(),
      source: "stooq",
      delayed: true,
    };
  }
}

/** Server-side TTL cache in front of any provider. */
export class CachedQuotes {
  private cache = new Map<string, { quote: Quote; expires: number }>();
  constructor(private inner: QuoteProvider, private ttlMs = 60_000) {}
  get providerName(): string { return this.inner.name; }
  get provider(): QuoteProvider { return this.inner; }
  async search(q: string): Promise<SecurityInfo[]> { return this.inner.search(q); }
  async getQuote(ticker: string): Promise<{ quote: Quote; cached: boolean }> {
    const t = normalizeTicker(ticker);
    const hit = this.cache.get(t);
    if (hit && hit.expires > Date.now()) return { quote: hit.quote, cached: true };
    const quote = await this.inner.getQuote(t);
    this.cache.set(t, { quote, expires: Date.now() + this.ttlMs });
    return { quote, cached: false };
  }
  clear(): void { this.cache.clear(); }
}

export function makeQuoteProvider(): CachedQuotes {
  const which = (process.env["SIMLIFE_QUOTE_PROVIDER"] || "mock").toLowerCase();
  const inner = which === "stooq" ? new StooqQuoteProvider() : new MockQuoteProvider();
  return new CachedQuotes(inner);
}
