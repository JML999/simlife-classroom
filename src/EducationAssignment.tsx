import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, money, uid } from "./api";
import { useModuleDraft } from "./use-module-draft";
import { WheelFace, SPIN_DURATION } from "./SpinWheel";
import { EDUCATION_PATHS, emptyEducationResponse, repaymentSchedule, monthlyFromWeekly, type EducationResponse } from "../shared/education-paths";

export function EducationAssignment({ id, moduleNumber, onBack, onApplied }: { id: string; moduleNumber?: number; onBack: () => void; onApplied: () => void }) {
  const [post, setPost] = useState<any>(null), [state, setState] = useState<any>(null);
  const [response, setResponse] = useState<EducationResponse>(emptyEducationResponse);
  const [busy, setBusy] = useState(false), [spinning, setSpinning] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [angle, setAngle] = useState(0), [sound, setSound] = useState(true);
  const frame = useRef<number | null>(null), audio = useRef<AudioContext | null>(null);
  const confirmation = useRef(uid());
  const autosave = useModuleDraft<EducationResponse>(`/api/class/posts/${id}/draft`);
  useEffect(() => {
    let alive = true;
    Promise.all([api<any>(`/api/class/posts/${id}`),api<any>(`/api/class/posts/${id}/education`)]).then(([data, next]) => {
      if (!alive) return;
      const saved = data.draft && (!data.submission || data.draft.updatedAt > data.submission.createdAt) ? data.draft : null;
      let answer = autosave.restore(data.studentId, saved?.response ?? data.submission?.response ?? emptyEducationResponse(), saved?.updatedAt || data.submission?.createdAt || "");
      if (next.decision) answer = { version:4,routeId:next.decision.routeId,reason:next.decision.reason };
      setPost(data);setState(next);setResponse(answer);
    }).catch(e => { if (alive) setError(e.message); });
    const refresh = () => { void api<any>(`/api/class/posts/${id}/education`).then(next => { if (alive) setState(next); }).catch(() => {}); };
    window.addEventListener("focus",refresh);
    return () => { alive=false;window.removeEventListener("focus",refresh);if(frame.current!==null)cancelAnimationFrame(frame.current);void audio.current?.close(); };
  },[id]);
  useEffect(() => {
    if (!spinning) return;
    const previous = document.body.style.overflow; document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  },[spinning]);
  const update = (next: EducationResponse) => {setResponse(next);autosave.change(next);confirmation.current=uid();};
  const submitWork = async () => {
    setBusy(true);setError("");
    try {await autosave.beforeSubmit();await api(`/api/class/posts/${id}/submit`,{method:"POST",body:JSON.stringify({response,idempotencyKey:confirmation.current})});autosave.submitted();confirmation.current=uid();setNotice("Work submitted. Your official career decision is a separate step below.");}
    catch(e:any){setError(e.message);}finally{setBusy(false);}
  };
  const choose = async () => {
    if(busy)return;setBusy(true);setError("");
    try {
      if(sound){try{audio.current ??= new AudioContext();await audio.current.resume();}catch{/* Spin works without sound. */}}
      await autosave.beforeSubmit();
      const next = await api<any>(`/api/class/posts/${id}/education/choose`,{method:"POST",body:JSON.stringify(response)});
      autosave.submitted();
      if(next.decision.outcome.index<0){setState(next);setBusy(false);onApplied();return;}
      setSpinning(true);setAngle(0);
      const target=2160+((360-next.decision.outcome.index*90)%360), start=performance.now();let previous=-1,lastTick=0;
      const reduced=window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const animate=(now:number)=>{
        const p=reduced?1:Math.min(1,(now-start)/SPIN_DURATION);const current=target*(1-(1-p)**3);setAngle(current);
        const wedge=Math.round(current/90);
        if(sound&&audio.current&&wedge!==previous&&now-lastTick>65&&p<1){
          previous=wedge;lastTick=now;const ctx=audio.current,o=ctx.createOscillator(),g=ctx.createGain();o.type="triangle";o.frequency.value=650;g.gain.setValueAtTime(.04,ctx.currentTime);g.gain.exponentialRampToValueAtTime(.001,ctx.currentTime+.04);o.connect(g);g.connect(ctx.destination);o.start();o.stop(ctx.currentTime+.05);
        }
        if(p<1)frame.current=requestAnimationFrame(animate);else{frame.current=null;setSpinning(false);setState(next);setBusy(false);onApplied();}
      };frame.current=requestAnimationFrame(animate);
    }catch(e:any){setError(e.message);setBusy(false);}
  };
  if(!post||!state)return <div className="class-section"><button className="class-back" onClick={onBack}>← Modules</button>{error?<div className="error" role="alert">{error}</div>:<p role="status">Loading your paths and budget…</p>}</div>;
  const selected=EDUCATION_PATHS.find(p=>p.id===response.routeId), terms=selected?repaymentSchedule(selected.principalCents):null;
  const decision=state.decision, budget=state.budget;
  const moneyLeft = (monthlyPay: number, loan: number) => monthlyPay - Math.min(monthlyPay, Number(budget.claimBalanceCents || 0)) - budget.existingExpensesCents - loan;
  return <div className="class-section college-assignment education-assignment" onBlurCapture={()=>void autosave.flush()}>
    <header className="module-head"><button className="class-back" onClick={onBack}>← Modules</button><div className="eyebrow">Module {moduleNumber} · Is College Right for Me?</div><h2>{post.title}</h2><p>One choice. A new paycheck. A loan payment that stays with you.</p></header>
    <section className="panel education-hero"><div><span className="eyebrow">Fast-forward to your next chapter</span><h3>Is the next paycheck worth the payment?</h3><p>Keep your current job with no new debt, or choose a school route and spin for a career. Compare the numbers before deciding.</p><p className="small">Your existing bills stay. We fast-forward through training and required licenses. Each career has a 1-in-4 chance in this game; those are game odds, not actual hiring rates.</p></div><img src="/module-art/education-decision.svg" alt="" /></section>
    <section className="panel education-current"><h3>Your starting point</h3><div className="education-stats"><div><span>Current job</span><strong>{budget.jobTitle||"Not assigned"}</strong></div><div><span>Weekly game paycheck</span><strong>{money(budget.weeklyPayCents)}</strong></div><div><span>Estimated monthly pay</span><strong>{money(budget.monthlyPayCents)}</strong></div></div><p className="small">Monthly view assumes 52 weekly checks per year. Known monthly rent: {money(budget.rentCents)} · car: {money(budget.carCents)} · other unpaid bills due within 30 days: {money(budget.otherDueCents)}. Your existing bills remain in Banking.</p>{budget.claimBalanceCents>0&&<p className="small">Your existing wage garnishment has {money(budget.claimBalanceCents)} left. The first-month comparisons below also subtract what that claim would take from your pay.</p>}</section>
    {!decision&&<>
      <div className="education-step"><span className="eyebrow">1 · Compare and choose</span><h3>Five paths. Different trade-offs.</h3><p>School budgets and SimLife scholarships below are fixed classroom scenarios, not actual school prices or aid offers. They keep borrowing manageable for the game. Open each school’s published costs to compare.</p></div>
      <div className="education-path-grid">{EDUCATION_PATHS.map(path=>{const loan=repaymentSchedule(path.principalCents);return <label key={path.id} className={`education-path${response.routeId===path.id?" selected":""}`}><div className="education-path-top"><input type="radio" name="education-path" value={path.id} checked={response.routeId===path.id} disabled={busy} onChange={()=>update({...response,routeId:path.id})}/><span>{path.title}</span></div><h4>{path.school}</h4><p className="small">{path.years}</p><dl><div><dt>Classroom school budget</dt><dd>{money(path.costCents)}</dd></div><div><dt>SimLife scholarship/support</dt><dd>−{money(path.supportCents)}</dd></div><div><dt>You borrow</dt><dd>{money(path.principalCents)}</dd></div></dl><div className="education-payment"><strong>{money(loan.monthlyCents)}</strong><span>per month</span></div><p>{path.risk}</p>{path.source&&<a href={path.source} target="_blank" rel="noreferrer" onClick={e=>e.stopPropagation()}>Published school costs ↗</a>}</label>;})}</div>
      {selected&&<section className="panel"><span className="eyebrow">Your possible outcomes</span><h3>{selected.title}: what could happen?</h3>{selected.jobs.length?<><p>Each outcome has a 25% chance. The same {money(terms!.monthlyCents)} loan payment applies to all four jobs.</p><div className="table-wrap"><table className="education-outcomes"><thead><tr><th>Possible career</th><th>Annual wage benchmark</th><th>Weekly game pay</th><th>Monthly money left*</th></tr></thead><tbody>{selected.jobs.map(job=><tr key={job.key}><td><strong>{job.title}</strong><small>{job.note}</small><a href={job.source} target="_blank" rel="noreferrer">BLS wage source ↗</a></td><td>{money(job.annual*100)}</td><td>{money(job.weeklyCents)}</td><td>{money(moneyLeft(monthlyFromWeekly(job.weeklyCents),terms!.monthlyCents))}</td></tr>)}</tbody></table></div><p className="small">*Monthly game pay minus existing expenses, any remaining wage claim, and the new loan. BLS May 2025 figures describe typical workers, not guaranteed starting pay or a school’s graduates. Game weekly pay uses 80% of the annual benchmark ÷ 52 as a simple take-home estimate. Hourly careers are annualized at 2,080 hours.</p></>:<p>Keep {budget.jobTitle||"your current job"} at {money(budget.weeklyPayCents)} per weekly paycheck. No new loan. Estimated monthly money left: <strong>{money(moneyLeft(budget.monthlyPayCents,0))}</strong>.</p>}
      {terms&&selected.jobs.length>0&&<div className="education-loan-math"><strong>Your fixed loan</strong><p>{money(selected.principalCents)} borrowed · 6% classroom APR · 120 months</p><p>Monthly payment: {money(terms.monthlyCents)} · total repaid: {money(terms.totalCents)} · total interest: {money(terms.interestCents)}</p><p className="small">The final installment may be slightly smaller. Future job changes do not change this payment. No extra late interest or fees in this classroom scenario.</p></div>}</section>}
    </>}
    {decision?<section className="panel education-result"><span className="eyebrow">Your official decision is saved</span><h3>{decision.outcome.title}</h3><p>{decision.terms.title} · {money(decision.outcome.weeklyCents)} per weekly paycheck at the time of your decision.</p><div className="education-stats"><div><span>Monthly loan payment</span><strong>{money(decision.terms.monthlyCents)}</strong></div><div><span>Repaid so far</span><strong>{money(decision.paidCents)}</strong></div><div><span>Remaining scheduled repayment</span><strong>{money(decision.remainingCents)}</strong></div></div><p>Estimated monthly money left with your current job and bills: <strong>{money(moneyLeft(budget.monthlyPayCents,decision.remainingCents?decision.terms.monthlyCents:0))}</strong>.</p><p>{decision.terms.monthlyCents?"Your first statement is in Banking, due one month after your decision. Another arrives each month until all scheduled payments are issued. Payments from checking reduce the balance above, including partial payments.":"You kept your current job and took on no education debt."}</p><p><strong>Your reason:</strong> {decision.reason}</p><p className="small">The balance includes all scheduled principal and interest, not just bills already issued. One official decision per student; refreshing never rerolls your career.</p></section>:<section className="panel"><span className="eyebrow">2 · Explain your decision</span><h3>Why this path?</h3><div className="field"><label htmlFor="education-reason">Which path are you choosing, and why does its possible income justify its cost—or lack of cost?</label><textarea id="education-reason" rows={4} value={response.reason} maxLength={6000} disabled={busy} onChange={e=>update({...response,reason:e.target.value})}/></div></section>}
    {error&&<div className="error" role="alert">{error}</div>}
    {!decision&&<section className="panel education-commit"><span className="eyebrow">3 · Make it official</span><h3>{selected?.id==="work"?"Keep your job. Skip the loan.":"Ready for your career spin?"}</h3><p>This changes your game account: one saved outcome, a new assigned paycheck for a school route, and its fixed monthly loan bills. You cannot reroll or switch routes afterward. Borrowed funds cover school; they are not deposited as spending money.</p>{!state.enabled&&<p className="notice">Your teacher has not opened career decisions for this period yet. You can compare paths and save or submit your work now. Return when your teacher opens decisions.</p>}<label className="education-sound"><input type="checkbox" checked={sound} onChange={e=>setSound(e.target.checked)} disabled={busy}/>Wheel sound</label><button disabled={busy||!state.enabled||!selected||!response.reason.trim()} onClick={choose}>{busy?"Choosing…":selected?.id==="work"?"Keep my job · no new loan":"Choose this path & spin"}</button></section>}
    {!decision&&<div className="module-action-bar college-action-bar"><p role="status">{autosave.status||notice||"Your work saves automatically. You can submit unfinished work without making a financial decision."}</p><button className="ghost" disabled={busy} onClick={submitWork}>{busy?"Saving…":"Submit work"}</button></div>}
    {spinning&&selected&&createPortal(<div className="life-wheel-stage education-spin-stage" role="dialog" aria-modal="true" aria-label="Your career spin"><div className="life-wheel-stage-content"><div className="life-wheel-stage-heading"><span className="eyebrow">{selected.title}</span><h2>Your next chapter…</h2><p>The job is a surprise. Your loan payment stays {money(terms!.monthlyCents)} per month.</p></div><WheelFace angle={angle} options={selected.jobs} presenting/><div className="life-wheel-passing" role="status">Spinning…</div></div></div>,document.body)}
  </div>;
}

export function TeacherEducationControls({classId}:{classId:string}) {
  const [data,setData]=useState<any>(null),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  useEffect(()=>{let alive=true;setData(null);api<any>(`/api/teacher/classes/${classId}/education`).then(next=>{if(alive)setData(next);}).catch(e=>{if(alive)setError(e.message);});return()=>{alive=false;};},[classId]);
  const toggle=async()=>{setBusy(true);setError("");try{setData({...data,...await api<any>(`/api/teacher/classes/${classId}/education`,{method:"PUT",body:JSON.stringify({enabled:!data.enabled})})});}catch(e:any){setError(e.message);}finally{setBusy(false);}};
  return <section className="panel teacher-education"><span className="eyebrow">After Black Monday</span><h3>Education & career decisions</h3><p>Let students compare the five paths in College Module 3. Open decisions when you are ready for their one official choice and career spin. Opening this does not change anyone’s account by itself.</p>{error&&<p className="error">{error}</p>}{data?<><button disabled={busy} onClick={toggle}>{busy?"Saving…":data.enabled?"Close career decisions":"Open career decisions for this period"}</button><p className="small">{data.enabled?"Decisions are open. A student’s official choice changes their job and starts their loan bills.":"Decisions are closed. Students can still view the module, autosave, and submit unfinished work."}</p>{data.decisions?.length>0&&<details><summary>Recorded choices · {data.decisions.length}</summary>{data.decisions.map((d:any)=><p key={d.user_id}><strong>{d.name}</strong> · {EDUCATION_PATHS.find(p=>p.id===d.route_id)?.title} · {JSON.parse(d.outcome).title}</p>)}</details>}</>:<p role="status">Loading decision controls…</p>}</section>;
}

export function EducationLoanStatus({ decision }: { decision: any }) {
  if (!decision?.terms?.principalCents) return null;
  return <section className="panel education-bank-status"><h3>Student loan</h3><p>{decision.terms.school} · <strong>{money(decision.terms.monthlyCents)} per month</strong></p><p>Repaid: {money(decision.paidCents)} · Remaining scheduled repayment (including planned interest): {money(decision.remainingCents)}</p><p className="small">Pay monthly statements in your mailbox. Your payment stays fixed if your job changes.</p></section>;
}
