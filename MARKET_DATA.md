# Market-Data Provider Recommendation

Classroom constraint: delayed quotes are instructionally fine (we teach
long-term investing, not day trading), but the data must be legal to use,
free or cheap, keyed server-side, and clearly labeled as delayed.

## Recommendation

| Stage | Provider | Why |
|---|---|---|
| Local dev + automated tests | **Mock** (built in) | Deterministic, offline, controllable prices for tests and demos |
| Classroom pilot (no budget) | **Finnhub free tier** (built in, needs free API key) | 60 calls/min free; covers a class behind our 60s server-side cache; proper timestamps |
| ~~Stooq free CSV~~ | **Dead as of Sept 2026** — Stooq put its quote endpoints behind a browser proof-of-work challenge; server fetches get a 404/challenge page. The adapter remains in code as legacy but is not recommended. |
| Funded / production | **Finnhub** (free tier) or **Alpha Vantage** (free tier), behind our `QuoteProvider` interface | Documented free tiers for development/small use; keys stay in env |

To add a keyed vendor later: implement `QuoteProvider` in
`server/quotes.ts` (about 30 lines: `search` + `getQuote`), read the key
from `SIMLIFE_MARKET_API_KEY`, and select it in `makeQuoteProvider()`.
The browser never talks to the vendor — only `/api/quotes` and `/api/search`.

## What we deliberately do NOT do

- No scraping of Google Finance, Yahoo Finance, or any site in violation of
  its terms. (Yahoo has no supported free API; unofficial endpoints break and
  violate terms.)
- No API keys in the browser or in git. `.env.example` holds placeholders only.
- No real-time data promises: every price in the UI is labeled **delayed**
  with its timestamp and source.

## Notes on evaluated options (Sept 2026)

- **Stooq**: free CSV quote endpoint, no authentication, delayed. Terms are
  for non-commercial use — confirm with the district before projecting live
  prices to a class. Rate-limit politely; our 60s server-side cache does this
  by design.
- **Finnhub**: free tier (~60 calls/min) covers a classroom behind our cache;
  requires an API key. Good production candidate.
- **Alpha Vantage**: free tier (25 req/day on the current free plan — verify,
  it changes) is too thin for a whole class; fine as a fallback, not primary.
- **Polygon.io / IEX / Twelve Data**: solid but paid tiers start quickly;
  revisit only with a budget.
- **Py/JS charting**: out of scope for the MVP (no complicated charts by design).
