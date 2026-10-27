/** A fresh dollar-profit competition, independent of historical percentage returns. */
import { schoolDate } from "./billing-dates.js";
import { one, q, run, withTx } from './db.js';
export const GROSS_GAIN_ROUND = 'classroom-dollar-gains-v1';
export async function ensureGrossGainRound(now = new Date()) {
  await run(`INSERT INTO gross_gain_rounds (id,starts_at) VALUES (?,?) ON CONFLICT(id) DO NOTHING`,[GROSS_GAIN_ROUND,now.toISOString()]);
  return (await one<{id:string;starts_at:string}>(`SELECT * FROM gross_gain_rounds WHERE id=?`,[GROSS_GAIN_ROUND]))!;
}
/** Call only after a successful, fully priced class snapshot refresh. Never seed from stale history. */
export async function recordGrossGainSnapshot(classId:string,asOfDate:string,now=new Date()) {
  const round=await ensureGrossGainRound(now);
  if(now.toISOString()<round.starts_at||asOfDate<schoolDate(new Date(round.starts_at)))return;
  await withTx(async t=>{
    const rows=await t.q<any>(`SELECT s.* FROM leaderboard_snapshots s JOIN users u ON u.id=s.user_id WHERE u.class_id=? AND u.role='student' AND s.as_of_date=?`,[classId,asOfDate]);
    for(const row of rows)await t.run(`INSERT INTO gross_gain_entries
      (round_id,user_id,baseline_value_cents,baseline_net_contributed_cents,baseline_at,value_cents,net_contributed_cents,as_of_date,updated_at,holdings_count,sectors_held,top_position_bp)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(round_id,user_id) DO UPDATE SET
      value_cents=excluded.value_cents,net_contributed_cents=excluded.net_contributed_cents,
      as_of_date=excluded.as_of_date,updated_at=excluded.updated_at,holdings_count=excluded.holdings_count,sectors_held=excluded.sectors_held,top_position_bp=excluded.top_position_bp
      WHERE gross_gain_entries.updated_at<=excluded.updated_at`,
      [round.id,row.user_id,row.value_cents,row.net_contributed_cents,now.toISOString(),row.value_cents,row.net_contributed_cents,asOfDate,now.toISOString(),row.holdings_count,row.sectors_held,row.top_position_bp]);
  });
}
export async function grossGainsFor(classId:string) {
  const round=await ensureGrossGainRound();
  const rows=await q<any>(`SELECT e.*,u.name FROM gross_gain_entries e JOIN users u ON u.id=e.user_id WHERE e.round_id=? AND u.class_id=? AND u.role='student' ORDER BY u.name`,[round.id,classId]);
  const entries=rows.map(r=>({userId:r.user_id,name:r.name,
    gainCents:Number(r.value_cents)-Number(r.baseline_value_cents)-(Number(r.net_contributed_cents)-Number(r.baseline_net_contributed_cents)),
    baselineAt:r.baseline_at,holdingsCount:Number(r.holdings_count),sectorsHeld:r.sectors_held,topPositionBp:r.top_position_bp}));
  entries.sort((a,b)=>b.gainCents-a.gainCents||a.name.localeCompare(b.name));
  return {sort:'gross' as const,startsAt:round.starts_at,asOfDate:rows.length?rows.reduce((d:string,r:any)=>r.as_of_date>d?r.as_of_date:d,''):null,
    updatedAt:rows.length?rows.reduce((d:string,r:any)=>r.updated_at>d?r.updated_at:d,''):null,entries};
}
