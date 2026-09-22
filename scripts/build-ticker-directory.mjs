/**
 * Build server/ticker-directory.json.
 *
 * Output shape (v2):
 *   {
 *     updated, count,
 *     rows: [[ticker, name, kind], ...]        <- UNCHANGED from v1, server/quotes.ts reads this
 *     meta: { TICKER: { kind, sector, subIndustry, assetClass, region, breadth, capTier, what } }
 *   }
 *
 * `rows` is deliberately left exactly as it was so quotes.ts and ticker search
 * keep working with no code change. `meta` is the new part: it is what the
 * Class-tab assignment checks read (see CLASS_TAB_PLAN.md §5).
 *
 * Sources:
 *   - Individual stocks: the Wikipedia S&P 500 table, which already carries a
 *     GICS Sector and GICS Sub-Industry column per company. No API key.
 *   - Funds: scripts/etf-metadata.json, hand-curated (ETFs are not on that list).
 *
 * This validates before it writes. If the Wikipedia table's markup changes and
 * parsing degrades, it aborts and leaves the existing file alone rather than
 * silently shipping a directory with no sectors in it.
 *
 * Usage: node scripts/build-ticker-directory.mjs [outPath]
 *        node scripts/build-ticker-directory.mjs --dry-run
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const out = args.find((a) => !a.startsWith("--")) || path.join(here, "..", "server", "ticker-directory.json");

const GICS_SECTORS = new Set([
  "Information Technology", "Health Care", "Financials", "Consumer Discretionary",
  "Communication Services", "Industrials", "Consumer Staples", "Energy",
  "Utilities", "Real Estate", "Materials",
]);

// Classroom picks that are NOT S&P 500 constituents, so no table supplies their
// sector. Students reach for these constantly — anything outside the index has
// to be listed here by hand or it lands in assignments as UNKNOWN.
//
// TO ADD ONE: run scripts/class-portfolio-snapshot.mjs. Any ticker it prints
// with "?" for its type is missing from the directory; it prints a ready-made
// line to paste in below. Then re-run this script.
//
// [ticker, name, GICS sector, sub-industry, capTier]
const EXTRA_STOCKS = [
  ["GME", "GameStop", "Consumer Discretionary", "Specialty Retail", "SMALL"],
  ["BBW", "Build-A-Bear Workshop", "Consumer Discretionary", "Specialty Retail", "SMALL"],
  ["CROX", "Crocs, Inc.", "Consumer Discretionary", "Footwear", "MID"],
  // Foreign ADR picks students ask for: not S&P 500, so no table row exists.
  ["TM", "Toyota Motor Corp.", "Consumer Discretionary", "Automobiles", "LARGE"],
  ["ADDYY", "adidas AG", "Consumer Discretionary", "Footwear", "LARGE"],
  // S&P 500 members whose Wikipedia row does not expose its sector cell the way
  // the others do (the dry run names any such ticker). Classified by hand so
  // they do not sit in the directory as UNKNOWN.
  ["EME", "EMCOR Group", "Industrials", "Construction & Engineering", "LARGE"],
  ["KVUE", "Kenvue", "Consumer Staples", "Personal Care Products", "LARGE"],
];

const clean = (s) => (s || "")
  .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2")   // [[Link|Text]] -> Text
  .replace(/\{\{[^}]*\}\}/g, "")                     // strip templates
  .replace(/<[^>]*>/g, "")                           // strip tags/refs
  .replace(/&amp;/g, "&")
  .replace(/\s+/g, " ")
  .trim();

console.log("Fetching the S&P 500 table from Wikipedia…");
const res = await fetch(
  "https://en.wikipedia.org/w/api.php?action=parse&page=List_of_S%26P_500_companies&prop=wikitext&format=json",
  { headers: { "User-Agent": "SimLife-classroom-build/2.0 (educational use)" } },
);
if (!res.ok) throw new Error(`wikipedia fetch failed: ${res.status} ${res.statusText}`);
const text = (await res.json()).parse.wikitext["*"];

const rows = [];
const meta = {};
const seen = new Set();
const noSectorFound = [];

// Parse by ROW BLOCK, not by fixed cell position.
//
// An earlier version captured "the third cell" as the sector. A handful of
// rows carry an extra cell (a footnote, a differently-templated name), which
// shifted those rows by one and put a GICS SUB-INDUSTRY in the sector slot -
// "Construction & Engineering", "Personal Care Products". Rather than special-
// case them, find the cell that IS one of the 11 sectors and read its
// neighbours. Column order can now drift without breaking the build.
for (const block of text.split(/\n\|-/)) {
  const sym = block.match(/\{\{(?:NyseSymbol|NasdaqSymbol)\|([^}]+)\}\}/);
  if (!sym) continue;
  const ticker = clean(sym[1]).toUpperCase();
  if (!ticker || seen.has(ticker)) continue;

  const cells = [...block.matchAll(/^\|\|[ \t]*([^\n]*)$/gm)].map((m) => clean(m[1]));
  const sectorIdx = cells.findIndex((c) => GICS_SECTORS.has(c));

  const sector = sectorIdx >= 0 ? cells[sectorIdx] : "";
  const subIndustry = sectorIdx >= 0 ? (cells[sectorIdx + 1] || "") : "";
  // The company name is the last non-empty cell before the sector. The symbol
  // cell cleans to empty (its template is stripped), so this skips it.
  let name = "";
  for (let k = (sectorIdx >= 0 ? sectorIdx : cells.length) - 1; k >= 0; k--) {
    if (cells[k]) { name = cells[k]; break; }
  }

  if (!sector) noSectorFound.push(ticker);
  seen.add(ticker);
  rows.push([ticker, name.slice(0, 80), "STOCK"]);
  meta[ticker] = {
    kind: "STOCK",
    sector,
    subIndustry,
    assetClass: "EQUITY",
    region: "US",
    breadth: "SINGLE_COMPANY",
    capTier: "LARGE",           // S&P 500 membership implies large cap
    what: "",
  };
}

console.log(`Parsed ${rows.length} S&P 500 constituents.`);

// ---- validation on the scraped half, before anything is written -----------
const problems = [];
if (rows.length < 450) problems.push(`only ${rows.length} constituents parsed (expected ~500) — the table markup probably changed`);
const withSector = Object.values(meta).filter((m) => m.sector).length;
if (rows.length && withSector / rows.length < 0.95) {
  problems.push(`only ${withSector}/${rows.length} rows matched a GICS sector — the sector column probably moved`);
}
// NOTE: any row that matched no sector is reported near the end, AFTER
// EXTRA_STOCKS has had its chance to classify it. Reporting here instead would
// name tickers that end up perfectly well classified two steps later.
if (problems.length) {
  console.error("\nABORTED — existing ticker-directory.json left untouched:\n");
  for (const p of problems) console.error("  • " + p);
  console.error("\nInspect the wikitext and update the parser in this script.");
  process.exit(1);
}

// ---- funds ----------------------------------------------------------------
const etfPath = path.join(here, "etf-metadata.json");
const funds = JSON.parse(fs.readFileSync(etfPath, "utf8")).funds;
for (const [ticker, f] of Object.entries(funds)) {
  if (seen.has(ticker)) { console.warn(`  note: ${ticker} is both a fund and an index constituent — keeping the fund record`); }
  else { seen.add(ticker); rows.push([ticker, f.name, "ETF"]); }
  meta[ticker] = {
    kind: "ETF",
    sector: f.sector || "",
    subIndustry: "",
    assetClass: f.assetClass,
    region: f.region,
    breadth: f.breadth,
    capTier: f.capTier || "",
    what: f.what || "",
  };
}

for (const [ticker, name, sector, subIndustry, capTier] of EXTRA_STOCKS) {
  if (!seen.has(ticker)) { seen.add(ticker); rows.push([ticker, name, "STOCK"]); }
  meta[ticker] = { kind: "STOCK", sector, subIndustry, assetClass: "EQUITY", region: "US", breadth: "SINGLE_COMPANY", capTier, what: "" };
}

rows.sort((a, b) => (a[0] < b[0] ? -1 : 1));

// ---- report ---------------------------------------------------------------
const bySector = {};
for (const m of Object.values(meta)) if (m.kind === "STOCK" && m.sector) bySector[m.sector] = (bySector[m.sector] || 0) + 1;
const broad = Object.values(meta).filter((m) => m.breadth === "BROAD").length;

console.log(`\nDirectory: ${rows.length} symbols (${rows.filter((r) => r[2] === "STOCK").length} stocks, ${rows.filter((r) => r[2] === "ETF").length} funds)`);
console.log(`Sectors covered: ${Object.keys(bySector).length} of 11`);
for (const s of [...GICS_SECTORS]) console.log(`  ${s.padEnd(24)} ${String(bySector[s] || 0).padStart(3)}`);
console.log(`Funds classified BROAD (usable for a "buy a broad ETF" task): ${broad}`);
const noSector = Object.entries(meta).filter(([, m]) => m.kind === "STOCK" && !m.sector).map(([t]) => t);
if (noSector.length) console.log(`Stocks with no sector (will report as UNKNOWN in assignments): ${noSector.join(", ")}`);

if (dryRun) { console.log("\n--dry-run: nothing written."); process.exit(0); }

const payload = { updated: new Date().toISOString().slice(0, 10), version: 2, count: rows.length, rows, meta };
fs.writeFileSync(out, JSON.stringify(payload));
console.log(`\nWrote ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
