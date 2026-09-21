/**
 * Who has not bought anything yet, by class.
 *
 * Splits the list by WHY, because the fix differs:
 *   never signed in      -> an account/login problem, or they were absent
 *   signed in, no trades -> they were here and did not finish
 *   no cash              -> they cannot buy; that is on the teacher, not them
 *
 * Read-only: SELECTs only.
 * Usage: node scripts/who-hasnt-traded.mjs ["4th"]
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

const SQL = `
  SELECT c.name AS class_name, u.name, u.email, u.last_active_at,
         COALESCE(a.cash_cents, 0) AS cash_cents,
         (SELECT COUNT(*) FROM ledger l WHERE l.account_id = a.id AND l.ticker IS NOT NULL) AS trade_rows
  FROM users u
  LEFT JOIN classes c ON c.id = u.class_id
  LEFT JOIN accounts a ON a.user_id = u.id
  WHERE u.role = 'student'
  ORDER BY c.name, u.name
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
  rows = new DatabaseSync("data/simlife.db").prepare(SQL).all();
}

const money = (c) => `$${(Number(c) / 100).toFixed(2)}`;
const byClass = new Map();
for (const r of rows) {
  const cls = r.class_name || "(no class)";
  if (filter && !cls.toLowerCase().includes(filter)) continue;
  if (!byClass.has(cls)) byClass.set(cls, []);
  byClass.get(cls).push(r);
}

for (const [cls, list] of byClass) {
  const none = list.filter((r) => Number(r.trade_rows) === 0);
  console.log(`\n=== ${cls} — ${none.length} of ${list.length} have not bought anything ===`);
  if (none.length === 0) { console.log("  everyone has traded"); continue; }

  const never = none.filter((r) => !r.last_active_at);
  const idle  = none.filter((r) => r.last_active_at && Number(r.cash_cents) > 0);
  const broke = none.filter((r) => r.last_active_at && Number(r.cash_cents) <= 0);

  const show = (label, arr, note) => {
    if (!arr.length) return;
    console.log(`\n  ${label} (${arr.length})${note ? " — " + note : ""}`);
    for (const r of arr) {
      const seen = r.last_active_at ? new Date(r.last_active_at).toLocaleDateString() : "never";
      console.log(`    ${String(r.name).padEnd(26)} cash ${money(r.cash_cents).padStart(10)}   last seen ${seen}`);
    }
  };
  show("NEVER SIGNED IN", never, "account or absence problem, not effort");
  show("SIGNED IN, HAS CASH, DID NOT BUY", idle, "these are the ones to chase");
  show("SIGNED IN BUT NO CASH", broke, "they cannot buy — fund them first");
}
console.log("");
