# Week 2 module — Building a Balanced Portfolio

The first real module for the Class tab (`CLASS_TAB_PLAN.md`). Pairs with the
deck of the same name. Written as the seed data shape from §3 of the plan, so
it can go straight into `server/seed-modules.ts` once the tables exist.

---

## Data prerequisite — one command, resolved

The sector gap flagged earlier is fixed, and the fix turned out to be simpler
than the Finnhub backfill first proposed. **Wikipedia's S&P 500 table already
carries a GICS Sector and a GICS Sub-Industry column per company**, so no API
key, no rate limiting and no industry-string mapping table are needed.

Run once, from Terminal (it needs real internet, which a sandbox does not have):

```
cd ~/Desktop/_Active/ths_textbook/simlife-investing
node scripts/build-ticker-directory.mjs --dry-run   # look at the report first
node scripts/build-ticker-directory.mjs             # then write it
```

`--dry-run` prints the sector counts and writes nothing. The script validates
before writing and **aborts rather than overwriting** if fewer than 450
constituents parse, if under 95% get a valid sector, or if a sector name it
does not recognize appears — so a future change to the Wikipedia markup fails
loudly instead of quietly shipping a directory with no sectors in it.

`rows` keeps its exact v1 shape, so `server/quotes.ts` and ticker search are
untouched. The new data lands in a sibling `meta` object:

```jsonc
"meta": {
  "NKE":  { "kind":"STOCK", "sector":"Consumer Discretionary", "subIndustry":"Footwear",
            "assetClass":"EQUITY", "region":"US", "breadth":"SINGLE_COMPANY", "capTier":"LARGE" },
  "VOO":  { "kind":"ETF", "sector":"", "assetClass":"EQUITY", "region":"US",
            "breadth":"BROAD", "capTier":"LARGE", "what":"The 500 largest U.S. companies." },
  "ARKB": { "kind":"ETF", "assetClass":"CRYPTO", "region":"GLOBAL",
            "breadth":"SINGLE_ASSET", "what":"Bitcoin. One asset." }
}
```

Funds are classified by hand in `scripts/etf-metadata.json` (42 of them, not on
any index list). `breadth` is the field that makes item 3 possible:

| breadth | count | means |
|---|---|---|
| `BROAD` | 14 | spread across sectors — satisfies "buy a broad ETF" |
| `TILTED` | 8 | diversified but leaning one way (QQQ, dividend funds, value/growth) |
| `SECTOR` | 9 | one sector only (the XL* funds, VNQ) |
| `SINGLE_ASSET` | 11 | one thing (gold, the bitcoin and ethereum funds) |

`breadth` is a judgment call, not a fact — worth reading the file once and
overruling anything you disagree with before an assignment depends on it. The
`TILTED` bucket is the arguable one: QQQ holds 100 companies across several
sectors but is heavily technology, so it is deliberately not `BROAD`. If you
would accept QQQ for item 3, change that one line.

## Module

```jsonc
{
  "title": "Building a Balanced Portfolio",
  "summary": "Your three picks were probably one bet. Fix that, and explain what you changed.",
  "status": "draft",
  "items": [ /* below, in order */ ]
}
```

### Item 1 — `reading`
> **Before you start.** Last week you bought three brands you like. Today you
> are not selling them. You are adding to them, so that one bad year in one
> industry does not take your whole account with it.

`spec: {}` · required

### Item 2 — `written`
> Look at your three picks from last week. **What sector is each one in, and
> how did you decide?** If two or three of them landed in the same sector, say
> which one and why you think that happened.

`spec: { "minWords": 40 }` · required

*Answered before they trade — it commits them to a claim they then have to act on.*

### Item 3 — `task`
> **Buy at least one broad ETF.** One purchase that covers many sectors at once.

`spec: { "check": "owns_asset_type", "params": { "type": "ETF", "breadth": "BROAD", "min": 1 } }`
Meter: `0 of 1 broad ETF owned`
`detail` lists which holdings counted, so a student who bought a narrow fund
sees why it did not.

### Item 4 — `task`
> **Hold companies in at least three different sectors.** Your ETF does not
> count for this one — this is about the individual companies you chose.

`spec: { "check": "owns_sector_count", "params": { "min": 3, "excludeEtfs": true } }`
Meter: `1 of 3 sectors represented`
`detail` lists the sectors currently covered and flags anything `UNKNOWN`.

*`excludeEtfs` is deliberate. A broad ETF technically covers all 11 sectors, so
without it item 4 auto-satisfies the moment item 3 does, and the student never
has to think about a single sector.*

### Item 5 — `written`
> **Which sector did you add, and why that one?** Not "to get three" — what
> does that sector do, and why does it make your portfolio less dependent on
> people having spare money to spend?

`spec: { "minWords": 50 }` · required

*The real assessment. Items 3 and 4 prove they clicked; this proves they understood.*

### Item 6 — `sort`
> Put each ticker in its sector.

`spec` buckets: Consumer Discretionary · Consumer Staples · Information
Technology · Health Care · Financials · Utilities
Tokens (8, two per bucket for four of the six — deliberately includes the two
that students argue about):

| ticker | bucket | why it is here |
|---|---|---|
| NKE | Consumer Discretionary | the obvious one |
| SBUX | Consumer Discretionary | ditto |
| COST | Consumer Staples | students almost always say discretionary |
| PG | Consumer Staples | the clean example |
| NVDA | Information Technology | easy |
| AMZN | Consumer Discretionary | students almost always say tech |
| JNJ | Health Care | easy |
| NEE | Utilities | most will not know it, which is the point |

Partial credit per token. COST and AMZN are the two that teach.

### Item 7 — `choice`
> Your friend says "I'm diversified, I own five stocks." Which question tells
> you the most about whether that is true?

- How much money is in each one?
- **What are the five, and what do they do?** ← correct
- How long have you owned them?
- Are any of them up right now?

`spec: { "multi": false }` · explanation on submit ties back to the exit ticket.

---

## Progress the teacher sees

Per student: items 3 and 4 as meters (auto), items 2, 5 written (needs review),
6 and 7 auto-scored. Module reads `needs_review` until items 2 and 5 are read.

The column view is the one to build first — reading all 21 answers to item 5 in
one pass is the actual grading workflow for this module.

## Notes

- No selling is required anywhere. The deck's core-and-satellite slide promises
  they keep their brands; the module must not contradict it.
- Item 4 is the one students will get stuck on. The `detail` payload naming the
  sectors they already cover is what unsticks them without a teacher.
- Cash: students need enough brokerage cash to buy an ETF plus a new position.
  Check the roster before assigning — a student sitting at near-zero cash
  cannot complete items 3 or 4, and the meter will read as failure when it is
  really a funding problem.
