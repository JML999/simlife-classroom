/** One-time, guarded ETHA correction. Preview by default; --apply commits.
 * Original purchase fields and snapshots are retained in a local backup and
 * the purchase reason records the original share count/price. No cash changes.
 */
import "../server/env.js";
import pg from "pg";
import fs from "node:fs";
import { FinnhubQuoteProvider } from "../server/quotes.js";
import { subPeriodReturnBp, chainBp } from "../server/leaderboard.js";
import { ROOT } from "../server/env.js";
import path from "node:path";
const userId = "u_lGlp86_2BXukQwsq";
const accountId = "acct_jYRyrRurtiPMtvOb";
const marker = "Manual ETHA 1-for-3 reverse split 2026-10-06";
const apply = process.argv.includes("--apply");
const deadline = setTimeout(() => { console.error("Correction timed out; inspect backup and rerun preview."); process.exit(2); }, 55000);
const client = new pg.Client({ connectionString: process.env.SIMLIFE_DATABASE_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10000, statement_timeout: 15000, query_timeout: 15000 });
const query = async (sql: string, params: any[] = []) => (await client.query(sql, params)).rows;
let inTx = false;
try {
  if (!process.env.SIMLIFE_DATABASE_URL) throw new Error("Production database is not configured.");
  await client.connect();
  const initial = await query("SELECT * FROM ledger WHERE account_id=$1 ORDER BY created_at,id", [accountId]);
  const purchases = initial.filter(r => r.ticker === "ETHA");
  if (purchases.length !== 1 || purchases[0].kind !== "buy" || purchases[0].amount_cents !== -5000) throw new Error("ETHA history changed; re-audit required.");
  const purchase = purchases[0];
  if (purchase.reason?.includes(marker)) { console.log("Already corrected; no changes."); }
  else {
    if (purchase.qty_micro !== 2449779 || purchase.price_cents !== 2041 || purchase.created_at !== "2026-09-30T14:14:29.792Z") throw new Error("Purchase does not match the reviewed record.");
    const prices = new Map<string, number>();
    const provider = new FinnhubQuoteProvider();
    const tickers = [...new Set(initial.filter(r => r.ticker).map(r => r.ticker))].filter(ticker => initial.filter(r => r.ticker === ticker).reduce((n,r)=>n+Number(r.qty_micro||0),0)>0);
    for (const ticker of tickers) {
      const quote = await provider.getQuote(ticker);
      if (ticker === "ETHA" && (quote.asOf < "2026-10-06T13:30:00.000Z" || quote.priceCents < 4000)) throw new Error("ETHA quote is not confirmed post-split.");
      prices.set(ticker,quote.priceCents);
    }
    await client.query(apply ? "BEGIN" : "BEGIN READ ONLY"); inTx = true;
    const user = (await query(`SELECT id,name FROM users WHERE id=$1${apply ? " FOR UPDATE" : ""}`, [userId]))[0];
    const account = (await query(`SELECT * FROM accounts WHERE id=$1 AND user_id=$2${apply ? " FOR UPDATE" : ""}`, [accountId,userId]))[0];
    if (!account || user?.name !== "Aniya Bates") throw new Error("Student/account identity mismatch.");
    const locked = await query("SELECT * FROM ledger WHERE account_id=$1 ORDER BY created_at,id", [accountId]);
    if (JSON.stringify(locked) !== JSON.stringify(initial)) throw new Error("Trading occurred during preview; rerun.");
    const snapshots = await query(`SELECT * FROM leaderboard_snapshots WHERE user_id=$1 ORDER BY as_of_date${apply ? " FOR UPDATE" : ""}`, [userId]);
    const affected = snapshots.filter(r=>r.as_of_date >= "2026-10-06");
    if (affected.length !== 1 || affected[0].as_of_date !== "2026-10-06") throw new Error("Expected exactly today's affected snapshot; re-audit required.");
    const previous = snapshots.filter(r=>r.as_of_date < "2026-10-06").at(-1);
    if (!previous) throw new Error("Missing preceding snapshot.");
    const correctedQty = purchase.qty_micro / 3;
    const correctedPrice = purchase.price_cents * 3;
    if (!Number.isInteger(correctedQty)) throw new Error("Fractional micro-share rounding requires review.");
    const directory = JSON.parse(fs.readFileSync(path.join(ROOT,"server/ticker-directory.json"),"utf8"));
    const holdings = tickers.map(ticker=>{
      const qty = locked.filter(r=>r.ticker===ticker).reduce((n,r)=>n+Number(r.qty_micro||0),0) - (ticker === "ETHA" ? purchase.qty_micro-correctedQty : 0);
      return {ticker,qty,value:Math.round(qty*prices.get(ticker)!/1e6)};
    }).filter(h=>h.qty>0);
    const holdingsValue = holdings.reduce((n,h)=>n+h.value,0);
    const value = account.cash_cents + holdingsValue;
    const contributed = locked.filter(r=>["cash_adjust","cash_reversal","transfer_in","transfer_out"].includes(r.kind)).reduce((n,r)=>n+r.amount_cents,0);
    const periodReturnBp = subPeriodReturnBp(previous.value_cents,value,contributed-previous.net_contributed_cents);
    const twrBp = chainBp(previous.twr_bp,periodReturnBp);
    const sectors = new Set(holdings.map(h=>directory.meta?.[h.ticker]?.sector).filter(Boolean)).size;
    const topPositionBp = holdingsValue>0 ? Math.round(Math.max(...holdings.map(h=>h.value))/holdingsValue*10000) : null;
    const reason = [purchase.reason, `${marker}; original purchase 2.449779 shares at $20.41; adjusted 0.816593 shares at $61.23; original $50 cost and cash unchanged.`].filter(Boolean).join("\n");
    console.log(JSON.stringify({mode:apply?"apply":"preview",student:user.name,shares:{before:2.449779,after:0.816593},costCents:5000,cashCents:account.cash_cents,ethaQuoteCents:prices.get("ETHA"),ethaValueCents:holdings.find(h=>h.ticker==="ETHA")?.value,accountValueCents:value,leaderboard:{beforeBp:affected[0].twr_bp,afterBp:twrBp}},null,2));
    if (apply) {
      const backup = `/tmp/simlife-etha-split-backup-${Date.now()}.json`;
      fs.writeFileSync(backup,JSON.stringify({purchase,account,snapshots,prices:Object.fromEntries(prices),plan:{correctedQty,correctedPrice,reason,value,twrBp}},null,2),{mode:0o600,flag:"wx"});
      console.log("Backup:",backup);
      await client.query("UPDATE ledger SET qty_micro=$1,price_cents=$2,reason=$3 WHERE id=$4",[correctedQty,correctedPrice,reason,purchase.id]);
      await client.query("UPDATE leaderboard_snapshots SET value_cents=$1,cash_cents=$2,holdings_value_cents=$3,net_contributed_cents=$4,period_return_bp=$5,twr_bp=$6,holdings_count=$7,sectors_held=$8,top_position_bp=$9,quote_source='finnhub' WHERE id=$10",[value,account.cash_cents,holdingsValue,contributed,periodReturnBp,twrBp,holdings.length,sectors,topPositionBp,affected[0].id]);
      const sum=(await query("SELECT SUM(amount_cents) AS cash FROM ledger WHERE account_id=$1",[accountId]))[0];
      if(Number(sum.cash)!==account.cash_cents)throw new Error("Cash invariant failed.");
      await client.query("COMMIT");inTx=false;console.log("Committed share correction and leaderboard recalculation.");
    } else { await client.query("ROLLBACK");inTx=false; }
  }
} catch(e:any) {
  if(inTx)await client.query("ROLLBACK").catch(()=>{});
  console.error("Correction failed:",e.code || e.message);process.exitCode=1;
} finally { clearTimeout(deadline); await client.end(); }
