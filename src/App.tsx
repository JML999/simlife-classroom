import { useCallback, useEffect, useRef, useState } from "react";
import { api, money, uid, fmtWhen, ApiError } from "./api.js";

declare global { interface Window { google?: any } }

interface Me { user: { id: string; email: string | null; name: string; role: string }; class: any }
interface Portfolio {
  cashCents: number; investedCents: number; portfolioCents: number; gainLossCents: number;
  unrealizedGainLossCents: number; realizedGainLossCents: number;
  holdings: any[]; quotesDelayed: boolean; quoteSource: string;
}

export default function App() {
  const [config, setConfig] = useState<any>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setMe(await api<Me>("/api/me"));
    } catch { setMe(null); }
  }, []);

  useEffect(() => {
    (async () => {
      setConfig(await api("/api/auth/config"));
      await refresh();
      setLoading(false);
    })();
  }, [refresh]);

  if (loading) return <div className="wrap"><p>Loading SimLife…</p></div>;

  return (
    <>
      <div className="banner">SIMULATED MONEY — FOR CLASS ONLY. Not real banking or investing. No financial advice.</div>
      <div className="wrap">
        <div className="topbar">
          <div className="brand">
            <div className="brand-mark">$</div>
            <div>
              <h1>SimLife</h1>
              <p>Classroom money · banking + investing</p>
            </div>
          </div>
          {me && (
            <div className="row">
              <span className="small">{me.user.name} · {me.user.role}</span>
              <button className="ghost" onClick={async () => { await api("/api/auth/logout", { method: "POST" }); setMe(null); }}>Sign out</button>
            </div>
          )}
        </div>
        {!me
          ? <Login config={config} onDone={refresh} />
          : me.user.role === "teacher"
            ? <Teacher me={me} refresh={refresh} />
            : !me.class
              ? <JoinGate refresh={refresh} />
              : <Student me={me} refreshSession={refresh} />}
      </div>
    </>
  );
}

// ---------------- login ----------------

function Login({ config, onDone }: { config: any; onDone: () => void }) {
  const [demoUsers, setDemoUsers] = useState<any[]>([]);
  const [err, setErr] = useState("");
  const btnRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (config?.demoEnabled) api<{ users: any[] }>("/api/demo/users").then((r) => setDemoUsers(r.users)).catch(() => {});
  }, [config]);

  useEffect(() => {
    if (!config?.googleClientId || !btnRef.current) return;
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.onload = () => {
      window.google?.accounts.id.initialize({
        client_id: config.googleClientId,
        callback: async (resp: any) => {
          try {
            await api("/api/auth/google", { method: "POST", body: JSON.stringify({ credential: resp.credential }) });
            onDone();
          } catch (e: any) { setErr(e.message); }
        },
      });
      window.google?.accounts.id.renderButton(btnRef.current, { theme: "outline", size: "large" });
    };
    document.body.appendChild(s);
    return () => { s.remove(); };
  }, [config, onDone]);

  return (
    <div className="panel login-box">
      <h2>Sign in</h2>
      <p className="hint">Use your school Google account{config?.domain ? <> (<span className="kbd">{config.domain}</span>)</> : null}. All money here is simulated for class.</p>
      {config?.googleClientId ? <div ref={btnRef} /> : <p className="small">Google sign-in is not configured yet — use a demo account below.</p>}
      {err && <div className="error">{err}</div>}
      {config?.demoEnabled && (
        <>
          <h2 style={{ marginTop: 20 }}>Demo accounts (local testing only)</h2>
          <p className="hint">Disabled automatically in production.</p>
          <div className="row">
            {demoUsers.map((u) => (
              <button key={u.id} className="ghost" onClick={async () => {
                await api("/api/auth/demo", { method: "POST", body: JSON.stringify({ userId: u.id }) });
                onDone();
              }}>{u.name}</button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function JoinGate({ refresh }: { refresh: () => void }) {
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  return (
    <div className="panel login-box">
      <h2>Join your class</h2>
      <p className="hint">Enter the join code your teacher posted in class.</p>
      <div className="row">
        <div className="field"><label>Join code</label><input value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. DEMO1" /></div>
        <button onClick={async () => {
          try { await api("/api/classes/join", { method: "POST", body: JSON.stringify({ code }) }); refresh(); }
          catch (e: any) { setErr(e.message); }
        }}>Join class</button>
      </div>
      {err && <div className="error">{err}</div>}
    </div>
  );
}

// ---------------- student ----------------

function Student({ me, refreshSession }: { me: Me; refreshSession: () => void }) {
  const [pf, setPf] = useState<Portfolio | null>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [err, setErr] = useState("");
  const [symbol, setSymbol] = useState("");
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [quote, setQuote] = useState<any>(null);
  const [buyQty, setBuyQty] = useState("");
  const [buyDollars, setBuyDollars] = useState("");
  const [sellQty, setSellQty] = useState("");
  const [sellTicker, setSellTicker] = useState("");
  const [expandedTicker, setExpandedTicker] = useState("");
  const [portfolioQuery, setPortfolioQuery] = useState("");
  const [portfolioSort, setPortfolioSort] = useState("value");
  const [portfolioPage, setPortfolioPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  // One idempotency key per form submission; reused across retries.
  const buyKey = useRef(uid());
  const sellKey = useRef(uid());
  const [section, setSection] = useState<"banking" | "investing">("banking");

  const load = useCallback(async () => {
    try {
      setPf(await api<Portfolio>("/api/portfolio"));
      setHistory((await api<{ entries: any[] }>("/api/history")).entries);
    } catch (e: any) { setErr(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const timer = window.setInterval(refreshSession, 15_000);
    return () => window.clearInterval(timer);
  }, [refreshSession]);

  const lookup = async (sym: string) => {
    setErr(""); setNotice("");
    try {
      const r = await api<{ quote: any }>(`/api/quotes?symbol=${encodeURIComponent(sym)}`);
      setQuote(r.quote);
    } catch (e: any) { setErr(e.message); setQuote(null); }
  };

  const doSearch = async (v: string) => {
    setSymbol(v);
    if (v.trim().length < 1) { setSearchResults([]); return; }
    try { setSearchResults((await api<{ results: any[] }>(`/api/search?q=${encodeURIComponent(v)}`)).results); }
    catch { /* ignore */ }
  };

  const submitBuy = async () => {
    if (!quote || busy) return;
    setBusy(true); setErr(""); setNotice("");
    try {
      const body: any = { ticker: quote.ticker, idempotencyKey: buyKey.current };
      if (buyDollars) body.dollarsCents = Math.round(Number(buyDollars) * 100);
      else body.qtyMicro = Math.round(Number(buyQty) * 1_000_000);
      const r = await api<any>("/api/trades/buy", { method: "POST", body: JSON.stringify(body) });
      setPf(r.portfolio); setHistory((await api<{ entries: any[] }>("/api/history")).entries);
      setNotice(r.deduped ? "Already processed — duplicate ignored." : `Bought simulated shares for ${money(r.costCents)}.`);
      buyKey.current = uid(); setBuyQty(""); setBuyDollars("");
    } catch (e: any) {
      setErr(e.message);
      if (e instanceof ApiError && e.code === "TRADING_FROZEN") refreshSession();
    } finally { setBusy(false); }
  };

  const submitSell = async (h: any, all: boolean) => {
    if (busy) return;
    setBusy(true); setErr(""); setNotice("");
    try {
      const body: any = { ticker: h.ticker, idempotencyKey: sellKey.current };
      if (all) body.sellAll = true; else body.qtyMicro = Math.round(Number(sellQty) * 1_000_000);
      const r = await api<any>("/api/trades/sell", { method: "POST", body: JSON.stringify(body) });
      setPf(r.portfolio); setHistory((await api<{ entries: any[] }>("/api/history")).entries);
      setNotice(r.deduped ? "Already processed — duplicate ignored." : `Sold simulated shares for ${money(r.proceedsCents)}.`);
      sellKey.current = uid(); setSellQty(""); setSellTicker("");
    } catch (e: any) {
      setErr(e.message);
      if (e instanceof ApiError && e.code === "TRADING_FROZEN") refreshSession();
    } finally { setBusy(false); }
  };

  const frozen = me.class?.trading_frozen === 1;
  const gl = pf?.gainLossCents ?? 0;
  const holdingsMarketValue = pf?.holdings.reduce((sum, item) => sum + item.marketCents, 0) ?? 0;
  const portfolioPageSize = 15;
  const filteredHoldings = (pf?.holdings ?? [])
    .filter((holding) => holding.ticker.toLowerCase().includes(portfolioQuery.trim().toLowerCase()))
    .sort((a, b) => {
      if (portfolioSort === "ticker") return a.ticker.localeCompare(b.ticker);
      if (portfolioSort === "return") return (b.costBasisCents ? b.gainLossCents / b.costBasisCents : 0) - (a.costBasisCents ? a.gainLossCents / a.costBasisCents : 0);
      if (portfolioSort === "return-low") return (a.costBasisCents ? a.gainLossCents / a.costBasisCents : 0) - (b.costBasisCents ? b.gainLossCents / b.costBasisCents : 0);
      return b.marketCents - a.marketCents;
    });
  const portfolioPageCount = Math.max(1, Math.ceil(filteredHoldings.length / portfolioPageSize));
  const currentPortfolioPage = Math.min(portfolioPage, portfolioPageCount);
  const visibleHoldings = filteredHoldings.slice((currentPortfolioPage - 1) * portfolioPageSize, currentPortfolioPage * portfolioPageSize);

  return (
    <>
      <div className="pills section-tabs" role="tablist" aria-label="Money sections">
        <button role="tab" aria-selected={section === "banking"} className={`pill${section === "banking" ? " active" : ""}`} onClick={() => setSection("banking")}>Banking</button>
        <button role="tab" aria-selected={section === "investing"} className={`pill${section === "investing" ? " active" : ""}`} onClick={() => setSection("investing")}>Investing</button>
      </div>
      {section === "banking" && <StudentBanking me={me} onChanged={load} onOpenInvesting={() => setSection("investing")} />}
      {section === "investing" && <div className="investing-section">
      <div className="page-intro">
        <div>
          <div className="eyebrow">{me.class?.name || "Personal Finance"}</div>
          <h2>Your investing account</h2>
          <p>Use your available simulated cash to practice building and tracking a portfolio.</p>
        </div>
        <div className={`market-status ${frozen ? "closed" : "open"}`}>
          <span className="status-dot" /> Trading {frozen ? "closed" : "open"}
        </div>
      </div>
      {frozen && <div className="frozen">Trading is paused by your teacher. You can review your portfolio but cannot buy or sell right now.</div>}
      <div className="cards">
        <div className="card"><div className="label">Cash available</div><div className="value">{pf ? money(pf.cashCents) : "…"}</div><div className="sub">Available to invest</div></div>
        <div className="card"><div className="label">Amount invested (simulated)</div><div className="value">{pf ? money(pf.investedCents) : "…"}</div><div className="sub">Cost of current holdings</div></div>
        <div className="card"><div className="label">Portfolio value (simulated)</div><div className="value">{pf ? money(pf.portfolioCents) : "…"}</div><div className="sub">Cash + market value</div></div>
        <div className="card"><div className="label">Total return</div><div className={`value ${gl >= 0 ? "up" : "down"}`}>{pf ? money(gl) : "…"}</div><div className="sub">Realized + unrealized · delayed quotes{pf ? ` · ${pf.quoteSource}` : ""}</div></div>
      </div>
      {err && <div className="error" role="alert">{err}</div>}
      {notice && <div className="notice" role="status" aria-live="polite">{notice}</div>}

      <div className="grid2">
        <div className="panel">
          <h2>Buy simulated shares</h2>
          <p className="hint">Fractional shares allowed. Prices are delayed and for class only.</p>
          <div className="field">
            <label>Ticker symbol</label>
            <input value={symbol} onChange={(e) => doSearch(e.target.value)} placeholder="e.g. VOO" />
          </div>
          {searchResults.length > 0 && (
            <div className="row" style={{ marginTop: 8 }}>
              {searchResults.map((s) => (
                <button key={s.ticker} className="ghost" onClick={() => { setSymbol(s.ticker); lookup(s.ticker); }}>{s.ticker} — {s.name}</button>
              ))}
            </div>
          )}
          <div className="row" style={{ marginTop: 8 }}>
            <button onClick={() => lookup(symbol)} disabled={!symbol.trim()}>Look up price</button>
          </div>
          {quote && (
            <div style={{ marginTop: 12 }}>
              <p><strong>{quote.ticker}</strong> — {money(quote.priceCents)} <span className="small">(delayed · {quote.source} · {new Date(quote.asOf).toLocaleTimeString()})</span></p>
              <div className="row">
                <div className="field"><label>Shares (fractional ok)</label><input value={buyQty} onChange={(e) => { setBuyQty(e.target.value); setBuyDollars(""); }} placeholder="0.5" inputMode="decimal" /></div>
                <div className="field"><label>— or — dollars</label><input value={buyDollars} onChange={(e) => { setBuyDollars(e.target.value); setBuyQty(""); }} placeholder="25.00" inputMode="decimal" /></div>
                <button onClick={submitBuy} disabled={busy || frozen || (!buyQty && !buyDollars)}>Buy (simulated)</button>
              </div>
            </div>
          )}
        </div>

        <div className="panel portfolio-panel">
          <div className="panel-heading">
            <div><h2>Portfolio</h2><p className="hint">A clear picture of what you own and how each investment is performing.</p></div>
            {pf && pf.holdings.length > 0 && <span className="portfolio-count">{pf.holdings.length} investment{pf.holdings.length === 1 ? "" : "s"}</span>}
          </div>
          {!pf?.holdings.length && <div className="portfolio-empty"><span>01</span><strong>Your portfolio is ready to begin.</strong><p>Look up a ticker and make your first simulated investment.</p></div>}
          {pf && pf.holdings.length > 0 && (
            <>
              <div className="portfolio-tools">
                <div className="field grow"><label htmlFor="portfolio-search">Find an investment</label><input id="portfolio-search" type="search" value={portfolioQuery} onChange={(e) => { setPortfolioQuery(e.target.value); setPortfolioPage(1); }} placeholder="Search ticker" /></div>
                <div className="field"><label htmlFor="portfolio-sort">Sort by</label><select id="portfolio-sort" value={portfolioSort} onChange={(e) => { setPortfolioSort(e.target.value); setPortfolioPage(1); }}><option value="value">Largest position</option><option value="ticker">Ticker A–Z</option><option value="return">Best return</option><option value="return-low">Lowest return</option></select></div>
              </div>
              <div className="portfolio-column-heads" aria-hidden="true"><span>Investment</span><span>Value</span><span>Allocation</span><span>Return</span><span /></div>
              <div className="portfolio-list">
              {visibleHoldings.map((h) => {
                const allocation = holdingsMarketValue > 0 ? (h.marketCents / holdingsMarketValue) * 100 : 0;
                const returnPct = h.costBasisCents > 0 ? (h.gainLossCents / h.costBasisCents) * 100 : 0;
                const selling = sellTicker === h.ticker;
                const expanded = expandedTicker === h.ticker;
                return <article className={`portfolio-item ${expanded ? "expanded" : ""}`} key={h.ticker}>
                  <button className="portfolio-row-summary" aria-expanded={expanded} onClick={() => { setExpandedTicker(expanded ? "" : h.ticker); setSellTicker(""); setSellQty(""); }}>
                    <span className="portfolio-identity"><strong className="ticker">{h.ticker}</strong><small>{h.shares.toFixed(4)} shares</small></span>
                    <span className="portfolio-cell"><small>Value</small><strong>{money(h.marketCents)}</strong></span>
                    <span className="portfolio-cell"><small>Allocation</small><strong>{allocation.toFixed(1)}%</strong></span>
                    <span className={`portfolio-cell ${h.gainLossCents >= 0 ? "up" : "down"}`}><small>Return</small><strong>{returnPct >= 0 ? "+" : ""}{returnPct.toFixed(1)}%</strong></span>
                    <span className="portfolio-chevron" aria-hidden="true">{expanded ? "−" : "+"}</span>
                  </button>
                  {expanded && <div className="portfolio-detail">
                    <div className="allocation-track" aria-label={`${h.ticker} is ${allocation.toFixed(1)} percent of investments`}><span style={{ width: `${Math.max(2, allocation)}%` }} /></div>
                    <div className="portfolio-metrics">
                      <div><span>Shares owned</span><strong>{h.shares.toFixed(4)}</strong></div>
                      <div><span>Average cost</span><strong>{money(h.avgCostCents)}</strong></div>
                      <div><span>Current price</span><strong>{h.priceCents == null ? "—" : money(h.priceCents)}</strong></div>
                      <div><span>Gain / loss</span><strong className={h.gainLossCents >= 0 ? "up" : "down"}>{money(h.gainLossCents)} <small>({returnPct >= 0 ? "+" : ""}{returnPct.toFixed(1)}%)</small></strong></div>
                    </div>
                    <div className="portfolio-actions">
                      <button className="ghost" disabled={busy || frozen} onClick={() => { setSellTicker(selling ? "" : h.ticker); setSellQty(""); }}>{selling ? "Cancel" : "Sell shares"}</button>
                      <button className="text-danger" disabled={busy || frozen} onClick={() => submitSell(h, true)}>Sell all</button>
                    </div>
                    {selling && <div className="inline-sell">
                      <div className="field"><label htmlFor={`sell-${h.ticker}`}>How many shares?</label><input id={`sell-${h.ticker}`} value={sellQty} onChange={(e) => setSellQty(e.target.value)} placeholder={`Up to ${h.shares.toFixed(4)}`} inputMode="decimal" autoFocus /></div>
                      <button disabled={busy || frozen || !(Number(sellQty) > 0) || Number(sellQty) > h.shares} onClick={() => submitSell(h, false)}>Sell shares</button>
                    </div>}
                  </div>}
                </article>;
              })}
              </div>
              {visibleHoldings.length === 0 && <div className="portfolio-no-results">No investments match “{portfolioQuery}.”</div>}
              <div className="portfolio-footer">
                <span>{filteredHoldings.length === 0 ? "0 investments" : `Showing ${(currentPortfolioPage - 1) * portfolioPageSize + 1}–${Math.min(currentPortfolioPage * portfolioPageSize, filteredHoldings.length)} of ${filteredHoldings.length}`}</span>
                {portfolioPageCount > 1 && <div className="pagination"><button className="ghost" disabled={currentPortfolioPage === 1} onClick={() => { setPortfolioPage(currentPortfolioPage - 1); setExpandedTicker(""); }}>Previous</button><span>Page {currentPortfolioPage} of {portfolioPageCount}</span><button className="ghost" disabled={currentPortfolioPage === portfolioPageCount} onClick={() => { setPortfolioPage(currentPortfolioPage + 1); setExpandedTicker(""); }}>Next</button></div>}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="panel">
        <h2>Transaction history (simulated)</h2>
        <p className="hint">Every purchase, sale, and teacher cash adjustment on your account.</p>
        <div className="table-wrap"><table>
          <thead><tr><th>When</th><th>What</th><th>Detail</th><th>Cash effect</th></tr></thead>
          <tbody>
            {history.map((e) => (
              <tr key={e.id}>
                <td className="small">{new Date(e.created_at).toLocaleString()}</td>
                <td>{describeEntry(e)}</td>
                <td className="small">{entryDetail(e)}</td>
                <td className={e.amount_cents >= 0 ? "up" : "down"}>{money(e.amount_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </div>
      </div>}
    </>
  );
}

function describeBankEntry(e: any): string {
  if (e.kind === "income") return "Paycheck / deposit";
  if (e.kind === "transfer") return "Transfer";
  if (e.kind === "transfer_to_brokerage") return "Moved to brokerage";
  if (e.kind === "bill_payment") return "Bill paid";
  if (e.kind === "savings_interest") return "Savings interest";
  return e.kind;
}

function bankEntryAmount(e: any): number {
  if (e.kind === "transfer") return Math.max(Math.abs(e.checking_leg), Math.abs(e.savings_leg));
  return e.checking_leg + e.savings_leg;
}

function billBadge(status: string): string {
  return status === "paid" ? "badge-paid" : status === "late" ? "badge-late" : "badge-due";
}

function SavingsProjection({ interest }: { interest: any }) {
  const points = [{ years: 0, balanceCents: 0 }, ...(interest?.projection || [])];
  const current = points.length > 1 ? Math.max(0, points[1].balanceCents - points[1].interestCents) : 0;
  points[0].balanceCents = current;
  const max = Math.max(1, ...points.map((p) => p.balanceCents));
  const svgPoints = points.map((p) => `${8 + (p.years / 10) * 284},${112 - (p.balanceCents / max) * 94}`).join(" ");
  return <div className="savings-growth">
    <div className="growth-heading">
      <div><span className="bank-kicker">Savings growth</span><h2>Your money earns money</h2></div>
      <div className="apy-bubble"><strong>{((interest?.apy || 0) * 100).toFixed(2)}%</strong><span>APY</span></div>
    </div>
    <p>Projection assumes your current balance stays deposited with no additional contributions or withdrawals.</p>
    <svg className="growth-chart" viewBox="0 0 300 120" role="img" aria-label="Projected savings balance over ten years">
      <defs><linearGradient id="growthFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#47c978" stopOpacity=".34" /><stop offset="100%" stopColor="#47c978" stopOpacity=".03" /></linearGradient></defs>
      <path d={`M ${svgPoints.replaceAll(" ", " L ")} L 292 116 L 8 116 Z`} fill="url(#growthFill)" />
      <polyline points={svgPoints} fill="none" stroke="#269c58" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      {points.map((p) => <circle key={p.years} cx={8 + (p.years / 10) * 284} cy={112 - (p.balanceCents / max) * 94} r="4" fill="#fff" stroke="#269c58" strokeWidth="3" />)}
    </svg>
    <div className="growth-milestones">
      {(interest?.projection || []).map((p: any) => <div key={p.years}><span>{p.years} year{p.years === 1 ? "" : "s"}</span><strong>{money(p.balanceCents)}</strong><small>+{money(p.interestCents)} interest</small></div>)}
    </div>
    <div className="growth-foot"><span>{interest?.label}</span><span>Rate as of {interest?.asOf ? new Date(`${interest.asOf}T12:00:00`).toLocaleDateString() : "—"} · variable classroom rate</span></div>
  </div>;
}

function StudentBanking({ me, onChanged, onOpenInvesting }: { me: Me; onChanged: () => void; onOpenInvesting: () => void }) {
  const [bank, setBank] = useState<any>(null);
  const [err, setErr] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [payingId, setPayingId] = useState<string | null>(null);
  const [selectedBill, setSelectedBill] = useState<any>(null);
  const [payDollars, setPayDollars] = useState("");
  const [showPayment, setShowPayment] = useState(false);
  const [showDispute, setShowDispute] = useState(false);
  const [disputeReason, setDisputeReason] = useState("");
  const [from, setFrom] = useState("checking");
  const [to, setTo] = useState("savings");
  const [dollars, setDollars] = useState("");
  const [confirmX, setConfirmX] = useState(false);
  const xKey = useRef(uid());
  const payKey = useRef(uid());
  const disputeKey = useRef(uid());

  const load = useCallback(async () => {
    try { setBank(await api("/api/bank")); }
    catch (e: any) { setErr(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const bills: any[] = bank?.bills || [];
  const unpaid = bills.filter((b) => !b.paid_at);
  const paid = bills.filter((b) => b.paid_at);
  const unpaidTotal = unpaid.reduce((s: number, b: any) => s + b.remaining_cents, 0);

  const openBill = (bill: any, payment = false) => {
    setSelectedBill(bill); setShowPayment(payment); setShowDispute(false); setDisputeReason("");
    setPayDollars((bill.remaining_cents / 100).toFixed(2)); setErr("");
  };

  const submitTransfer = async () => {
    if (busy || !dollars) return;
    setBusy(true); setErr(""); setNotice("");
    try {
      const r = await api<any>("/api/bank/transfer", {
        method: "POST",
        body: JSON.stringify({ from, to, dollars: Number(dollars), idempotencyKey: xKey.current }),
      });
      setNotice(r.deduped
        ? "Already processed — duplicate ignored."
        : to === "brokerage"
          ? `Moved ${money(Math.round(Number(dollars) * 100))} into your brokerage account. It is ready to invest.`
          : `Moved ${money(Math.round(Number(dollars) * 100))} from ${from} to ${to}.`);
      xKey.current = uid(); setDollars(""); setConfirmX(false);
      await load(); onChanged();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  const pay = async (bill: any) => {
    if (busy) return;
    setBusy(true); setPayingId(bill.id); setErr(""); setNotice("");
    try {
      const r = await api<any>(`/api/bank/bills/${bill.id}/pay`, {
        method: "POST", body: JSON.stringify({ dollars: Number(payDollars), idempotencyKey: payKey.current }),
      });
      setNotice(r.deduped ? "Already processed — duplicate ignored." : r.remainingCents === 0 ? `Paid “${bill.title}” in full.` : `Payment sent. ${money(r.remainingCents)} remains on “${bill.title}.”`);
      payKey.current = uid(); setSelectedBill(null); setShowPayment(false);
      await load(); onChanged();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); setPayingId(null); }
  };

  const dispute = async (bill: any) => {
    if (busy) return;
    setBusy(true); setErr(""); setNotice("");
    try {
      const r = await api<any>(`/api/bank/bills/${bill.id}/dispute`, {
        method: "POST", body: JSON.stringify({ reason: disputeReason, idempotencyKey: disputeKey.current }),
      });
      setNotice(r.deduped ? "That question was already submitted." : "Your question was sent to your teacher. The bill remains due while it is reviewed.");
      disputeKey.current = uid(); setSelectedBill(null); setDisputeReason(""); setShowDispute(false);
      await load();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="banking-experience">
      <div className="bank-welcome">
        <div>
          <div className="bank-kicker">{me.class?.name || "Personal Finance"}</div>
          <h2>Welcome back, {me.user.name.split(" ")[0]}!</h2>
          <p>Check your mail, pay what is due, then decide what to save or invest.</p>
        </div>
        <div className="wallet-art" aria-hidden="true"><span>💵</span><strong>👛</strong><i>★</i></div>
      </div>
      {unpaidTotal > 0 && (
        <div className="money-reminder" role="note"><span>🔔</span><div><strong>{money(unpaidTotal)} is still spoken for</strong><p>You have {unpaid.length} unpaid bill{unpaid.length === 1 ? "" : "s"}. Your checking balance is not the same as money available to invest.</p></div></div>
      )}
      <div className="bank-section-heading"><div><span className="bank-kicker">My money</span><h2>Your accounts</h2></div><span className="sim-chip">Simulated funds</span></div>
      <div className="bank-account-grid">
        <article className="account-tile checking-tile"><div className="account-icon">💳</div><span>Checking</span><strong>{bank ? money(bank.checkingCents) : "…"}</strong><p>Paychecks arrive here. Bills leave from here.</p></article>
        <article className="account-tile savings-tile"><div className="account-icon">🌱</div><span>High-yield savings</span><strong>{bank ? money(bank.savingsCents) : "…"}</strong><p>{bank ? `${(bank.savingsInterest.apy * 100).toFixed(2)}% APY · ${money(bank.savingsInterest.earnedCents)} earned` : "Interest is loading…"}</p></article>
        <article className="account-tile investing-tile"><div className="account-icon">📈</div><span>Brokerage</span><strong>{bank ? money(bank.brokerage.portfolioCents) : "…"}</strong><p>{bank ? `${money(bank.brokerage.cashCents)} ready to invest` : "Portfolio is loading…"}</p><button className="tile-link" onClick={onOpenInvesting}>Open investing →</button></article>
      </div>
      {err && <div className="error" role="alert">{err}</div>}
      {notice && <div className="notice" role="status" aria-live="polite">{notice}</div>}

      <div className="bank-dashboard-grid">
        <section className="bank-panel mailbox-panel">
          <div className="bank-panel-title"><div className="mail-icon">✉️</div><div><span className="bank-kicker">Bills & notices</span><h2>Mailbox</h2></div><span className="mail-count">{unpaid.length} to do</span></div>
          <p className="bank-hint">Open each letter to review the details. Nothing is taken from checking until you choose to pay.</p>
          {bills.length === 0 && <p className="small">No bills yet. When your teacher sends one, it will appear here.</p>}
          <div className="mailbox">
            {unpaid.map((b) => (
              <article className="mail-item" key={b.id}>
                <div className="envelope-mark" aria-hidden="true">✉</div>
                <div className="mail-copy">
                <div className="bill-top">
                  <div><span>{b.sender || "SimLife Mail"}</span><strong>{b.title}</strong></div>
                  <span className={billBadge(b.status)}>{b.status === "paid" ? "Paid" : b.status === "late" ? "Late" : "Due"}</span>
                </div>
                <div className="mail-facts"><span>Due {new Date(b.due_at).toLocaleDateString()}</span><strong>{money(b.remaining_cents)} remaining</strong>{b.paid_cents > 0 && <span>{money(b.paid_cents)} paid</span>}</div>
                {b.disputes?.some((d: any) => d.status === "open") && <div className="question-sent">Question sent · awaiting teacher review</div>}
                {(b.disputes || []).some((d: any) => d.status === "resolved") && <div className="question-answered">Teacher replied — open the letter to read the answer</div>}
                <div className="mail-actions"><button className="ghost" onClick={() => openBill(b)}>Read</button><button disabled={busy} onClick={() => openBill(b, true)}>{payingId === b.id ? "Paying…" : "Pay bill"}</button></div>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="bank-panel transfer-panel">
          <div className="bank-panel-title"><div className="transfer-icon">↔</div><div><span className="bank-kicker">Quick action</span><h2>Move money</h2></div></div>
          <p className="bank-hint">Move money between checking and savings, or send it to brokerage when it is truly available to invest.</p>
          <div className="row">
            <div className="field"><label>From</label>
              <select value={from} onChange={(e) => { setFrom(e.target.value); setConfirmX(false); }}>
                <option value="checking">Checking</option>
                <option value="savings">Savings</option>
              </select>
            </div>
            <div className="field"><label>To</label>
              <select value={to} onChange={(e) => { setTo(e.target.value); setConfirmX(false); }}>
                {from === "checking" && <option value="savings">Savings</option>}
                {from === "savings" && <option value="checking">Checking</option>}
                {from === "checking" && <option value="brokerage">Brokerage (invest)</option>}
              </select>
            </div>
            <div className="field"><label>Dollars</label><input value={dollars} onChange={(e) => { setDollars(e.target.value); setConfirmX(false); }} placeholder="50.00" inputMode="decimal" /></div>
          </div>
          {!confirmX
            ? <div className="row" style={{ marginTop: 8 }}><button disabled={!(Number(dollars) > 0) || busy} onClick={() => setConfirmX(true)}>Review transfer</button></div>
            : <div className="confirm"><p><strong>Confirm:</strong> move <strong>{money(Math.round(Number(dollars) * 100))}</strong> from {from} to {to === "brokerage" ? "brokerage (for investing)" : to}?</p><div className="row"><button disabled={busy} onClick={submitTransfer}>Yes, move it</button><button className="ghost" onClick={() => setConfirmX(false)}>Cancel</button></div></div>}
          <h3 className="activity-title">Recent activity</h3>
          {!bank?.recent.length && <p className="small">No bank activity yet.</p>}
          <div className="activity-list">{(bank?.recent || []).slice(0, 6).map((e: any) => <div className="activity-row" key={e.id}><span>{e.kind === "income" ? "💵" : e.kind === "bill_payment" ? "🧾" : e.kind === "savings_interest" ? "✨" : "↔"}</span><div><strong>{describeBankEntry(e)}</strong><small>{e.memo || new Date(e.created_at).toLocaleDateString()}</small></div><b className={e.kind === "transfer" ? "" : bankEntryAmount(e) >= 0 ? "up" : "down"}>{money(bankEntryAmount(e))}</b></div>)}</div>
        </section>
      </div>
      {bank && <SavingsProjection interest={bank.savingsInterest} />}
      {paid.length > 0 && (
        <div className="bank-panel paid-mail">
          <h2>Paid mail</h2>
          <table><tbody>
            {paid.map((b) => (
              <tr key={b.id}><td><strong>{b.title}</strong></td><td className="small">paid {new Date(b.paid_at).toLocaleDateString()}</td><td>{money(b.paid_cents)}</td><td><button className="ghost" onClick={() => openBill(b)}>Receipt</button></td></tr>
            ))}
          </tbody></table>
        </div>
      )}

      {selectedBill && <div className="bank-modal-overlay" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) setSelectedBill(null); }}>
        <div className="bank-modal" role="dialog" aria-modal="true" aria-labelledby="mail-title">
          <div className="letter-toolbar"><span>Received {new Date(selectedBill.issued_at).toLocaleDateString()}</span><button className="ghost" onClick={() => setSelectedBill(null)}>Close</button></div>
          <div className="letter-paper">
            <div className="letter-mark">{selectedBill.sender?.slice(0, 1).toUpperCase() || "$"}</div>
            <div className="letter-from">{selectedBill.sender || "SimLife Billing Center"}</div>
            <h2 id="mail-title">{selectedBill.document_title || selectedBill.title}</h2>
            <p className="letter-body">{selectedBill.document_body || `This is your statement for ${selectedBill.title}. Review the amount and due date below. You may pay the full balance or make a partial payment from checking.`}</p>
            <div className="statement-box"><div><span>Original amount</span><strong>{money(selectedBill.amount_cents)}</strong></div><div><span>Already paid</span><strong>{money(selectedBill.paid_cents)}</strong></div><div><span>Due date</span><strong>{new Date(selectedBill.due_at).toLocaleDateString()}</strong></div><div className="statement-due"><span>Balance due</span><strong>{money(selectedBill.remaining_cents)}</strong></div></div>
            {selectedBill.status === "late" && selectedBill.late_fee_cents > 0 && <p className="late-note">This balance includes a {money(selectedBill.late_fee_cents)} late fee.</p>}
            {(selectedBill.disputes || []).length > 0 && <div className="question-thread">
              <h3>Questions about this bill</h3>
              {selectedBill.disputes.map((d: any) => (
                <div className="question-item" key={d.id}>
                  <p className="question-q"><strong>You asked · {new Date(d.created_at).toLocaleDateString()}:</strong> {d.reason}</p>
                  {d.status === "resolved" && d.resolution && <p className="question-a"><strong>Teacher replied{d.resolved_at ? ` · ${new Date(d.resolved_at).toLocaleDateString()}` : ""}:</strong> {d.resolution}</p>}
                  {d.status !== "resolved" && <p className="small">Awaiting teacher review — the due date still applies.</p>}
                </div>
              ))}
            </div>}
          </div>
          {!selectedBill.paid_at && <div className="letter-actions">
            {err && <div className="error" role="alert">{err}</div>}
            {!showPayment && !showDispute && <><button onClick={() => { setShowPayment(true); setPayDollars((selectedBill.remaining_cents / 100).toFixed(2)); }}>Pay this bill</button><button className="ghost" onClick={() => setShowDispute(true)}>Question or dispute</button></>}
            {showPayment && <div className="modal-action-box"><h3>How much do you want to pay?</h3><p>The payment comes from checking. Any unpaid amount stays in your mailbox.</p><div className="row"><div className="field grow"><label htmlFor="bill-payment">Payment amount</label><input id="bill-payment" value={payDollars} onChange={(e) => setPayDollars(e.target.value)} inputMode="decimal" autoFocus /></div><button disabled={busy || !(Number(payDollars) > 0) || Math.round(Number(payDollars) * 100) > selectedBill.remaining_cents} onClick={() => pay(selectedBill)}>{busy ? "Paying…" : "Send payment"}</button></div><button className="text-danger" onClick={() => setShowPayment(false)}>Cancel</button></div>}
            {showDispute && <div className="modal-action-box"><h3>Ask about this bill</h3><p>Explain what looks wrong. Sending a question does not pause the due date or remove the balance.</p><div className="field"><label htmlFor="bill-dispute">Your message</label><textarea id="bill-dispute" rows={4} value={disputeReason} onChange={(e) => setDisputeReason(e.target.value)} placeholder="The service dates or amount do not match…" autoFocus /></div><div className="row"><button disabled={busy || disputeReason.trim().length < 5} onClick={() => dispute(selectedBill)}>Send to teacher</button><button className="ghost" onClick={() => setShowDispute(false)}>Cancel</button></div></div>}
          </div>}
        </div>
      </div>}
    </div>
  );
}

function describeEntry(e: any): string {
  if (e.kind === "buy") return `Bought ${e.ticker}`;
  if (e.kind === "sell") return `Sold ${e.ticker}`;
  if (e.kind === "cash_adjust") return e.amount_cents >= 0 ? "Cash added by teacher" : "Cash removed by teacher";
  if (e.kind === "cash_reversal") return "Cash adjustment reversed";
  return e.kind;
}
function entryDetail(e: any): string {
  const parts: string[] = [];
  if (e.qty_micro) parts.push(`${(Math.abs(e.qty_micro) / 1_000_000).toFixed(4)} sh @ ${money(e.price_cents)}`);
  if (e.reason) parts.push(`Reason: ${e.reason}`);
  if (e.quote_source) parts.push(`quote: ${e.quote_source}`);
  return parts.join(" · ");
}

// ---------------- teacher ----------------

function Teacher({ me, refresh }: { me: Me; refresh: () => void }) {
  void refresh;
  const [classes, setClasses] = useState<any[]>([]);
  const [classId, setClassId] = useState("");
  const [roster, setRoster] = useState<any[]>([]);
  const [audit, setAudit] = useState<any[]>([]);
  const [err, setErr] = useState("");
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<any>(null);
  const [dollars, setDollars] = useState("");
  const [direction, setDirection] = useState<"add" | "remove">("add");
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reverseReason, setReverseReason] = useState("");
  const [reverseId, setReverseId] = useState("");
  const [profileId, setProfileId] = useState<string | null>(null);
  const [profile, setProfile] = useState<any>(null);
  const [reference, setReference] = useState<any[]>([]);
  const [sortKey, setSortKey] = useState<string>("name");
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const [updating, setUpdating] = useState(false);
  const [query, setQuery] = useState("");
  const [freezeConfirm, setFreezeConfirm] = useState<any>(null);
  const [auditOpen, setAuditOpen] = useState(false);
  const [tsection, setTsection] = useState<"brokerage" | "banking">("banking");
  const cashKey = useRef(uid());
  void me;

  useEffect(() => {
    if (!profileId) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setProfileId(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [profileId]);

  const load = useCallback(async () => {
    setUpdating(true);
    try {
      const cid = classId || "";
      const qs = cid ? `?classId=${cid}` : "";
      const [c, r, a, ref] = await Promise.all([
        api<{ classes: any[] }>("/api/teacher/classes"),
        api<{ students: any[] }>(`/api/teacher/roster${qs}`),
        api<{ entries: any[] }>(`/api/teacher/audit${qs}`),
        cid ? api<{ students: any[] }>(`/api/teacher/reference?classId=${cid}`).catch(() => ({ students: [] })) : Promise.resolve({ students: [] }),
      ]);
      setClasses(c.classes); setRoster(r.students); setAudit(a.entries); setReference(ref.students);
    } catch (e: any) { setErr(e.message); }
    finally { setUpdating(false); }
  }, [classId]);
  useEffect(() => { load(); }, [load]);

  const openProfile = async (id: string) => {
    setProfileId(id); setProfile(null);
    setSelected(roster.find((s) => s.id === id) ?? null);
    setConfirming(false); setDollars(""); setReason(""); setDirection("add");
    try { setProfile(await api(`/api/teacher/student?studentId=${id}`)); }
    catch (e: any) { setErr(e.message); }
  };

  const filtered = roster.filter((s) => `${s.name} ${s.email || ""}`.toLowerCase().includes(query.trim().toLowerCase()));
  const sorted = [...filtered].sort((a, b) => {
    const val = (s: any) => sortKey === "trades" ? Number(s.trades || 0)
      : sortKey === "last" ? (s.last_active_at || "")
      : sortKey === "class" ? (s.class_name || "")
      : sortKey === "invested" ? s.investedCents : sortKey === "portfolio" ? s.portfolioCents
      : sortKey === "gain" ? s.gainLossCents : sortKey === "cash" ? s.cash_cents
      : (s.name || "");
    const av = val(a), bv = val(b);
    return (typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv))) * sortDir;
  });
  const th = (label: string, key: string) => (
    <th className="sortable" onClick={() => {
      if (sortKey === key) setSortDir(sortDir === 1 ? -1 : 1);
      else { setSortKey(key); setSortDir(1); }
    }}>{label}{sortKey === key ? (sortDir === 1 ? " ▲" : " ▼") : ""}</th>
  );
  const refById = Object.fromEntries(reference.map((r) => [r.id, r]));

  const submitCash = async () => {
    if (!selected || busy) return;
    setBusy(true); setErr(""); setNotice("");
    try {
      const amt = Number(dollars);
      const signed = direction === "add" ? Math.abs(amt) : -Math.abs(amt);
      const r = await api<any>("/api/teacher/cash", {
        method: "POST",
        body: JSON.stringify({ studentId: selected.id, dollars: signed, reason, idempotencyKey: cashKey.current }),
      });
      setNotice(r.deduped ? "Already processed — duplicate ignored." : `Done. ${selected.name}'s simulated cash updated.`);
      cashKey.current = uid(); setConfirming(false); setDollars(""); setReason("");
      await load();
      if (profileId === selected.id) {
        const updated = await api<any>(`/api/teacher/student?studentId=${selected.id}`);
        setProfile(updated);
        setSelected((current: any) => current ? { ...current, cash_cents: updated.portfolio.cashCents } : current);
      }
    } catch (e: any) {
      if (e instanceof ApiError) setErr(e.message); else setErr(String(e.message || e));
    } finally { setBusy(false); }
  };

  const submitReverse = async () => {
    if (!reverseId || busy) return;
    setBusy(true); setErr(""); setNotice("");
    try {
      await api("/api/teacher/cash/reverse", {
        method: "POST",
        body: JSON.stringify({ entryId: reverseId, reason: reverseReason, idempotencyKey: uid() }),
      });
      setNotice("Reversal recorded. The original entry is kept for the audit trail.");
      setReverseId(""); setReverseReason("");
      load();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  const toggleFreeze = async (target: any) => {
    if (!target || busy) return;
    const frozen = !(target.trading_frozen === 1);
    setBusy(true); setErr("");
    try {
      await api("/api/teacher/freeze", { method: "POST", body: JSON.stringify({ classId: target.id, frozen }) });
      setClasses((prev) => prev.map((c) => c.id === target.id ? { ...c, trading_frozen: frozen ? 1 : 0 } : c));
      setNotice(`${target.name}: trading is now ${frozen ? "closed" : "open"}.`);
      setFreezeConfirm(null);
      await load();
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const cls = classes.find((c) => c.id === classId);

  const workspaceTabs = (
    <div className="pills section-tabs" role="tablist" aria-label="Workspace sections">
      <button role="tab" aria-selected={tsection === "brokerage"} className={`pill${tsection === "brokerage" ? " active" : ""}`} onClick={() => setTsection("brokerage")}>Brokerage</button>
      <button role="tab" aria-selected={tsection === "banking"} className={`pill${tsection === "banking" ? " active" : ""}`} onClick={() => setTsection("banking")}>Banking</button>
    </div>
  );

  if (tsection === "banking") {
    return (
      <>
        {workspaceTabs}
        {err && <div className="error" role="alert">{err}</div>}
        {notice && <div className="notice" role="status" aria-live="polite">{notice}</div>}
        <div className="banking-experience teacher-banking-experience"><TeacherBanking classId={classId} classes={classes} onClassChange={setClassId} onChanged={load} /></div>
      </>
    );
  }

  return (
    <>
      {workspaceTabs}
      <div className="page-intro">
        <div><div className="eyebrow">Teacher desk</div><h2>Brokerage classroom</h2><p>Fund accounts, monitor participation, and control when students may trade.</p></div>
        <div className="teacher-summary"><strong>{roster.length}</strong><span>students shown</span></div>
      </div>
      <div className="pills">
        <button className={`pill${classId === "" ? " active" : ""}`} onClick={() => setClassId("")}>All students</button>
        {classes.map((c) => (
          <button key={c.id} className={`pill${classId === c.id ? " active" : ""}`} onClick={() => setClassId(c.id)}>
            {c.name}{c.trading_frozen ? " — frozen" : ""}
          </button>
        ))}
        {updating && <span className="small" style={{ alignSelf: "center" }}>Updating…</span>}
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        {cls && <button className={cls.trading_frozen ? "" : "danger"} onClick={() => setFreezeConfirm(cls)}>{cls.trading_frozen ? "Reopen trading" : "Close trading"}</button>}
        <span className="small">Join code{classId ? "" : "s"}: {classId ? cls?.join_code : classes.map((c) => `${c.name.split(" ")[0]} ${c.join_code}`).join(" · ")}</span>
      </div>
      {freezeConfirm && <div className="confirm" role="dialog" aria-modal="true" aria-labelledby="freeze-title"><h3 id="freeze-title">{freezeConfirm.trading_frozen ? "Reopen" : "Close"} trading?</h3><p>{freezeConfirm.name} students {freezeConfirm.trading_frozen ? "will be able to buy and sell again" : "will immediately be blocked from buying and selling"}.</p><div className="row"><button className={freezeConfirm.trading_frozen ? "" : "danger-solid"} disabled={busy} onClick={() => toggleFreeze(freezeConfirm)}>Yes, {freezeConfirm.trading_frozen ? "reopen" : "close"} trading</button><button className="ghost" onClick={() => setFreezeConfirm(null)}>Cancel</button></div></div>}
      {err && <div className="error" role="alert">{err}</div>}
      {notice && <div className="notice" role="status" aria-live="polite">{notice}</div>}

      <div className="panel">
        <h2>Roster — simulated brokerage accounts</h2>
        <p className="hint">Click a student to open their account profile, review activity, and adjust simulated cash.</p>
        <div className="roster-tools"><div className="field"><label htmlFor="roster-search">Find a student</label><input id="roster-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name or email" /></div><span className="small">{filtered.length} result{filtered.length === 1 ? "" : "s"}</span></div>
        <div className="table-wrap"><table>
          <thead><tr>{th("Student", "name")}{th("Class", "class")}{th("Cash", "cash")}{th("Invested", "invested")}{th("Portfolio", "portfolio")}{th("Total return", "gain")}{th("Trades", "trades")}{th("Last active", "last")}</tr></thead>
          <tbody>
            {sorted.map((s) => {
              const ref = refById[s.id];
              const funded = ref && (ref.checking != null || ref.savings != null);
              return (
                <tr key={s.id} className={selected?.id === s.id ? "selected-row" : "clickable-row"} onClick={() => openProfile(s.id)}>
                  <td><button className="name-button" onClick={(e) => { e.stopPropagation(); openProfile(s.id); }}>{s.name}</button><br /><span className="small">{s.email || "no email yet"}{funded && Number(s.cash_cents) === 0 ? " · awaiting funding" : ""}</span></td>
                  <td className="small">{s.class_name || "—"}</td>
                  <td>{money(s.cash_cents)}</td>
                  <td>{money(s.investedCents)}</td>
                  <td>{money(s.portfolioCents)}</td>
                  <td className={s.gainLossCents >= 0 ? "up" : "down"}>{money(s.gainLossCents)}</td>
                  <td>{s.trades}</td>
                  <td className="small">{fmtWhen(s.last_active_at)}</td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
      </div>

      <div className="panel">
        <div className="panel-heading"><div><h2>Audit history</h2><p className="hint">Complete record for {classId ? "this class" : "all students"}. Open this only when you need to investigate or reverse an entry.</p></div><button className="ghost" onClick={() => setAuditOpen((v) => !v)}>{auditOpen ? "Hide audit" : `Open audit (${audit.length})`}</button></div>
        {auditOpen && <><div className="reversal-box"><h3>Reverse an incorrect cash adjustment</h3><p className="hint">This creates a compensating entry; it never deletes the original.</p><div className="row"><div className="field"><label>Entry id</label><input value={reverseId} onChange={(e) => setReverseId(e.target.value)} placeholder="le_…" /></div><div className="field grow"><label>Reason (required)</label><input value={reverseReason} onChange={(e) => setReverseReason(e.target.value)} placeholder="e.g. Entered for the wrong student." /></div><button disabled={!reverseId || reverseReason.trim().length < 3 || busy} onClick={submitReverse}>Record reversal</button></div></div><div className="table-wrap"><table>
          <thead><tr><th>When</th><th>Student</th><th>What</th><th>Detail</th><th>Cash effect</th></tr></thead>
          <tbody>
            {audit.map((e) => (
              <tr key={e.id}>
                <td className="small">{new Date(e.created_at).toLocaleString()}</td>
                <td>{e.student_name}</td>
                <td>{describeEntry(e)}<br /><span className="small">{e.id}</span></td>
                <td className="small">{entryDetail(e)}{e.actor_name ? ` · by ${e.actor_name}` : ""}{e.reverses_id ? ` · reverses ${e.reverses_id}` : ""}</td>
                <td className={e.amount_cents >= 0 ? "up" : "down"}>{money(e.amount_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table></div></>}
      </div>

      {profileId && (
        <div className="drawer-overlay" onClick={() => setProfileId(null)}>
          <div className="drawer" role="dialog" aria-modal="true" aria-label="Student account profile" onClick={(e) => e.stopPropagation()}>
            {!profile ? <p>Loading profile…</p> : (
              <>
                <div className="row" style={{ justifyContent: "space-between", alignItems: "start" }}>
                  <h2>{profile.student.name}</h2>
                  <button className="ghost" onClick={() => setProfileId(null)}>Close</button>
                </div>
                <p className="small">
                  {profile.student.email || "no email yet"} · {roster.find((s) => s.id === profileId)?.class_name || "no class"}<br />
                  joined {fmtWhen(profile.student.created_at)} · last active {fmtWhen(profile.student.last_active_at)}
                </p>
                {(() => {
                  const ref = refById[profileId];
                  if (!ref) return null;
                  return (
                    <div className="panel">
                      <h2>ClassBank reference (simulated source)</h2>
                      <p className="hint">{ref.job || "No job recorded"}{ref.note ? ` · ${ref.note}` : ""}</p>
                      <div className="stat-grid">
                        <div className="stat"><div className="label">Checking</div><div className="value">{ref.checking == null ? "—" : money(ref.checking * 100)}</div></div>
                        <div className="stat"><div className="label">Savings</div><div className="value">{ref.savings == null ? "—" : money(ref.savings * 100)}</div></div>
                      </div>
                    </div>
                  );
                })()}
                <div className="stat-grid">
                  <div className="stat"><div className="label">Cash</div><div className="value">{money(profile.portfolio.cashCents)}</div></div>
                  <div className="stat"><div className="label">Portfolio</div><div className="value">{money(profile.portfolio.portfolioCents)}</div></div>
                  <div className="stat"><div className="label">Cash added</div><div className="value">{money(profile.totals?.added ?? 0)}</div></div>
                  <div className="stat"><div className="label">Cash removed</div><div className="value">{money(profile.totals?.removed ?? 0)}</div></div>
                </div>
                {selected && <div className="panel cash-panel">
                  <h2>Adjust simulated cash</h2>
                  <p className="hint">Current cash: {money(profile.portfolio.cashCents)}. Removing cash never sells shares; if cash is short, the student must sell first.</p>
                  <div className="row">
                    <div className="field"><label>Add or remove</label><select value={direction} onChange={(e) => { setDirection(e.target.value as any); setConfirming(false); }}><option value="add">Add cash</option><option value="remove">Remove cash</option></select></div>
                    <div className="field"><label>Dollars</label><input value={dollars} onChange={(e) => { setDollars(e.target.value); setConfirming(false); }} placeholder="50.00" inputMode="decimal" /></div>
                  </div>
                  <div className="field" style={{ marginTop: 9 }}><label>Reason (required — student can see this)</label><textarea value={reason} onChange={(e) => { setReason(e.target.value); setConfirming(false); }} rows={2} placeholder="e.g. Transferred from ClassBank per student's signed slip." /></div>
                  {!confirming
                    ? <div className="row" style={{ marginTop: 9 }}><button disabled={!(Number(dollars) > 0) || reason.trim().length < 3} onClick={() => setConfirming(true)}>Review {direction === "add" ? "deposit" : "withdrawal"}</button></div>
                    : <div className="confirm"><p><strong>Confirm:</strong> {direction === "add" ? "add" : "remove"} <strong>{money(Math.round(Number(dollars) * 100))}</strong> {direction === "add" ? "to" : "from"} <strong>{selected.name}</strong>?</p><p className="small">Reason: {reason}</p><div className="row"><button disabled={busy} onClick={submitCash}>Yes, record it</button><button className="ghost" onClick={() => setConfirming(false)}>Cancel</button></div></div>}
                </div>}
                {profile.bank && <div className="panel">
                  <h2>Banking</h2>
                  <p className="hint">Checking {money(profile.bank.checkingCents)} · savings {money(profile.bank.savingsCents)} · {((profile.bank.savingsInterest?.apy || 0) * 100).toFixed(2)}% APY{profile.bankInvariant && !profile.bankInvariant.ok ? " · INVARIANT BROKEN" : ""}</p>
                  {(profile.bank.bills || []).length > 0 && (
                    <table><thead><tr><th>Bill</th><th>Status</th><th>Paid</th><th>Remaining</th></tr></thead><tbody>
                      {profile.bank.bills.map((b: any) => (
                        <tr key={b.id}><td><strong>{b.title}</strong><br /><span className="small">due {new Date(b.due_at).toLocaleDateString()}{b.disputes?.some((d: any) => d.status === "open") ? " · QUESTION OPEN" : ""}</span></td><td><span className={billBadge(b.status)}>{b.status}</span></td><td>{money(b.paid_cents)}</td><td>{money(b.remaining_cents)}</td></tr>
                      ))}
                    </tbody></table>
                  )}
                  {(profile.bank.recent || []).length > 0 && (
                    <table style={{ marginTop: 8 }}><thead><tr><th>When</th><th>Bank activity</th><th>Net</th></tr></thead><tbody>
                      {profile.bank.recent.slice(0, 10).map((e: any) => (
                        <tr key={e.id}><td className="small">{new Date(e.created_at).toLocaleString()}</td><td>{describeBankEntry(e)}<br /><span className="small">{e.memo || ""}</span></td><td>{money(bankEntryAmount(e))}</td></tr>
                      ))}
                    </tbody></table>
                  )}
                </div>}
                <div className="panel">
                  <h2>Activity</h2>
                  <p className="hint">
                    {(profile.counts || []).map((c: any) => `${c.n}× ${c.kind}`).join(" · ") || "No ledger entries yet."}
                    {profile.portfolio.holdings.length > 0 && ` · holds ${profile.portfolio.holdings.map((h: any) => `${h.shares.toFixed(2)} ${h.ticker}`).join(", ")}`}
                  </p>
                </div>
                <div className="panel">
                  <h2>History</h2>
                  <table>
                    <thead><tr><th>When</th><th>What</th><th>Cash effect</th></tr></thead>
                    <tbody>
                      {profile.history.map((e: any) => (
                        <tr key={e.id}>
                          <td className="small">{new Date(e.created_at).toLocaleString()}</td>
                          <td>{describeEntry(e)}<br /><span className="small">{entryDetail(e)}</span></td>
                          <td className={e.amount_cents >= 0 ? "up" : "down"}>{money(e.amount_cents)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function TeacherBanking({ classId, classes, onClassChange, onChanged }: {
  classId: string; classes: any[]; onClassChange: (id: string) => void; onChanged: () => void;
}) {
  const [summary, setSummary] = useState<any[]>([]);
  const [templates, setTemplates] = useState<any[]>([]);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [err, setErr] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  // Paycheck form
  const [payLabel, setPayLabel] = useState("Weekly paycheck");
  const [payDollars, setPayDollars] = useState("");
  const [payPreview, setPayPreview] = useState<any>(null);
  const payBatch = useRef("");
  // Bill form
  const [billTemplate, setBillTemplate] = useState("");
  const [billTitle, setBillTitle] = useState("");
  const [billDollars, setBillDollars] = useState("");
  const [billFee, setBillFee] = useState("");
  const [billDue, setBillDue] = useState("");
  const [billSender, setBillSender] = useState("");
  const [billDocumentTitle, setBillDocumentTitle] = useState("");
  const [billDocumentBody, setBillDocumentBody] = useState("");
  const [billPreview, setBillPreview] = useState<any>(null);
  const billBatch = useRef("");
  // Template form
  const [tplTitle, setTplTitle] = useState("");
  const [tplDollars, setTplDollars] = useState("");
  const [tplFee, setTplFee] = useState("");
  const [tplDesc, setTplDesc] = useState("");
  const [tplSender, setTplSender] = useState("");
  // Dispute inbox
  const [disputes, setDisputes] = useState<any[]>([]);
  const [replyingId, setReplyingId] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");
  const resolveKeys = useRef<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const qs = classId ? `?classId=${classId}` : "";
      const [s, t, d] = await Promise.all([
        api<{ students: any[] }>(`/api/teacher/bank${qs}`),
        api<{ templates: any[] }>("/api/teacher/bills/templates"),
        api<{ disputes: any[] }>(`/api/teacher/disputes${qs}`),
      ]);
      setSummary(s.students);
      setTemplates(t.templates);
      setDisputes(d.disputes);
      setChecked((prev) => {
        if (prev.size > 0) return prev;
        return new Set(s.students.map((x: any) => x.id));
      });
    } catch (e: any) { setErr(e.message); }
  }, [classId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setChecked(new Set()); setPayPreview(null); setBillPreview(null); }, [classId]);

  const toggle = (id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const ids = [...checked];

  const previewPay = async () => {
    setErr(""); setNotice("");
    try {
      const r = await api<any>("/api/teacher/income/preview", {
        method: "POST",
        body: JSON.stringify({ classId, studentIds: ids, label: payLabel, dollars: Number(payDollars) }),
      });
      payBatch.current = uid();
      setPayPreview(r);
    } catch (e: any) { setErr(e.message); }
  };
  const issuePay = async () => {
    if (!payPreview || busy) return;
    setBusy(true);
    try {
      const r = await api<any>("/api/teacher/income/issue", {
        method: "POST",
        body: JSON.stringify({ classId, studentIds: ids, label: payLabel, dollars: Number(payDollars), batchId: payBatch.current }),
      });
      setNotice(`Posted ${money(r.totalCents)} to ${r.posted} student${r.posted === 1 ? "" : "s"}.`);
      setPayPreview(null); setPayDollars("");
      await load(); onChanged();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  const useTemplate = (id: string) => {
    setBillTemplate(id);
    const t = templates.find((x) => x.id === id);
    if (t) {
      setBillTitle(t.title);
      setBillDollars((t.amount_cents / 100).toFixed(2));
      setBillFee((t.late_fee_cents / 100).toFixed(2));
      setBillSender(t.sender || "");
      setBillDocumentTitle(t.document_title || t.title);
      setBillDocumentBody(t.document_body || t.description || "");
    }
  };

  const previewBill = async () => {
    setErr(""); setNotice("");
    try {
      const r = await api<any>("/api/teacher/bills/preview", {
        method: "POST",
        body: JSON.stringify({
          classId, studentIds: ids, templateId: billTemplate || undefined,
          title: billTitle, dollars: Number(billDollars),
          lateFeeDollars: billFee === "" ? 0 : Number(billFee),
          dueAt: billDue ? `${billDue}T12:00:00Z` : "",
          sender: billSender, documentTitle: billDocumentTitle, documentBody: billDocumentBody,
        }),
      });
      billBatch.current = uid();
      setBillPreview(r);
    } catch (e: any) { setErr(e.message); }
  };
  const issueBill = async () => {
    if (!billPreview || busy) return;
    setBusy(true);
    try {
      const r = await api<any>("/api/teacher/bills/issue", {
        method: "POST",
        body: JSON.stringify({
          classId, studentIds: ids, templateId: billTemplate || undefined,
          title: billTitle, dollars: Number(billDollars),
          lateFeeDollars: billFee === "" ? 0 : Number(billFee),
          dueAt: billDue ? `${billDue}T12:00:00Z` : "", batchId: billBatch.current,
          sender: billSender, documentTitle: billDocumentTitle, documentBody: billDocumentBody,
        }),
      });
      setNotice(`Issued “${billTitle}” to ${r.issued} student${r.issued === 1 ? "" : "s"} (${money(r.totalCents)} total). Students must pay from checking.`);
      setBillPreview(null); setBillTitle(""); setBillDollars(""); setBillFee(""); setBillDue(""); setBillTemplate(""); setBillSender(""); setBillDocumentTitle(""); setBillDocumentBody("");
      await load(); onChanged();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  const saveTemplate = async () => {
    setErr(""); setNotice("");
    try {
      await api("/api/teacher/bills/templates", {
        method: "POST",
        body: JSON.stringify({ title: tplTitle, dollars: Number(tplDollars), lateFeeDollars: tplFee === "" ? 0 : Number(tplFee), description: tplDesc, sender: tplSender, documentTitle: tplTitle, documentBody: tplDesc }),
      });
      setNotice(`Template “${tplTitle}” saved.`);
      setTplTitle(""); setTplDollars(""); setTplFee(""); setTplDesc(""); setTplSender("");
      const t = await api<{ templates: any[] }>("/api/teacher/bills/templates");
      setTemplates(t.templates);
    } catch (e: any) { setErr(e.message); }
  };

  const dueCount = summary.reduce((s, x) => s + Number(x.bills_due || 0), 0);
  const lateCount = summary.reduce((s, x) => s + Number(x.bills_late || 0), 0);
  const openDisputes = disputes.filter((d) => d.status === "open");

  const resolve = async (d: any) => {
    if (busy) return;
    setBusy(true); setErr(""); setNotice("");
    try {
      if (!resolveKeys.current[d.id]) resolveKeys.current[d.id] = uid();
      const r = await api<any>(`/api/teacher/disputes/${d.id}/resolve`, {
        method: "POST",
        body: JSON.stringify({ resolution: replyText, idempotencyKey: resolveKeys.current[d.id] }),
      });
      setNotice(r.deduped ? "That answer was already recorded." : `Answered ${d.student_name}'s question about “${d.bill_title}.” The bill itself is unchanged.`);
      setReplyingId(null); setReplyText("");
      await load(); onChanged();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <>
      <div className="page-intro">
        <div><div className="eyebrow">Teacher desk</div><h2>Banking classroom</h2><p>Issue paychecks and bills, then watch students take responsibility for paying.</p></div>
        <div className="teacher-summary"><strong>{summary.length}</strong><span>students · {dueCount} unpaid · {lateCount} late</span></div>
      </div>
      <div className="pills">
        <button className={`pill${classId === "" ? " active" : ""}`} onClick={() => onClassChange("")}>All students</button>
        {classes.map((c) => (
          <button key={c.id} className={`pill${classId === c.id ? " active" : ""}`} onClick={() => onClassChange(c.id)}>{c.name}</button>
        ))}
      </div>
      {err && <div className="error" role="alert">{err}</div>}
      {notice && <div className="notice" role="status" aria-live="polite">{notice}</div>}
      {!classId && <div className="notice">Choose a class above to issue paychecks or bills. Issuance is always scoped to one class.</div>}

      <div className="panel">
        <h2>Class accounts</h2>
        <p className="hint">Check students to target paychecks and bills. Unchecked students are skipped.</p>
        <div className="table-wrap"><table>
          <thead><tr><th></th><th>Student</th><th>Checking</th><th>Savings</th><th>Brokerage</th><th>Bills due</th><th>Late</th></tr></thead>
          <tbody>
            {summary.map((s) => (
              <tr key={s.id}>
                <td><input type="checkbox" aria-label={`Select ${s.name}`} checked={checked.has(s.id)} onChange={() => toggle(s.id)} /></td>
                <td><strong>{s.name}</strong><br /><span className="small">{s.class_name || "—"}</span></td>
                <td>{money(s.checking_cents)}</td>
                <td>{money(s.savings_cents)}</td>
                <td>{money(s.brokerage_cents)}</td>
                <td>{s.bills_due}</td>
                <td className={Number(s.bills_late) > 0 ? "down" : ""}>{s.bills_late}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
        <p className="small">{checked.size} selected</p>
      </div>

      <div className="panel">
        <div className="panel-heading"><div><h2>Student questions</h2><p className="hint">Bill questions from students{classId ? " in this class" : ""}. Answering never changes the bill — it only records your reply.</p></div><span className="portfolio-count">{openDisputes.length} open</span></div>
        {disputes.length === 0 && <p className="small">No questions yet. When a student questions a bill, it appears here.</p>}
        <div className="mailbox">
          {disputes.map((d) => (
            <div className="bill-card" key={d.id}>
              <div className="bill-top">
                <div><strong>{d.student_name}</strong> <span className="small">· {d.class_name || "no class"} · {d.bill_title} · {money(d.remaining_cents)} remaining · asked {new Date(d.created_at).toLocaleString()}</span></div>
                <span className={d.status === "open" ? "badge-due" : "badge-paid"}>{d.status === "open" ? "Open" : "Answered"}</span>
              </div>
              <p className="question-q"><strong>Student:</strong> {d.reason}</p>
              {d.status === "resolved" && <p className="question-a"><strong>Your answer{d.resolved_at ? ` · ${new Date(d.resolved_at).toLocaleDateString()}` : ""}:</strong> {d.resolution}</p>}
              {d.status === "open" && replyingId !== d.id && (
                <div className="row" style={{ marginTop: 8 }}><button className="ghost" onClick={() => { setReplyingId(d.id); setReplyText(""); }}>Reply and mark answered</button></div>
              )}
              {d.status === "open" && replyingId === d.id && (
                <div style={{ marginTop: 8 }}>
                  <div className="field"><label htmlFor={`reply-${d.id}`}>Your answer (the student sees this in the same letter)</label><textarea id={`reply-${d.id}`} rows={3} value={replyText} onChange={(e) => setReplyText(e.target.value)} placeholder="Explain the charge…" autoFocus /></div>
                  <div className="row" style={{ marginTop: 8 }}><button disabled={busy || replyText.trim().length < 2} onClick={() => resolve(d)}>Send answer</button><button className="ghost" onClick={() => { setReplyingId(null); setReplyText(""); }}>Leave open</button></div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {classId && (
        <div className="grid2">
          <div className="panel">
            <h2>Send paychecks</h2>
            <p className="hint">Deposits land in checking. Preview first — nothing posts until you confirm.</p>
            <div className="field"><label>Label</label><input value={payLabel} onChange={(e) => { setPayLabel(e.target.value); setPayPreview(null); }} placeholder="Weekly paycheck" /></div>
            <div className="field" style={{ marginTop: 8 }}><label>Dollars per student</label><input value={payDollars} onChange={(e) => { setPayDollars(e.target.value); setPayPreview(null); }} placeholder="1500.00" inputMode="decimal" /></div>
            <div className="row" style={{ marginTop: 8 }}>
              <button disabled={!(Number(payDollars) > 0) || checked.size === 0 || busy} onClick={previewPay}>Preview ({checked.size})</button>
            </div>
            {payPreview && (
              <div className="confirm">
                <p><strong>Confirm:</strong> post <strong>{money(payPreview.totalCents)}</strong> total ({money(payPreview.perStudentCents)} × {payPreview.count} students) labeled “{payLabel}”?</p>
                <p className="small">{payPreview.students.slice(0, 5).map((s: any) => s.name).join(", ")}{payPreview.count > 5 ? ` +${payPreview.count - 5} more` : ""}</p>
                <div className="row"><button disabled={busy} onClick={issuePay}>Yes, post paychecks</button><button className="ghost" onClick={() => setPayPreview(null)}>Cancel</button></div>
              </div>
            )}
          </div>

          <div className="panel">
            <h2>Send bills</h2>
            <p className="hint">Bills arrive in each student's mailbox. Students pay from checking — nothing is taken automatically.</p>
            <div className="field"><label>From template (optional)</label>
              <select value={billTemplate} onChange={(e) => useTemplate(e.target.value)}>
                <option value="">Custom bill…</option>
                {templates.map((t) => <option key={t.id} value={t.id}>{t.title} — {money(t.amount_cents)}</option>)}
              </select>
            </div>
            <div className="field" style={{ marginTop: 8 }}><label>Title</label><input value={billTitle} onChange={(e) => { setBillTitle(e.target.value); setBillPreview(null); }} placeholder="Electric bill" /></div>
            <div className="row" style={{ marginTop: 8 }}>
              <div className="field grow"><label>Sender shown in mailbox</label><input value={billSender} onChange={(e) => { setBillSender(e.target.value); setBillPreview(null); }} placeholder="City Utilities" /></div>
              <div className="field grow"><label>Letter heading</label><input value={billDocumentTitle} onChange={(e) => { setBillDocumentTitle(e.target.value); setBillPreview(null); }} placeholder="Your monthly utility statement" /></div>
            </div>
            <div className="field" style={{ marginTop: 8 }}><label>Letter or statement text</label><textarea rows={4} value={billDocumentBody} onChange={(e) => { setBillDocumentBody(e.target.value); setBillPreview(null); }} placeholder="Service period, charges, contract terms, or other correspondence students should review…" /></div>
            <div className="row" style={{ marginTop: 8 }}>
              <div className="field"><label>Dollars</label><input value={billDollars} onChange={(e) => { setBillDollars(e.target.value); setBillPreview(null); }} placeholder="80.00" inputMode="decimal" /></div>
              <div className="field"><label>Late fee ($)</label><input value={billFee} onChange={(e) => { setBillFee(e.target.value); setBillPreview(null); }} placeholder="15.00" inputMode="decimal" /></div>
              <div className="field"><label>Due date</label><input type="date" value={billDue} onChange={(e) => { setBillDue(e.target.value); setBillPreview(null); }} /></div>
            </div>
            <div className="row" style={{ marginTop: 8 }}>
              <button disabled={!(Number(billDollars) > 0) || !billDue || checked.size === 0 || busy} onClick={previewBill}>Preview ({checked.size})</button>
            </div>
            {billPreview && (
              <div className="confirm">
                <p><strong>Confirm:</strong> issue “{billPreview.title}” ({money(billPreview.perStudentCents)} × {billPreview.count} students = {money(billPreview.totalCents)}), due {new Date(billPreview.dueAt).toLocaleDateString()}{billPreview.lateFeeCents > 0 ? `, ${money(billPreview.lateFeeCents)} late fee` : ""}?</p>
                <div className="row"><button disabled={busy} onClick={issueBill}>Yes, issue bills</button><button className="ghost" onClick={() => setBillPreview(null)}>Cancel</button></div>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="panel">
        <h2>Bill templates</h2>
        <p className="hint">Reusable bills (rent, utilities, insurance). Issue them from “Send bills”.</p>
        <div className="row">
          <div className="field grow"><label>Title</label><input value={tplTitle} onChange={(e) => setTplTitle(e.target.value)} placeholder="Monthly rent share" /></div>
          <div className="field grow"><label>Sender</label><input value={tplSender} onChange={(e) => setTplSender(e.target.value)} placeholder="Oakwood Apartments" /></div>
          <div className="field"><label>Dollars</label><input value={tplDollars} onChange={(e) => setTplDollars(e.target.value)} placeholder="600.00" inputMode="decimal" /></div>
          <div className="field"><label>Late fee ($)</label><input value={tplFee} onChange={(e) => setTplFee(e.target.value)} placeholder="25.00" inputMode="decimal" /></div>
        </div>
        <div className="field" style={{ marginTop: 8 }}><label>Reusable letter text (optional)</label><textarea rows={3} value={tplDesc} onChange={(e) => setTplDesc(e.target.value)} placeholder="Describe the charge, billing period, and any information the student should review." /></div>
        <div className="row" style={{ marginTop: 8 }}><button disabled={!(tplTitle.trim().length >= 2) || !(Number(tplDollars) > 0)} onClick={saveTemplate}>Save template</button></div>
        {templates.length > 0 && (
          <table style={{ marginTop: 8 }}><tbody>
            {templates.map((t) => (
              <tr key={t.id}><td><strong>{t.title}</strong></td><td>{money(t.amount_cents)}</td><td className="small">late fee {money(t.late_fee_cents)}</td></tr>
            ))}
          </tbody></table>
        )}
      </div>
    </>
  );
}
