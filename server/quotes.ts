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

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Full search directory (S&P 500 + major ETFs, built by
 * scripts/build-ticker-directory.mjs). Loaded once, server-side only —
 * never shipped to the browser. Falls back to the classroom list if the
 * generated file is missing.
 */
interface DirectoryRow { ticker: string; name: string; kind: string }
let directoryCache: DirectoryRow[] | null = null;
export function loadDirectory(): DirectoryRow[] {
  if (directoryCache) return directoryCache;
  try {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "ticker-directory.json"), "utf8"));
    directoryCache = (raw.rows as string[][]).map(([ticker, name, kind]) => ({ ticker, name, kind }));
  } catch {
    directoryCache = SECURITY_DIRECTORY.map((s) => ({ ...s, kind: "STOCK" }));
  }
  return directoryCache;
}

/** Ranked search: classroom picks first, then ticker prefix, ticker substring, name. */
export function searchDirectory(q: string, limit = 8): SecurityInfo[] {
  const needle = q.trim().toUpperCase();
  if (!needle) return [];
  const dir = loadDirectory();
  const pinned = new Set(SECURITY_DIRECTORY.map((s) => s.ticker));
  const rank = (r: DirectoryRow): number => {
    if (pinned.has(r.ticker) && (r.ticker.includes(needle) || r.name.toUpperCase().includes(needle))) return 0;
    if (r.ticker.startsWith(needle)) return 1;
    if (r.ticker.includes(needle)) return 2;
    if (r.name.toUpperCase().includes(needle)) return 3;
    return -1;
  };
  return dir
    .map((r) => ({ r, k: rank(r) }))
    .filter((x) => x.k >= 0)
    .sort((a, b) => a.k - b.k || (a.r.ticker < b.r.ticker ? -1 : 1))
    .slice(0, limit)
    .map((x) => ({ ticker: x.r.ticker, name: x.r.name }));
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
    return searchDirectory(q);
  }

  async getQuote(ticker: string): Promise<Quote> {
    const t = normalizeTicker(ticker);
    const known = this.prices.get(t);
    // Classroom tickers use fixed lesson prices. Anything else in mock mode
    // gets a stable deterministic stand-in price (same ticker → same price,
    // across restarts) so the full search library stays usable offline.
    // Every mock quote is labeled source/mock + delayed in the UI.
    const price = known ?? pseudoPriceCents(t);
    return { ticker: t, priceCents: price, asOf: new Date().toISOString(), source: "mock", delayed: true };
  }
}

/** Stable hash → $5.00–$600.00 stand-in price for mock mode. */
export function pseudoPriceCents(ticker: string): number {
  let h = 2166136261;
  for (const c of ticker) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return 500 + Math.floor(((h >>> 0) / 4294967296) * 59500);
}

/**
 * Optional free delayed-quote adapter (no subscription, no key).
 * Uses the Stooq free CSV endpoint server-side. Always marked delayed.
 * Any failure surfaces as UNAVAILABLE — the caller returns a clean 503.
 */
export class StooqQuoteProvider implements QuoteProvider {
  readonly name = "stooq";
  async search(q: string): Promise<SecurityInfo[]> {
    return searchDirectory(q);
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

/**
 * Finnhub adapter (free tier, API key). 60 calls/min on the free plan, which
 * covers a classroom behind the 60s server-side cache. Key stays server-side
 * in SIMLIFE_MARKET_API_KEY. Always marked delayed.
 */
export class FinnhubQuoteProvider implements QuoteProvider {
  readonly name = "finnhub";
  private key: string;
  constructor(key?: string) {
    this.key = key ?? process.env["SIMLIFE_MARKET_API_KEY"] ?? "";
  }
  async search(q: string): Promise<SecurityInfo[]> {
    return searchDirectory(q);
  }
  async getQuote(ticker: string): Promise<Quote> {
    const t = normalizeTicker(ticker);
    if (!this.key) throw new QuoteError("UNAVAILABLE", "Live quotes are not configured. Try again later.");
    let body: any;
    try {
      const resp = await fetch(
        `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(t)}&token=${encodeURIComponent(this.key)}`,
        { signal: AbortSignal.timeout(8000) },
      );
      if (!resp.ok) throw new Error(`http ${resp.status}`);
      body = await resp.json();
    } catch {
      throw new QuoteError("UNAVAILABLE", "Live quotes are unavailable right now. Try again later.");
    }
    const price = Number(body?.c);
    if (!Number.isFinite(price) || price <= 0) {
      throw new QuoteError("NOT_FOUND", `No live quote for ${t}. Check the spelling.`);
    }
    const ts = Number(body?.t) > 0 ? new Date(Number(body.t) * 1000).toISOString() : new Date().toISOString();
    return { ticker: t, priceCents: Math.round(price * 100), asOf: ts, source: "finnhub", delayed: true };
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
  const inner =
    which === "finnhub" ? new FinnhubQuoteProvider()
    : which === "stooq" ? new StooqQuoteProvider() // legacy; Stooq now bot-walls server fetches
    : new MockQuoteProvider();
  return new CachedQuotes(inner);
}
