/**
 * Build server/ticker-directory.json: S&P 500 constituents (via the Wikipedia
 * API) plus a hand-curated list of major ETFs. Re-run occasionally to refresh.
 * The app loads the JSON server-side only (never shipped to the browser).
 * Usage: node scripts/build-ticker-directory.mjs [outPath]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] || path.join(here, "..", "server", "ticker-directory.json");

const ETFS = [
  ["SPY", "SPDR S&P 500 ETF"], ["VOO", "Vanguard S&P 500 ETF"],
  ["VTI", "Vanguard Total Stock Market ETF"], ["QQQ", "Invesco QQQ Nasdaq-100 ETF"],
  ["DIA", "SPDR Dow Jones Industrial ETF"], ["IWM", "iShares Russell 2000 ETF"],
  ["SCHD", "Schwab U.S. Dividend Equity ETF"], ["SCHX", "Schwab U.S. Large-Cap ETF"],
  ["SCHA", "Schwab U.S. Small-Cap ETF"], ["SCHF", "Schwab International Equity ETF"],
  ["VEA", "Vanguard Developed Markets ETF"], ["VWO", "Vanguard Emerging Markets ETF"],
  ["VXUS", "Vanguard Total International Stock ETF"],
  ["VIG", "Vanguard Dividend Appreciation ETF"], ["VYM", "Vanguard High Dividend Yield ETF"],
  ["VTV", "Vanguard Value ETF"], ["VUG", "Vanguard Growth ETF"],
  ["BND", "Vanguard Total Bond Market ETF"], ["AGG", "iShares Core U.S. Bond ETF"],
  ["BNDX", "Vanguard Total International Bond ETF"], ["TLT", "iShares 20+ Year Treasury ETF"],
  ["IEF", "iShares 7-10 Year Treasury ETF"], ["GLD", "SPDR Gold Shares"],
  ["VNQ", "Vanguard Real Estate ETF"],
  ["IBIT", "iShares Bitcoin Trust ETF"], ["FBTC", "Fidelity Wise Origin Bitcoin Fund"],
  ["GBTC", "Grayscale Bitcoin Trust"], ["ARKB", "ARK 21Shares Bitcoin ETF"],
  ["BITB", "Bitwise Bitcoin ETF"], ["HODL", "VanEck Bitcoin ETF"],
  ["ETHA", "iShares Ethereum Trust ETF"], ["ETHE", "Grayscale Ethereum Trust"],
  ["FETH", "Fidelity Ethereum Fund"], ["ETHW", "Bitwise Ethereum ETF"],
  ["XLK", "Technology Select Sector SPDR"], ["XLF", "Financial Select Sector SPDR"],
  ["XLE", "Energy Select Sector SPDR"], ["XLV", "Health Care Select Sector SPDR"],
  ["XLI", "Industrial Select Sector SPDR"], ["XLY", "Consumer Discretionary SPDR"],
  ["XLP", "Consumer Staples SPDR"], ["XLU", "Utilities Select Sector SPDR"],
];

const res = await fetch("https://en.wikipedia.org/w/api.php?action=parse&page=List_of_S%26P_500_companies&prop=wikitext&format=json");
if (!res.ok) throw new Error(`wikipedia fetch failed: ${res.status}`);
const text = (await res.json()).parse.wikitext["*"];
const rows = [];
const seen = new Set();
for (const m of text.matchAll(/\|\|\s*\{\{(?:NyseSymbol|NasdaqSymbol)\|([^}]+)\}\}[^\n]*\n\|\|\s*\[\[([^\]\n]+)\]\]/g)) {
  const ticker = m[1].trim().toUpperCase();
  const name = (m[2].includes("|") ? m[2].split("|")[1] : m[2]).trim().slice(0, 80);
  if (!ticker || seen.has(ticker)) continue;
  seen.add(ticker);
  rows.push([ticker, name, "STOCK"]);
}
for (const [ticker, name] of ETFS) {
  if (!seen.has(ticker)) { seen.add(ticker); rows.push([ticker, name, "ETF"]); }
}
rows.sort((a, b) => (a[0] < b[0] ? -1 : 1));
fs.writeFileSync(out, JSON.stringify({ updated: new Date().toISOString().slice(0, 10), count: rows.length, rows }));
console.log(`wrote ${out}: ${rows.length} symbols`);
