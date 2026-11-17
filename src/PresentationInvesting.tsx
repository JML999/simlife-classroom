import { useCallback, useEffect, useRef, useState } from "react";
import { PRESENTATION_POST_ID, type PresentationResponse } from "../shared/presentation-investing";
import { api, money } from "./api";
import { useModuleDraft } from "./use-module-draft";
import "./presentation-investing.css";
const formatDate=(value:string)=>new Date(value).toLocaleString('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})+' ET';
function Results({results}:{results:any}) {
  return <section className="panel pitch-results"><span className="eyebrow">Most convincing investment pitch</span><h3>The class has invested</h3><p>{results.submitted} students finalized their choices. Only purchases from this activity count. Tied totals share the same place.</p><ol>{results.totals.map((p:any)=><li key={p.ticker}><strong>{p.ticker}</strong><span>{money(p.cents)}</span></li>)}</ol></section>;
}
export function PresentationInvesting({onBack}:{onBack:()=>void}) {
  const [state,setState]=useState<any>(null),[response,setResponse]=useState<PresentationResponse>({allocations:[]});
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[review,setReview]=useState(false);
  const hydrated=useRef(false), mounted=useRef(true);
  const autosave=useModuleDraft<PresentationResponse>(`/api/class/posts/${PRESENTATION_POST_ID}/draft`);
  const load=useCallback(async()=>{
    try {
      const [next,post]=await Promise.all([api<any>('/api/class/presentation-investing'),api<any>(`/api/class/posts/${PRESENTATION_POST_ID}`)]);
      if(!mounted.current)return;
      setState(next);
      if(next.receipt){autosave.submitted();setReview(false);}
      else if(!hydrated.current){setResponse(autosave.restore(next.studentId,post.draft?.response||{allocations:[]},post.draft?.updatedAt||''));hydrated.current=true;}
    }catch(e:any){if(mounted.current)setError(e.message);}
  },[]);
  useEffect(()=>{mounted.current=true;void load();const timer=setInterval(()=>void load(),30000);const focus=()=>void load();window.addEventListener('focus',focus);return()=>{mounted.current=false;clearInterval(timer);window.removeEventListener('focus',focus);};},[load]);
  const update=(ticker:string,raw:string)=>{
    const cents=raw===''?0:Math.round(Number(raw)*100);
    if(!Number.isFinite(cents)||cents<0||cents>50000)return;
    const next={allocations:[...response.allocations.filter(a=>a.ticker!==ticker),{ticker,cents}]};setResponse(next);autosave.change(next);setReview(false);
  };
  const total=response.allocations.reduce((s,a)=>s+a.cents,0),selected=response.allocations.filter(a=>a.cents>0);
  const invalid=selected.some(a=>a.cents<100||!state?.companies.some((c:any)=>c.ticker===a.ticker&&!c.own));
  const ready=!!state?.open && total===50000 && selected.length>=3 && !invalid;
  const invest=async()=>{
    if(busy)return;setBusy(true);setError('');
    try {await autosave.beforeSubmit();const result=await api<any>(`/api/class/posts/${PRESENTATION_POST_ID}/submit`,{method:'POST',body:JSON.stringify({response,studentId:state.studentId})});autosave.submitted();setState((s:any)=>({...s,receipt:result.receipt}));setReview(false);await load();}
    catch(e:any){setError(e.message);}finally{setBusy(false);}
  };
  return <div className="class-section module-page pitch-module" onBlurCapture={()=>{if(!state?.receipt)void autosave.flush();}}>
    <header className="module-head"><button className="class-back" onClick={onBack}>← Modules</button><div className="eyebrow">Investing · Presentation day</div><h2>Buy or Bye</h2><p className="module-detail">One $500 budget for the week. Listen to the pitches and build your allocation as classmates present.</p></header>
    {error&&<div className="error" role="alert">{error}<button className="ghost" onClick={()=>{setError('');void load();}}>Refresh</button></div>}
    {!state?<section className="panel pitch-loading" aria-busy="true"><h3>Preparing your investment sheet</h3><p>Your saved choices will appear here.</p><div/><div/><div/></section>:state.receipt?<>
      <section className="panel pitch-receipt"><span className="eyebrow">Investments complete</span><h3>Your pitches became purchases.</h3><p>Your account received a one-time $500 grant. These shares are now in your portfolio.</p><p className="small">Purchased {formatDate(state.receipt.submittedAt)}. This activity can only be finalized once.</p>
        <div className="table-scroll"><table><thead><tr><th>Company</th><th>Shares bought</th><th>Amount invested</th></tr></thead><tbody>{state.receipt.purchases.map((p:any)=><tr key={p.ticker}><td><strong>{p.ticker}</strong></td><td>{(p.qtyMicro/1000000).toFixed(6)}</td><td>{money(p.costCents)}</td></tr>)}</tbody></table></div>
        <p><strong>Total invested: {money(state.receipt.spentCents)}</strong>{state.receipt.remainderCents>0&&<> · {money(state.receipt.remainderCents)} remains in brokerage cash from fractional-share rounding.</>}</p></section>
      {state.results?<Results results={state.results}/>:<section className="panel"><h3>Results are under wraps</h3><p>Your teacher will reveal the class totals when everyone is ready.</p></section>}
    </>:<>
      <section className="panel pitch-budget"><div><span className="eyebrow">Your investment budget</span><h3>{money(total)} <small>of $500 allocated</small></h3><p>Choose at least three companies, with at least $1 each. Your own presentation is excluded.</p></div><div className={total>50000?'pitch-remaining over':'pitch-remaining'}><strong>{money(Math.abs(50000-total))}</strong><span>{total>50000?'over budget':'left to allocate'}</span></div><progress max={50000} value={Math.min(total,50000)} aria-label="Allocated budget"/></section>
      <div className="pitch-save-status" role="status"><span>{autosave.status||'Your choices save automatically.'}</span><span>{state.tradingFrozen?'Trading is paused.':state.open?'Investing is open.':state.opensAt?`Purchases open ${formatDate(state.opensAt)}.`:'Drafting is open · Final submission is locked.'}</span></div>
      {state.companies.length===0?<section className="panel"><h3>Your class list is coming</h3><p>Your teacher is adding the presentation companies. No money moves until you review and confirm your purchases.</p></section>:<section className="panel pitch-company-list" aria-label="Presentation companies">{state.companies.map((c:any)=><article className={c.own?'pitch-company own':'pitch-company'} key={c.ticker}><div className="pitch-symbol">{c.ticker}</div><div className="pitch-company-name"><h3>{c.name}</h3><p>{c.presenter}{c.own?' · Your presentation':''}</p></div><label><span>{c.own?'Excluded':'Invest dollars'}</span><div className="pitch-dollar-input"><span>$</span><input aria-label={`Dollars for ${c.ticker}`} type="number" min="0" max="500" step="0.01" disabled={c.own||busy} value={response.allocations.find(a=>a.ticker===c.ticker)?.cents?response.allocations.find(a=>a.ticker===c.ticker)!.cents/100:''} onChange={e=>update(c.ticker,e.target.value)} placeholder="0.00"/></div></label></article>)}</section>}
      {selected.filter(a=>!state.companies.some((c:any)=>c.ticker===a.ticker&&!c.own)).map(a=><div className="notice" key={a.ticker}>{a.ticker} is no longer an available choice. <button className="ghost" onClick={()=>update(a.ticker,'')}>Remove its {money(a.cents)} allocation</button></div>)}
      {review&&<section className="panel pitch-confirm" role="region" aria-label="Review purchases"><span className="eyebrow">One final check</span><h3>Ready to invest your $500?</h3><ul>{selected.map(a=><li key={a.ticker}><strong>{a.ticker}</strong><span>{money(a.cents)}</span></li>)}</ul><p>Confirming adds $500 to your brokerage account and buys these stocks at the available delayed prices. This choice is final. A tiny rounding remainder may stay in cash.</p><div className="row"><button disabled={busy||!ready} onClick={()=>void invest()}>{busy?'Placing your purchases…':'Confirm · Invest my $500'}</button><button className="ghost" disabled={busy} onClick={()=>setReview(false)}>Keep editing</button></div></section>}
      <div className="module-action-bar"><div><strong>{selected.length} companies · {money(total)} allocated</strong><span>{!state.open?'Keep editing throughout the week. Final submission is locked.':total!==50000?'Allocate exactly $500 to continue.':selected.length<3?'Choose at least three companies.':invalid?'Check your company choices and $1 minimum.':'Review your choices before making one-time purchases.'}</span></div><button disabled={!ready||busy} onClick={()=>setReview(true)}>Review purchases →</button></div>
    </>}
  </div>;
}
// The field is explicitly Eastern regardless of the teacher's browser timezone.
function easternInput(iso:string|null){if(!iso)return '';const parts=new Intl.DateTimeFormat('sv-SE',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(iso));return parts.replace(' ','T');}
function easternISO(value:string){if(!value)return null;const base=Date.parse(value+'Z');for(const offset of ['-04:00','-05:00']){const iso=new Date(value+offset).toISOString();if(easternInput(iso)===value)return iso;}if(!Number.isFinite(base))throw Error('Choose a valid opening time.');throw Error('That Eastern time does not exist because of daylight saving time.');}
export function TeacherPresentationInvesting({classId}:{classId:string}) {
  const [data,setData]=useState<any>(null),[companies,setCompanies]=useState<{ticker:string;studentId:string}[]>([]),[opensAt,setOpensAt]=useState(''),[reveal,setReveal]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false),[saved,setSaved]=useState(false);
  useEffect(()=>{let current=true;setData(null);setError('');setSaved(false);api<any>(`/api/teacher/classes/${classId}/presentation-investing`).then(d=>{if(current){setData(d);setCompanies(d.companies);setOpensAt(easternInput(d.opensAt));setReveal(d.reveal);}}).catch(e=>{if(current)setError(e.message);});return()=>{current=false;};},[classId]);
  const save=async()=>{setBusy(true);setError('');setSaved(false);try{await api(`/api/teacher/classes/${classId}/presentation-investing`,{method:'PUT',body:JSON.stringify({companies,opensAt:easternISO(opensAt),reveal})});setData(await api(`/api/teacher/classes/${classId}/presentation-investing`));setSaved(true);}catch(e:any){setError(e.message);}finally{setBusy(false);}};
  const locked=!!data?.results.submitted;
  return <section className="panel pitch-teacher"><span className="eyebrow">Presentation day</span><h2>Buy or Bye · $500 investment activity</h2><p>Students build one allocation across the week and make one final set of purchases when you open submission. Each gets a one-time $500 grant when their purchases execute. No extra payroll is needed.</p>
    {error&&<div className="error" role="alert">{error}</div>}
    {!data?<p role="status">Loading this period's activity…</p>:<fieldset disabled={busy}><legend>Settings for this period</legend><div className="field"><label htmlFor="pitch-opens">Final submission & purchases open · Eastern time</label><input id="pitch-opens" type="datetime-local" value={opensAt} onChange={e=>{setOpensAt(e.target.value);setSaved(false);}}/><small>Leave blank to keep final submission locked. Students can open the assignment and autosave all week.</small></div>
      <h3>Presentation companies</h3><p className="small">Add each student's stock ticker as listed in Sim Life. At least four entries are needed before opening. Add companies throughout the week. The list locks after the first final submission.</p>
      <div className="pitch-editor-list">{companies.map((c,i)=><div className="pitch-editor-row" key={i}><label><span>Presenter</span><select aria-label={`Presenter ${i+1}`} disabled={locked} value={c.studentId} onChange={e=>setCompanies(list=>list.map((v,j)=>j===i?{...v,studentId:e.target.value}:v))}><option value="">Choose student…</option>{data.roster.map((u:any)=><option key={u.id} value={u.id}>{u.name}</option>)}</select></label><label><span>Ticker</span><input aria-label={`Ticker ${i+1}`} disabled={locked} value={c.ticker} placeholder="SNAP" onChange={e=>setCompanies(list=>list.map((v,j)=>j===i?{...v,ticker:e.target.value.toUpperCase().trim()}:v))}/></label><button type="button" className="ghost" disabled={locked} onClick={()=>setCompanies(list=>list.filter((_,j)=>j!==i))}>Remove</button></div>)}</div>
      <button className="ghost" disabled={locked} onClick={()=>setCompanies(list=>[...list,{ticker:'',studentId:''}])}>+ Add presentation</button>
      <label className="pitch-reveal"><input type="checkbox" checked={reveal} onChange={e=>setReveal(e.target.checked)}/><span>Reveal class totals to students</span></label><div className="row"><button onClick={()=>void save()}>{busy?'Saving…':'Save activity settings'}</button>{saved&&<span role="status">Saved ✓</span>}</div>
      <p>{data.results.submitted}/{data.roster.length} students have finalized purchases. <button className="ghost" onClick={()=>api<any>(`/api/teacher/classes/${classId}/presentation-investing`).then(setData).catch(e=>setError(e.message))}>Refresh results</button></p>
      <Results results={data.results}/>{data.receipts.length>0&&<details><summary>Student purchase receipts</summary><ul>{data.receipts.map((r:any)=><li key={r.studentId}><strong>{r.name}</strong> · {r.purchases.map((p:any)=>`${p.ticker} ${money(p.costCents)}`).join(' · ')}</li>)}</ul></details>}
    </fieldset>}
  </section>;
}
