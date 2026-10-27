import { useState } from 'react';
import { money } from './api';
interface Sale {id:string;ticker:string;soldAt:string;shares:number;costBasisCents:number;proceedsCents:number;gainLossCents:number;returnPct:number|null;positionClosed:boolean}
export function ClosedTrades({portfolio}:{portfolio:{closedTrades?:Sale[];realizedGainLossCents:number;unrealizedGainLossCents:number;gainLossCents:number}|null}) {
  const [query,setQuery]=useState(''),[page,setPage]=useState(1);
  const all=portfolio?.closedTrades??[],filtered=all.filter(s=>s.ticker.toLowerCase().includes(query.trim().toLowerCase()));
  const pages=Math.max(1,Math.ceil(filtered.length/15)),current=Math.min(page,pages),visible=filtered.slice((current-1)*15,current*15);
  const signed=(cents:number)=>`${cents>0?'+':''}${money(cents)}`;
  const tone=(cents:number)=>cents>0?'up':cents<0?'down':'';
  return <section className="panel closed-trades" aria-labelledby="closed-trades-title">
    <div className="panel-heading"><div><span className="eyebrow">Your trading results</span><h2 id="closed-trades-title">Closed trades</h2><p className="hint">Profit and loss from shares you have sold, including partial sales. These results stay with your account after you buy something new.</p></div><span className="badge">{portfolio?`${all.length} sales`:'Loading…'}</span></div>
    {!portfolio?<p role="status">Loading your trade results…</p>:<>
      <div className="closed-trade-totals">
        <div><span>Sold shares · realized</span><strong className={tone(portfolio.realizedGainLossCents)}>{signed(portfolio.realizedGainLossCents)}</strong><small>Locked in when you sold</small></div>
        <div><span>Current holdings · unrealized</span><strong className={tone(portfolio.unrealizedGainLossCents)}>{signed(portfolio.unrealizedGainLossCents)}</strong><small>Changes with market prices</small></div>
        <div><span>Combined dollar gain / loss</span><strong className={tone(portfolio.gainLossCents)}>{signed(portfolio.gainLossCents)}</strong><small>Realized plus unrealized</small></div>
      </div>
      <p className="small closed-trade-explanation">Proceeds are the money returned by a sale. Profit or loss is proceeds minus the cost of the shares sold. Deposits and withdrawals are not investment gains or losses. The leaderboard adjusts for the timing of cash flows, so its percentage can differ from these dollar totals.</p>
      {all.length===0?<p className="closed-trades-empty">No sold shares yet. Your first sale will appear here automatically.</p>:<>
        <div className="field closed-trade-search"><label htmlFor="closed-trade-search">Find a sold investment</label><input id="closed-trade-search" value={query} placeholder="Search ticker" onChange={e=>{setQuery(e.target.value);setPage(1);}}/></div>
        <div className="table-wrap"><table className="closed-trades-table"><thead><tr><th scope="col">Sold</th><th scope="col">Investment</th><th scope="col">Shares sold</th><th scope="col">Cost of shares sold</th><th scope="col">Sale proceeds</th><th scope="col">Profit / loss</th></tr></thead><tbody>{visible.map(sale=><tr key={sale.id}><td>{new Date(sale.soldAt).toLocaleDateString('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',year:'numeric'})}<small>{new Date(sale.soldAt).toLocaleTimeString('en-US',{timeZone:'America/New_York',hour:'numeric',minute:'2-digit'})}</small></td><td><strong>{sale.ticker}</strong><small>{sale.positionClosed?'Full exit':'Partial sale'}</small></td><td>{sale.shares.toLocaleString('en-US',{maximumFractionDigits:6})}</td><td>{money(sale.costBasisCents)}</td><td>{money(sale.proceedsCents)}</td><td className={tone(sale.gainLossCents)}><strong>{signed(sale.gainLossCents)}</strong><small>{sale.returnPct==null?'No cost basis':`${sale.returnPct>0?'+':''}${sale.returnPct.toFixed(2)}%`}</small></td></tr>)}</tbody></table></div>
        {filtered.length===0&&<p>No sold investments match “{query}”.</p>}
        <div className="portfolio-footer"><span>{filtered.length?`Showing ${(current-1)*15+1}–${Math.min(current*15,filtered.length)} of ${filtered.length} sales, newest first`:'0 sales'} · Totals above include all sales</span>{pages>1&&<div className="pagination"><button className="ghost" disabled={current===1} onClick={()=>setPage(current-1)}>Previous sales</button><span>Page {current} of {pages}</span><button className="ghost" disabled={current===pages} onClick={()=>setPage(current+1)}>Next sales</button></div>}</div>
      </>}
    </>}
  </section>;
}
