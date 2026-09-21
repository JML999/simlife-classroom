/**
 * Class portfolio snapshot — what did students actually buy?
 *
 * Reads the configured SIMLIFE_DATABASE_URL (or local SQLite when empty) and
 * prints an aggregate picture of current holdings across a class. Read-only:
 * it issues SELECTs and nothing else.
 *
 * Usage:  node scripts/class-portfolio-snapshot.mjs [classNameFragment]
 * Example: node scripts/class-portfolio-snapshot.mjs "3rd"
 */
import fs from "node:fs";
import path from "node:path";

const envPath = path.join(process.cwd(), ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const filter = (process.argv[2] || "").toLowerCase();
const url = (process.env.SIMLIFE_DATABASE_URL || "").trim();

const dir = JSON.parse(fs.readFileSync("server/ticker-directory.json", "utf8"));
const meta = new Map(dir.rows.map(([t, name, type]) => [t, { name, type }]));

// Holdings are derived from the append-only ledger: buys add micro-shares,
// sells remove them. Same derivation the portfolio endpoint uses.
const SQL = `
  SELECT c.name AS class_name, l.account_id, l.ticker, SUM(l.qty_micro) AS qty
  FROM ledger l
  JOIN accounts a ON a.id = l.account_id
  JOIN users u ON u.id = a.user_id
  LEFT JOIN classes c ON c.id = u.class_id
  WHERE l.ticker IS NOT NULL
  GROUP BY c.name, l.account_id, l.ticker
  HAVING SUM(l.qty_micro) > 0
`;

let rows;
if (url) {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  rows = (await client.query(SQL)).rows;
  await client.end();
} else {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync("data/simlife.db");
  rows = db.prepare(SQL).all();
}

const byClass = new Map();
for (const r of rows) {
  const cls = r.class_name || "(no class)";
  if (filter && !cls.toLowerCase().includes(filter)) continue;
  if (!byClass.has(cls)) byClass.set(cls, []);
  byClass.get(cls).push(r);
}

if (byClass.size === 0) { console.log("No holdings found" + (filter ? ` for "${filter}"` : "") + "."); process.exit(0); }

for (const [cls, list] of byClass) {
  const students = new Set(list.map((r) => r.account_id));
  const holders = new Map();      // ticker -> Set(account)
  const perStudentTypes = new Map();
  for (const r of list) {
    if (!holders.has(r.ticker)) holders.set(r.ticker, new Set());
    holders.get(r.ticker).add(r.account_id);
    const type = meta.get(r.ticker)?.type || "UNKNOWN";
    if (!perStudentTypes.has(r.account_id)) perStudentTypes.set(r.account_id, new Set());
    perStudentTypes.get(r.account_id).add(type);
  }
  const etfOwners = [...perStudentTypes.values()].filter((s) => s.has("ETF")).length;
  const onlyStocks = [...perStudentTypes.values()].filter((s) => s.has("STOCK") && !s.has("ETF")).length;
  const counts = [...perStudentTypes.entries()].map(([id]) => list.filter((r) => r.account_id === id).length);
  const avg = counts.reduce((a, b) => a + b, 0) / (counts.length || 1);

  console.log(`\n=== ${cls} ===`);
  console.log(`students holding anything : ${students.size}`);
  console.log(`distinct tickers owned    : ${holders.size}`);
  console.log(`avg positions per student : ${avg.toFixed(1)}`);
  console.log(`students owning an ETF    : ${etfOwners}`);
  console.log(`students owning ONLY single stocks : ${onlyStocks}`);
  const unknown = [...holders.keys()].filter((tk) => !meta.has(tk)).sort();
  if (unknown.length) {
    console.log(`\n  !! ${unknown.length} ticker(s) NOT in ticker-directory.json: ${unknown.join(", ")}`);
    console.log(`     These have no sector, so Class-tab assignments will score them as UNKNOWN.`);
    console.log(`     Add to EXTRA_STOCKS in scripts/build-ticker-directory.mjs, then rebuild:`);
    for (const tk of unknown) console.log(`       ["${tk}", "<company name>", "<GICS sector>", "<sub-industry>", "MID"],`);
  }
  console.log(`\nmost-owned tickers:`);
  [...holders.entries()]
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, 20)
    .forEach(([t, set]) => {
      const m = meta.get(t);
      const pct = Math.round((set.size / students.size) * 100);
      console.log(`  ${t.padEnd(7)} ${String(set.size).padStart(3)} students (${String(pct).padStart(3)}%)  ${m ? m.type.padEnd(5) : "?".padEnd(5)} ${m ? m.name : ""}`);
    });
}
