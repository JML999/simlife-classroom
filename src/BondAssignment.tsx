import { useCallback, useEffect, useRef, useState } from "react";
import { BOND_PRODUCTS, BOND_QUESTIONS, emptyBondResponse, type BondResponse } from "../shared/bonds";
import { useModuleDraft } from "./use-module-draft";
import { api, uid } from "./api";

export function BondReview({ detail }: { detail: any }) {
  const r = detail.response || emptyBondResponse(), evidence = detail.evidence;
  return <div className="module-submission bond-review">
    <p>{detail.submittedAt ? `Submitted ${new Date(detail.submittedAt).toLocaleString()}` : detail.draftAt ? "Saved draft — not submitted" : "Not started"}</p>
    {evidence && <p><strong>At submission:</strong> {evidence.correct}/{evidence.questionTotal} correct, {evidence.answered}/{evidence.questionTotal} answered. {evidence.met ? "Bond holding verified." : "No bond ETF held."} {evidence.selectedHeld ? "Selected fund held." : "Selected fund not verified."}</p>}
    {BOND_QUESTIONS.map(q => <div className="bond-review-answer" key={q.id}><strong>{q.prompt}</strong><p>{q.options[Number(r.answers?.[q.id])] && r.answers?.[q.id] !== "" && r.answers?.[q.id] != null ? q.options[Number(r.answers[q.id])] : "No answer"}</p></div>)}
    <p><strong>Chosen fund:</strong> {r.ticker || "No choice"}</p><p className="bond-written-answer">{r.explanation || "No explanation"}</p>
    <p className="small"><strong>Current bond holdings:</strong> {detail.liveBonds?.map((b: any) => b.ticker).join(", ") || "None"}. Submission evidence stays as it was when submitted.</p>
  </div>;
}

export function BondAssignment({ id, moduleNumber, onBack, onOpenInvesting }: { id: string; moduleNumber?: number; onBack: () => void; onOpenInvesting: () => void }) {
  const [post, setPost] = useState<any>(null), [response, setResponse] = useState<BondResponse>(emptyBondResponse);
  const [error,setError]=useState(""), [busy,setBusy]=useState(false), [refreshing,setRefreshing]=useState(false);
  const hydrated=useRef(false), key=useRef(uid());
  const autosave=useModuleDraft<BondResponse>(`/api/class/posts/${id}/draft`);
  const load=useCallback(async (silent=false)=>{
    if(silent)setRefreshing(true);
    try {
      const result=await api<any>(`/api/class/posts/${id}`,{cache:"no-store"});
      setPost(result);setError("");
      if(!hydrated.current){
        const draft=result.draft&&(!result.submission||result.draft.updatedAt>result.submission.createdAt)?result.draft:null;
        const saved=autosave.restore(result.studentId,draft?.response??result.submission?.response??emptyBondResponse(),draft?.updatedAt||result.submission?.createdAt||"");
        setResponse({...emptyBondResponse(),...saved});hydrated.current=true;
      }
    }catch(e:any){setError(e.message);}finally{setRefreshing(false);}
  },[id]);
  useEffect(()=>{void load();},[load]);
  useEffect(()=>{const refresh=()=>void load(true);window.addEventListener("focus",refresh);return()=>window.removeEventListener("focus",refresh);},[load]);
  const update=(next:BondResponse)=>{setResponse(next);autosave.change(next);};
  const submit=async()=>{
    if(busy)return;setBusy(true);setError("");
    try {await autosave.beforeSubmit();await api(`/api/class/posts/${id}/submit`,{method:"POST",body:JSON.stringify({response,idempotencyKey:key.current})});autosave.submitted();key.current=uid();hydrated.current=false;await load();}
    catch(e:any){setError(e.message);}finally{setBusy(false);}
  };
  const bonds=post?.mission?.bonds??[], answered=BOND_QUESTIONS.filter(q=>!!response.answers[q.id]).length;
  return <div className="class-section module-page bond-module" onBlurCapture={()=>void autosave.flush()}>
    <header className="module-head"><button className="class-back" onClick={onBack}>← Modules</button><div className="eyebrow">{moduleNumber?`Module ${moduleNumber} · `:""}Investing</div><h2>{post?.title||"Interest Rates and Bonds"}</h2><p className="module-detail">Five quick questions. One bond ETF. Your reason for choosing it.</p></header>
    {error&&<div className="error" role="alert">{error} <button className="ghost" onClick={()=>void load(!!post)}>Try again</button></div>}
    {!post?<div className="panel" role="status">Loading your assignment and portfolio…</div>:<>
      <p className="module-autosave" role="status">{autosave.status||"Your answers save automatically."}</p>
      {post.submission&&<div className="notice" role="status"><strong>Submitted ✓</strong> You can keep editing and update your submission. Your teacher can see unfinished work.</div>}
      <section className="panel bond-essentials"><span className="eyebrow">The basics</span><h3>You can earn interest by lending</h3><div className="bond-basics-grid">
        <div><strong>A bond is a loan</strong><p>You lend to a government or company. Principal is the amount lent. Maturity is when repayment is due.</p></div>
        <div><strong>Interest is the price of borrowing</strong><p>A hypothetical $1,000 bond at 5% pays $50 a year if the borrower pays as promised.</p></div>
        <div><strong>Rates and prices move differently</strong><p>When market rates rise, existing fixed-rate bond prices generally fall. The fixed interest payment stays the same.</p></div>
        <div><strong>Bond ETFs can lose value</strong><p>A fund holds many debt investments. Borrower problems, inflation and changing rates are risks.</p></div>
      </div><p className="small"><a href="https://www.investor.gov/introduction-investing/investing-basics/investment-products/bonds-or-fixed-income-products/bonds" target="_blank" rel="noreferrer">SEC: bond basics</a> · <a href="https://www.investor.gov/introduction-investing/general-resources/news-alerts/alerts-bulletins/investor-bulletins-86" target="_blank" rel="noreferrer">How rates affect bond prices</a></p></section>
      <section className="panel bond-quiz"><div className="panel-heading"><div><span className="eyebrow">Part 1</span><h3>A quick check</h3></div><span>{answered}/5 answered</span></div>
        {BOND_QUESTIONS.map((q,i)=><fieldset key={q.id} className="bond-question"><legend><span>{i+1}.</span> {q.prompt}</legend><div className="bond-options">{q.options.map((option,j)=><label key={j} className={response.answers[q.id]===String(j)?"selected":""}><input type="radio" name={`bond-${id}-${q.id}`} checked={response.answers[q.id]===String(j)} onChange={()=>update({...response,answers:{...response.answers,[q.id]:String(j)}})}/><span>{option}</span></label>)}</div></fieldset>)}
      </section>
      <section className="panel bond-portfolio" aria-label="Bond portfolio evidence"><div className="panel-heading"><div><span className="eyebrow">Part 2</span><h3>Your bond holdings</h3><p className="hint">Hold at least one bond ETF. A fund you already own counts.</p></div><span className={bonds.length?"badge-paid":"badge-due"}>{bonds.length?"✓ Bond ETF held":"No bond ETF yet"}</span></div>
        {bonds.length?<ul className="bond-held-list">{bonds.map((b:any)=><li key={b.ticker}><strong>{b.ticker}</strong><span>{b.name}</span><small>{Number(b.shares).toFixed(4)} shares</small></li>)}</ul>:<p>Choose a bond ETF below, buy it in Investing, then return here. Your answers will stay saved.</p>}
        <div className="row"><button className="ghost" disabled={refreshing} onClick={()=>void load(true)}>{refreshing?"Checking portfolio…":"Refresh portfolio"}</button><button onClick={()=>{void autosave.flush();onOpenInvesting();}}>Open Investing →</button></div>
        <p className="small">Checked {new Date(post.mission.checkedAt).toLocaleTimeString()}. {refreshing?"Updating holdings…":"Current holdings come from your account, not from a typed ticker."}</p>
      </section>
      <section className="panel bond-product-guide"><span className="eyebrow">Four funds to compare</span><h3>Different bonds, different risks</h3><p>These are bond ETFs, not individual bonds. Use the ticker in Investing. Other bond ETFs listed on SimLife also count.</p>
        <div className="bond-product-grid">{BOND_PRODUCTS.map(p=><article key={p.ticker}><div className="bond-product-heading"><strong>{p.ticker}</strong><span>{p.focus}</span></div><h4>{p.name}</h4><p>{p.description}</p><p className="bond-product-risk"><strong>Watch for:</strong> {p.risk}</p><a href={p.url} target="_blank" rel="noreferrer">Research {p.ticker} with the fund provider ↗</a></article>)}</div>
        <p className="bond-sim-note"><strong>In SimLife:</strong> your account tracks fund prices. It does not currently credit ETF interest/dividend distributions. Real bond funds can pay distributions, which are part of their total return. None of these funds guarantees your original investment back on a fixed date.</p>
      </section>
      <section className="panel bond-explanation"><span className="eyebrow">Part 3</span><h3>Your choice</h3><div className="field"><label htmlFor="bond-pick">Which bond ETF are you explaining?</label><select id="bond-pick" value={response.ticker} onChange={e=>update({...response,ticker:e.target.value})}><option value="">Choose a current bond holding…</option>{response.ticker&&!bonds.some((b:any)=>b.ticker===response.ticker)&&<option value={response.ticker}>{response.ticker} — no longer held</option>}{bonds.map((b:any)=><option key={b.ticker} value={b.ticker}>{b.ticker} — {b.name}</option>)}</select></div>
        <div className="field"><label htmlFor="bond-reason">Why did you choose this fund for your portfolio, and what is one risk?</label><textarea id="bond-reason" rows={5} value={response.explanation} onChange={e=>update({...response,explanation:e.target.value})} placeholder="Explain what the fund holds, what it adds to your portfolio, and one risk you accept."/></div>
      </section>
      <div className="module-action-bar"><div><strong>{answered}/5 questions answered · {bonds.length?"Bond holding verified":"Bond holding still needed"}</strong><span>You can submit whatever you have. Your teacher sees your answers and portfolio evidence.</span></div><button disabled={busy} onClick={submit}>{busy?"Submitting…":post.submission?"Update submission":"Submit module"}</button></div>
    </>}
  </div>;
}
