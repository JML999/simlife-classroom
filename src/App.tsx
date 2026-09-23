import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, money, uid, fmtWhen, ApiError } from "./api.js";

declare global { interface Window { google?: any } }

interface Me { user: { id: string; email: string | null; name: string; role: string; job_title?: string | null; job_pay_cents?: number | null; car_payment_cents?: number | null }; class: any }
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
    // StrictMode remounts effects in dev; initializing Google twice logs a
    // warning and the second instance wins, so guard it.
    if (btnRef.current.dataset.gsiInit) return;
    btnRef.current.dataset.gsiInit = "1";
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
  const [quoteName, setQuoteName] = useState("");
  const [buyDollars, setBuyDollars] = useState("");
  const [reviewing, setReviewing] = useState(false);
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
  const [section, setSection] = useState<"dashboard" | "banking" | "investing" | "class" | "leaderboard">("dashboard");
  const [onboarding, setOnboarding] = useState<any>(null);

  const load = useCallback(async () => {
    try {
      setPf(await api<Portfolio>("/api/portfolio"));
      setHistory((await api<{ entries: any[] }>("/api/history")).entries);
    } catch (e: any) { setErr(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const loadOnboarding = useCallback(() => api<any>("/api/onboarding").then(setOnboarding).catch(() => {}), []);
  useEffect(() => { loadOnboarding(); }, [loadOnboarding]);
  useEffect(() => {
    const timer = window.setInterval(refreshSession, 15_000);
    return () => window.clearInterval(timer);
  }, [refreshSession]);

  const lookup = async (sym: string, name = "") => {
    setErr(""); setNotice(""); setReviewing(false);
    try {
      const r = await api<{ quote: any }>(`/api/quotes?symbol=${encodeURIComponent(sym)}`);
      setQuote(r.quote); setQuoteName(name); setSearchResults([]);
    } catch (e: any) { setErr(e.message); setQuote(null); setQuoteName(""); }
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
      const body: any = { ticker: quote.ticker, idempotencyKey: buyKey.current, dollarsCents: Math.round(Number(buyDollars) * 100) };
      const r = await api<any>("/api/trades/buy", { method: "POST", body: JSON.stringify(body) });
      setPf(r.portfolio); setHistory((await api<{ entries: any[] }>("/api/history")).entries);
      setNotice(r.deduped ? "Already processed — duplicate ignored." : `Bought simulated shares for ${money(r.costCents)}.`);
      buyKey.current = uid(); setBuyDollars(""); setReviewing(false);
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
    <div className="student-shell">
      <nav className="student-nav" aria-label="SimLife sections">
        <button aria-current={section === "dashboard" ? "page" : undefined} className={section === "dashboard" ? "active" : ""} onClick={() => setSection("dashboard")}><span>⌂</span>Dashboard</button>
        <button aria-current={section === "banking" ? "page" : undefined} className={section === "banking" ? "active" : ""} onClick={() => setSection("banking")}><span>▣</span>Banking</button>
        <button aria-current={section === "investing" ? "page" : undefined} className={section === "investing" ? "active" : ""} onClick={() => setSection("investing")}><span>↗</span>Investing</button>
        <div className="student-nav-foot">
          <button aria-current={section === "class" ? "page" : undefined} className={section === "class" ? "active" : ""} onClick={() => setSection("class")}><span>◆</span>Class</button>
          <button aria-current={section === "leaderboard" ? "page" : undefined} className={section === "leaderboard" ? "active" : ""} onClick={() => setSection("leaderboard")}><span>▤</span>Leaderboard</button>
        </div>
      </nav>
      <main className="student-content">
      {onboarding && ["match", "matched", "pending", "ambiguous"].includes(onboarding.state) && <OnboardingCard state={onboarding} onDone={async () => { await loadOnboarding(); await refreshSession(); await load(); }} />}
      {section === "dashboard" && <StudentBanking me={me} onChanged={load} onOpenInvesting={() => setSection("investing")} />}
      {section === "banking" && <StudentDashboard me={me} portfolio={pf} onOpen={setSection} onChanged={load} />}
      {section === "class" && <ClassSection onOpenInvesting={() => setSection("investing")} />}
      {section === "leaderboard" && <LeaderboardSection />}
      {section === "investing" && <div className="investing-section">
      <div className="page-intro">
        <div>
          <div className="eyebrow">{me.class?.name || "Personal Finance"}</div>
          <h2>Your investing account</h2>
          <p>Use your available simulated cash to practice building and tracking a portfolio.</p>
          {me.user.job_title && <p className="small">💼 {me.user.job_title}{me.user.job_pay_cents != null ? <> · {money(me.user.job_pay_cents)} per paycheck</> : ""}</p>}
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

      <div className="panel buy-stock-panel">
        <div className="panel-heading"><div><div className="eyebrow">Investing</div><h2>Buy a stock</h2><p className="hint">Search a stock to buy. Dollars only — we calculate the shares for you. Fractional shares allowed. Prices are delayed and for class only.</p></div>{pf && <span className="portfolio-count">{money(pf.cashCents)} available</span>}</div>
        <div className="field buy-search"><label htmlFor="buy-search">Search stocks</label><input id="buy-search" type="search" value={symbol} onChange={(e) => doSearch(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && symbol.trim()) lookup(symbol.trim()); }} placeholder="Try AAPL, KO, or VOO…" autoComplete="off" /></div>
        {searchResults.length > 0 && (
          <div className="buy-results" role="listbox" aria-label="Matching stocks">
            {searchResults.map((s) => (
              <button key={s.ticker} role="option" aria-selected={false} className="buy-result" onClick={() => { setSymbol(s.ticker); lookup(s.ticker, s.name); }}><strong>{s.ticker}</strong><span>{s.name}</span></button>
            ))}
          </div>
        )}
        {!quote && searchResults.length === 0 && (
          <div className="row" style={{ marginTop: 8 }}>
            <button onClick={() => symbol.trim() && lookup(symbol.trim())} disabled={!symbol.trim()}>Look up price</button>
          </div>
        )}
        {quote && (() => {
          const price = Number(quote.priceCents) / 100;
          const dollars = Number(buyDollars);
          const estShares = price > 0 && dollars > 0 ? dollars / price : 0;
          const cash = pf?.cashCents ?? 0;
          const overCash = dollars > 0 && Math.round(dollars * 100) > cash;
          const prev = quote.prevCloseCents != null ? Number(quote.prevCloseCents) : null;
          const chg = prev != null ? Number(quote.priceCents) - prev : null;
          const chgPct = prev ? (chg! / prev) * 100 : null;
          return (
            <div className="buy-quote">
              <div className="buy-quote-head"><div><strong className="ticker">{quote.ticker}</strong>{quoteName && <span className="small"> — {quoteName}</span>}<div className="buy-price">{money(quote.priceCents)}{chg != null && <span className={chg >= 0 ? "up" : "down"}> {chg >= 0 ? "+" : ""}{money(chg)} ({chgPct! >= 0 ? "+" : ""}{chgPct!.toFixed(2)}%) today</span>}</div></div><button className="ghost" onClick={() => { setQuote(null); setQuoteName(""); setBuyDollars(""); setReviewing(false); }}>New search</button></div>
              <p className="small">Delayed · {quote.source} · {new Date(quote.asOf).toLocaleString()}{quote.openCents != null || quote.highCents != null || quote.lowCents != null || prev != null ? <> · {prev != null ? <>Prev close {money(prev)}</> : null}{quote.openCents != null ? <> · Open {money(quote.openCents)}</> : null}{quote.highCents != null ? <> · High {money(quote.highCents)}</> : null}{quote.lowCents != null ? <> · Low {money(quote.lowCents)}</> : null}</> : null}</p>
              <div className="row">
                <div className="field grow"><label htmlFor="buy-dollars">Dollars to invest</label><input id="buy-dollars" value={buyDollars} onChange={(e) => { setBuyDollars(e.target.value); setReviewing(false); }} placeholder="25.00" inputMode="decimal" autoFocus /></div>
                <div className="buy-estimate"><span>≈ {estShares > 0 ? estShares.toFixed(4) : "—"} shares</span><small>{money(pf?.cashCents ?? 0)} buying power</small></div>
              </div>
              {overCash && <p className="small" style={{ color: "#a33" }}>That is more than your {money(cash)} available.</p>}
              {!reviewing
                ? <div className="row" style={{ marginTop: 8 }}><button onClick={() => setReviewing(true)} disabled={busy || frozen || !(dollars > 0) || overCash}>Review order</button></div>
                : <div className="confirm"><p><strong>Confirm:</strong> invest <strong>{money(Math.round(dollars * 100))}</strong> in <strong>{quote.ticker}</strong> (≈ {estShares.toFixed(4)} shares at {money(quote.priceCents)})?</p><div className="row"><button disabled={busy || frozen} onClick={submitBuy}>{busy ? "Buying…" : "Yes, buy (simulated)"}</button><button className="ghost" onClick={() => setReviewing(false)}>Back</button></div></div>}
            </div>
          );
        })()}
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
      </main>
    </div>
  );
}

function OnboardingCard({ state, onDone }: { state: any; onDone: () => void }) {
  const profile = state.profile || state.candidates?.[0];
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const dollars = (c: number | null | undefined) => c == null ? "" : String(Number(c) / 100);
  const [form, setForm] = useState<any>(() => profile ? {
    jobTitle: profile.job_title || "", jobPay: dollars(profile.job_pay_cents), checking: dollars(profile.checking_cents),
    savings: dollars(profile.savings_cents), brokerage: dollars(profile.brokerage_cents), carPayment: dollars(profile.car_payment_cents),
  } : {});
  if (state.state === "ambiguous") return <div className="notice onboarding-card"><strong>We found more than one roster match.</strong><br />Your teacher needs to connect the correct profile before opening balances are added.</div>;
  if (state.state === "pending") return <div className="notice onboarding-card"><strong>Your profile corrections are waiting for teacher review.</strong><br />You can use SimLife now; approved opening balances will appear in your activity history.</div>;
  if (state.state === "matched") return <div className="notice onboarding-card"><strong>Your SimLife profile is matched.</strong><br />No money moved when you confirmed it. Your teacher will post the approved migration data separately.</div>;
  if (!profile) return null;
  const submit = async (proposed?: any) => {
    setBusy(true); setErr("");
    try {
      await api("/api/onboarding/claim", { method: "POST", body: JSON.stringify({ profileId: profile.id, proposed }) });
      onDone();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const toCents = (v: string) => v.trim() === "" ? null : Math.round(Number(v) * 100);
  return <section className="panel onboarding-card">
    <div className="panel-heading"><div><div className="eyebrow">First-time setup</div><h2>Is this your SimLife profile?</h2><p className="hint">Confirming only matches your identity. Your teacher posts approved money separately.</p></div><span className="sim-chip">Preloaded</span></div>
    <div className="onboarding-summary">
      <div><span>Name</span><strong>{profile.full_name}</strong></div><div><span>Job</span><strong>{profile.job_title || "Not set"}</strong></div>
      <div><span>Paycheck</span><strong>{profile.job_pay_cents == null ? "Not set" : money(profile.job_pay_cents)}</strong></div>
      <div><span>Checking</span><strong>{profile.checking_cents == null ? "Not set" : money(profile.checking_cents)}</strong></div>
      <div><span>Savings</span><strong>{profile.savings_cents == null ? "Not set" : money(profile.savings_cents)}</strong></div>
      <div><span>Brokerage</span><strong>{profile.brokerage_cents == null ? "Not set" : money(profile.brokerage_cents)}</strong></div>
      <div><span>Car payment</span><strong>{profile.car_payment_cents == null ? "Not set" : `${money(profile.car_payment_cents)} / month`}</strong></div>
    </div>
    {err && <div className="error">{err}</div>}
    {!editing ? <div className="row"><button disabled={busy} onClick={() => submit()}>Yes, this is me</button><button className="ghost" onClick={() => setEditing(true)}>Request a correction</button></div> : <>
      <div className="onboarding-edit">
        <div className="field"><label>Job</label><input value={form.jobTitle} onChange={(e) => setForm({ ...form, jobTitle: e.target.value })} /></div>
        {[['jobPay','Pay per paycheck'],['checking','Checking'],['savings','Savings'],['brokerage','Brokerage cash'],['carPayment','Monthly car payment']].map(([key,label]) => <div className="field" key={key}><label>{label} ($)</label><input inputMode="decimal" value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} /></div>)}
      </div>
      <div className="row"><button disabled={busy} onClick={() => submit({ fullName: profile.full_name, jobTitle: form.jobTitle, jobPayCents: toCents(form.jobPay), checkingCents: toCents(form.checking), savingsCents: toCents(form.savings), brokerageCents: toCents(form.brokerage), carPaymentCents: toCents(form.carPayment) })}>Send changes to teacher</button><button className="ghost" onClick={() => setEditing(false)}>Cancel</button></div>
    </>}
  </section>;
}

function StudentDashboard({ me, portfolio, onOpen, onChanged }: { me: Me; portfolio: Portfolio | null; onOpen: (section: "dashboard" | "banking" | "investing") => void; onChanged: () => void }) {
  const [bank, setBank] = useState<any>(null);
  const loadBank = useCallback(() => api<any>("/api/bank").then(setBank).catch(() => {}), []);
  useEffect(() => { loadBank(); }, [loadBank, me.user.job_title, me.user.job_pay_cents, me.user.car_payment_cents]);
  const unpaid = (bank?.bills || []).filter((b: any) => b.status !== "paid");
  const bankTotal = Number(bank?.checkingCents || 0) + Number(bank?.savingsCents || 0);
  const total = bankTotal + Number(portfolio?.portfolioCents || 0);
  const checkingActivity = (bank?.recent || []).filter((e: any) => Number(e.checking_leg) !== 0);
  return <div className="dashboard-experience">
    <div className="page-intro"><div><div className="eyebrow">{me.class?.name}</div><h2>Your money at a glance</h2><p>See what is available, what is due, and what you can put to work.</p></div><div className="teacher-summary"><strong>{money(total)}</strong><span>total simulated funds</span></div></div>
    <div className="cards dashboard-cards">
      <button className="card dashboard-card" onClick={() => onOpen("dashboard")}><div className="label">Checking</div><div className="value">{bank ? money(bank.checkingCents) : "…"}</div><div className="sub">{unpaid.length} unpaid bill{unpaid.length === 1 ? "" : "s"} →</div></button>
      <button className="card dashboard-card" onClick={() => onOpen("dashboard")}><div className="label">Savings</div><div className="value">{bank ? money(bank.savingsCents) : "…"}</div><div className="sub">Move and grow money →</div></button>
      <button className="card dashboard-card" onClick={() => onOpen("investing")}><div className="label">Investments</div><div className="value">{portfolio ? money(portfolio.portfolioCents) : "…"}</div><div className="sub">Review your portfolio →</div></button>
      <div className="card"><div className="label">Job and pay</div><div className="value dashboard-job">{me.user.job_title || "Not assigned"}</div><div className="sub">{me.user.job_pay_cents == null ? "Pay not set" : `${money(me.user.job_pay_cents)} per paycheck`}</div></div>
    </div>
    <div className="bank-dashboard-grid">
      <MoveMoneyPanel bank={bank} reloadBank={loadBank} onChanged={onChanged} />
      {bank && <SavingsProjection interest={bank.savingsInterest} savingsCents={bank.savingsCents} />}
    </div>
    <div className="bank-panel activity-panel">
      <div className="bank-panel-title"><div className="transfer-icon">🧾</div><div><span className="bank-kicker">Checking account</span><h2>Transaction overview</h2></div><span className="mail-count">{checkingActivity.length} entr{checkingActivity.length === 1 ? "y" : "ies"}</span></div>
      <p className="bank-hint">Every checking deposit, bill payment, and transfer — the same record your teacher sees.</p>
      {!checkingActivity.length && <p className="small">No checking activity yet.</p>}
      {checkingActivity.length > 0 && <div className="table-wrap"><table>
        <thead><tr><th>When</th><th>What</th><th>Detail</th><th>Checking effect</th></tr></thead>
        <tbody>
          {checkingActivity.map((e: any) => (
            <tr key={e.id}>
              <td className="small">{new Date(e.created_at).toLocaleString()}</td>
              <td>{describeBankEntry(e)}</td>
              <td className="small">{e.memo || new Date(e.created_at).toLocaleDateString()}</td>
              <td className={Number(e.checking_leg) >= 0 ? "up" : "down"}>{money(Number(e.checking_leg))}</td>
            </tr>
          ))}
        </tbody>
      </table></div>}
    </div>
  </div>;
}

function describeBankEntry(e: any): string {
  if (e.kind === "income") return "Paycheck / deposit";
  if (e.kind === "opening_balance") return "Confirmed opening balance";
  if (e.kind === "transfer") return "Transfer";
  if (e.kind === "transfer_to_brokerage") return "Moved to brokerage";
  if (e.kind === "transfer_from_brokerage") return "Moved from brokerage";
  if (e.kind === "bill_payment") return "Bill paid";
  if (e.kind === "savings_interest") return "Savings interest";
  if (e.kind === "bank_adjustment") return "Balance adjusted by teacher";
  return e.kind;
}

function bankEntryAmount(e: any): number {
  if (e.kind === "transfer") return Math.max(Math.abs(e.checking_leg), Math.abs(e.savings_leg));
  return e.checking_leg + e.savings_leg;
}

function billBadge(status: string): string {
  return status === "paid" ? "badge-paid" : status === "late" ? "badge-late" : "badge-due";
}

function MoveMoneyPanel({ bank, reloadBank, onChanged }: { bank: any; reloadBank: () => void | Promise<void>; onChanged: () => void }) {
  const [from, setFrom] = useState("checking");
  const [to, setTo] = useState("savings");
  const [dollars, setDollars] = useState("");
  const [confirmX, setConfirmX] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [notice, setNotice] = useState("");
  const xKey = useRef(uid());

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
          : from === "brokerage"
            ? `Moved ${money(Math.round(Number(dollars) * 100))} from brokerage back to checking.`
            : `Moved ${money(Math.round(Number(dollars) * 100))} from ${from} to ${to}.`);
      xKey.current = uid(); setDollars(""); setConfirmX(false);
      await reloadBank(); onChanged();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  return <section className="bank-panel transfer-panel">
    <div className="bank-panel-title"><div className="transfer-icon">↔</div><div><span className="bank-kicker">Quick action</span><h2>Move money</h2></div></div>
    <p className="bank-hint">Move money between checking and savings, send it to brokerage when it is truly available to invest, or move spare brokerage cash back to checking.</p>
    {err && <div className="error" role="alert">{err}</div>}
    {notice && <div className="notice" role="status" aria-live="polite">{notice}</div>}
    <div className="row">
      <div className="field"><label>From</label>
        <select value={from} onChange={(e) => { const v = e.target.value; setFrom(v); setTo(v === "brokerage" ? "checking" : v === "savings" ? "checking" : "savings"); setConfirmX(false); }}>
          <option value="checking">Checking</option>
          <option value="savings">Savings</option>
          <option value="brokerage">Brokerage (cash only)</option>
        </select>
      </div>
      <div className="field"><label>To</label>
        <select value={to} onChange={(e) => { setTo(e.target.value); setConfirmX(false); }}>
          {from === "checking" && <option value="savings">Savings</option>}
          {from === "savings" && <option value="checking">Checking</option>}
          {from === "checking" && <option value="brokerage">Brokerage (invest)</option>}
          {from === "brokerage" && <option value="checking">Checking</option>}
        </select>
      </div>
      <div className="field"><label>Dollars</label><input value={dollars} onChange={(e) => { setDollars(e.target.value); setConfirmX(false); }} placeholder="50.00" inputMode="decimal" /></div>
    </div>
    {!confirmX
      ? <div className="row" style={{ marginTop: 8 }}><button disabled={!(Number(dollars) > 0) || busy} onClick={() => setConfirmX(true)}>Review transfer</button></div>
      : <div className="confirm"><p><strong>Confirm:</strong> move <strong>{money(Math.round(Number(dollars) * 100))}</strong> from {from} to {to === "brokerage" ? "brokerage (for investing)" : to}?</p><div className="row"><button disabled={busy} onClick={submitTransfer}>Yes, move it</button><button className="ghost" onClick={() => setConfirmX(false)}>Cancel</button></div></div>}
    {bank && <p className="small" style={{ marginTop: 10 }}>Checking {money(bank.checkingCents)} · Savings {money(bank.savingsCents)}</p>}
  </section>;
}

const SAVINGS_HORIZONS = [1, 3, 5, 10, 20, 50];

function SavingsProjection({ interest, savingsCents }: { interest: any; savingsCents?: number | null }) {
  const apy = Number(interest?.apy || 0);
  const serverPoints: any[] = interest?.projection || [];
  const fallback = serverPoints.length > 0 ? Math.max(0, Number(serverPoints[0].balanceCents) - Number(serverPoints[0].interestCents)) : 0;
  const principal = savingsCents ?? fallback ?? 0;
  const [years, setYears] = useState(10);
  const segments = years <= 10 ? years : 25;
  const points = useMemo(() => {
    const pts: { years: number; balanceCents: number }[] = [];
    for (let i = 0; i <= segments; i++) {
      const t = (i / segments) * years;
      pts.push({ years: t, balanceCents: Math.round(principal * Math.pow(1 + apy, t)) });
    }
    return pts;
  }, [principal, apy, years, segments]);
  const end = points.length ? points[points.length - 1].balanceCents : principal;
  const earned = Math.max(0, end - principal);
  const max = Math.max(1, end, principal);
  const x = (t: number) => 8 + (years > 0 ? (t / years) * 284 : 0);
  const y = (b: number) => 112 - (b / max) * 94;
  const svgPoints = points.map((p) => `${x(p.years)},${y(p.balanceCents)}`).join(" ");
  const fmtYears = (t: number) => Number.isInteger(t) ? `${t}` : t.toFixed(1);
  return <div className="savings-growth savings-compact">
    <div className="growth-heading">
      <div><span className="bank-kicker">Bank savings</span><h2>Your money earns money</h2></div>
      <div className="apy-bubble"><strong>{(apy * 100).toFixed(2)}%</strong><span>APY</span></div>
    </div>
    <p>Projection assumes your current {money(principal)} stays deposited with no additional contributions or withdrawals.</p>
    <svg className="growth-chart" viewBox="0 0 300 120" role="img" aria-label={`Projected savings balance over ${years} years`}>
      <defs><linearGradient id="growthFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#47c978" stopOpacity=".34" /><stop offset="100%" stopColor="#47c978" stopOpacity=".03" /></linearGradient></defs>
      <path d={`M ${svgPoints.replaceAll(" ", " L ")} L 292 116 L 8 116 Z`} fill="url(#growthFill)" />
      <polyline points={svgPoints} fill="none" stroke="#269c58" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={x(0)} cy={y(principal)} r="4" fill="#fff" stroke="#269c58" strokeWidth="3" />
      <circle cx={x(years)} cy={y(end)} r="4" fill="#fff" stroke="#269c58" strokeWidth="3" />
    </svg>
    <div className="growth-milestones growth-milestones-compact">
      <div><span>Now</span><strong>{money(principal)}</strong><small>current savings</small></div>
      <div><span>{years} year{years === 1 ? "" : "s"}</span><strong>{money(end)}</strong><small>+{money(earned)} interest</small></div>
      <div><span>Rate</span><strong>{(apy * 100).toFixed(2)}%</strong><small>variable classroom rate</small></div>
    </div>
    <div className="horizon-pills" role="group" aria-label="Projection timeframe">
      {SAVINGS_HORIZONS.map((h) => (
        <button key={h} className={h === years ? "horizon-pill active" : "horizon-pill"} aria-pressed={h === years} onClick={() => setYears(h)}>{h}Y</button>
      ))}
    </div>
    <div className="growth-foot"><span>{interest?.label}</span><span>Rate as of {interest?.asOf ? new Date(`${interest.asOf}T12:00:00`).toLocaleDateString() : "—"}</span><span>Zoom out to 50 years to watch compounding.</span></div>
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
          <p className="small">
            {(bank?.job?.title || me.user.job_title)
              ? <>💼 {bank?.job?.title || me.user.job_title}{((bank?.job?.payCents ?? me.user.job_pay_cents) != null) ? <> · {money(bank?.job?.payCents ?? me.user.job_pay_cents ?? 0)} per paycheck</> : " · pay not set yet"}</>
              : "💼 No job assigned yet — see your teacher."}
          </p>
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

        <section className="bank-panel profile-side-panel">
          <div className="bank-panel-title"><div className="transfer-icon">💼</div><div><span className="bank-kicker">Your profile</span><h2>SimLife profile</h2></div></div>
          <div className="dashboard-line"><div><strong>{me.user.job_title || "No job assigned"}</strong><span>{me.user.job_pay_cents == null ? "Ask your teacher about pay" : `${money(me.user.job_pay_cents)} each paycheck`}</span></div><span>💼</span></div>
          <div className="dashboard-line"><div><strong>Car payment</strong><span>Monthly obligation</span></div><b>{me.user.car_payment_cents == null ? "Not set" : money(me.user.car_payment_cents)}</b></div>
          <p className="bank-hint">Job, pay, and car payment are set by your teacher. Move money from the Banking tab.</p>
          <h3 className="activity-title">Recent activity</h3>
          {!bank?.recent.length && <p className="small">No bank activity yet.</p>}
          <div className="activity-list">{(bank?.recent || []).slice(0, 6).map((e: any) => <div className="activity-row" key={e.id}><span>{e.kind === "income" ? "💵" : e.kind === "bill_payment" ? "🧾" : e.kind === "savings_interest" ? "✨" : "↔"}</span><div><strong>{describeBankEntry(e)}</strong><small>{e.memo || new Date(e.created_at).toLocaleDateString()}</small></div><b className={e.kind === "transfer" ? "" : bankEntryAmount(e) >= 0 ? "up" : "down"}>{money(bankEntryAmount(e))}</b></div>)}</div>
        </section>
      </div>
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
  if (e.kind === "cash_adjust") return e.amount_cents >= 0 ? "Brokerage cash added by teacher" : "Brokerage cash removed by teacher";
  if (e.kind === "cash_reversal") return "Brokerage cash adjustment reversed";
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

// Expanded body of a sort module row in the student drawer: best-attempt
// ticker grid (✓ correct · ✕ wrong bucket) plus a plain-text miss list.
function TeacherSortDetail({ mod }: { mod: any }) {
  const d = mod.detail || {};
  if (mod.status === "not_started") return <p className="small">Not started — no draft and no submission yet.</p>;
  if (mod.status === "in_progress") return <p className="small">Draft saved · {d.draftPlaced}/{(d.tokens || []).length} placed · not submitted yet. Drafts are never shown as a submission.</p>;
  const tokens: string[] = d.tokens || [];
  const missList = tokens.filter((t) => {
    const placed = d.bestPlacements?.[t];
    return placed && placed !== d.answerKey[t];
  });
  return (
    <>
      <p className="small">{d.attempts} submission{d.attempts === 1 ? "" : "s"} · best {d.bestCorrect}/{tokens.length} correct · last submitted {d.lastAt ? new Date(d.lastAt).toLocaleString() : "—"}</p>
      <div className="table-wrap"><table className="sort-grid">
        <thead><tr><th>Best attempt</th>{tokens.map((t) => <th key={t} className="tick-col">{t}</th>)}</tr></thead>
        <tbody><tr>
          <td className="small">Placed</td>
          {tokens.map((t) => {
            const placed = d.bestPlacements?.[t];
            const correct = placed && placed === d.answerKey[t];
            return (
              <td
                key={t}
                className={`cell ${!placed ? "cell-none" : correct ? "cell-ok" : "cell-bad"}`}
                title={!placed ? `${t}: not placed` : correct ? `${t}: ${placed} ✓` : `${t}: they put ${placed} — should be ${d.answerKey[t]}`}
              >
                {!placed ? "" : correct ? "✓" : "✕"}
              </td>
            );
          })}
        </tr></tbody>
      </table></div>
      <p className="hint">✓ correct · ✕ wrong category (hover a cell for what they put) · hatched = never placed.</p>
      {missList.length > 0 && (
        <div className="module-misses">
          <div className="label">Missed {missList.length}</div>
          {missList.map((t) => (
            <div key={t} className="small"><strong className="ticker">{t}</strong> → they put <strong>{d.bestPlacements[t]}</strong> · should be <strong>{d.answerKey[t]}</strong></div>
          ))}
        </div>
      )}
    </>
  );
}

// Expanded body of a mission module row: the two live portfolio goals with counts,
// then the submitted write-up (picks + reflection) when there is one.
function TeacherMissionDetail({ mod }: { mod: any }) {
  const d = mod.detail || {};
  if (mod.status === "not_started") return <p className="small">Not started — no qualifying trading yet.</p>;
  const t = d.targets;
  const goals = [
    { done: d.checks?.companies, label: `Hold ${t.minCompanies} companies`, note: `${d.counts.companies} of ${t.minCompanies} held` },
    { done: d.checks?.sectors, label: `Cover ${t.minSectors} sectors`, note: `${d.counts.sectors} of ${t.minSectors} sectors` },
  ];
  const met = goals.filter((g) => g.done).length;
  return (
    <>
      <p className="small">{d.submittedAt ? `Submitted ${new Date(d.submittedAt).toLocaleString()}` : `In progress — ${met} of ${goals.length} goals met, nothing submitted yet`}</p>
      <div className="module-goals">
        {goals.map((g) => (
          <div key={g.label} className={`module-goal${g.done ? " met" : ""}`}>
            <span className="goal-mark" aria-hidden="true">{g.done ? "✓" : "○"}</span>
            <span><strong>{g.label}</strong><span className="small"> — {g.note}</span></span>
          </div>
        ))}
      </div>
      {d.submittedAt && (
        <div className="module-submission">
          {(d.picks || []).map((p: any, i: number) => (
            <div key={p.ticker || i} className="module-pick">
              <strong className="ticker">{p.ticker}</strong>
              <p className="small">{p.thesis}</p>
            </div>
          ))}
          {d.reflection && (
            <div className="module-reflection"><div className="label">Final reflection</div><p className="small">{d.reflection}</p></div>
          )}
        </div>
      )}
    </>
  );
}

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
  const [moduleProgress, setModuleProgress] = useState<{ modules: any[]; students: Record<string, { assigned: number; started: number; completed: number }> }>({ modules: [], students: {} });
  const [tsection, setTsection] = useState<"brokerage" | "banking" | "class">("banking");
  const cashKey = useRef(uid());
  const bankKey = useRef(uid());
  const [bankAccount, setBankAccount] = useState<"checking" | "savings">("checking");
  const [bankDirection, setBankDirection] = useState<"add" | "remove">("add");
  const [bankDollars, setBankDollars] = useState("");
  const [bankReason, setBankReason] = useState("");
  const [editName, setEditName] = useState("");
  const [editClass, setEditClass] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [jobCatalog, setJobCatalog] = useState<any[]>([]);
  const [jobTitle, setJobTitle] = useState("");
  const [jobPay, setJobPay] = useState("");
  const [carPayment, setCarPayment] = useState("");
  const [rent, setRent] = useState("");
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
      const [c, r, a, ref, mp] = await Promise.all([
        api<{ classes: any[] }>("/api/teacher/classes"),
        api<{ students: any[] }>(`/api/teacher/roster${qs}`),
        api<{ entries: any[] }>(`/api/teacher/audit${qs}`),
        cid ? api<{ students: any[] }>(`/api/teacher/reference?classId=${cid}`).catch(() => ({ students: [] })) : Promise.resolve({ students: [] }),
        api<{ modules: any[]; students: Record<string, { assigned: number; started: number; completed: number }> }>(`/api/teacher/module-progress${qs}`),
      ]);
      setClasses(c.classes); setRoster(r.students); setAudit(a.entries); setReference(ref.students); setModuleProgress(mp);
    } catch (e: any) { setErr(e.message); }
    finally { setUpdating(false); }
  }, [classId]);
  useEffect(() => { load(); }, [load]);

  const openProfile = async (id: string) => {
    setProfileId(id); setProfile(null);
    setSelected(roster.find((s) => s.id === id) ?? null);
    setConfirming(false); setDollars(""); setReason(""); setDirection("add");
    setBankDollars(""); setBankReason(""); setDeleteConfirm("");
    setJobCatalog([]); setJobTitle(""); setJobPay(""); setCarPayment(""); setRent("");
    try {
      const next: any = await api(`/api/teacher/student?studentId=${id}`);
      setProfile(next); setEditName(next.student.name); setEditClass(next.student.class_id || "");
      setJobTitle(next.student.job_title || "");
      setJobPay(next.student.job_pay_cents == null ? "" : String(Number(next.student.job_pay_cents) / 100));
      setCarPayment(next.student.car_payment_cents == null ? "" : String(Number(next.student.car_payment_cents) / 100));
      setRent((next.student as any).rent_cents == null ? "" : String(Number((next.student as any).rent_cents) / 100));
      const cid = next.student.class_id || "";
      try {
        const cat: any = await api(`/api/teacher/job-catalog${cid ? `?classId=${cid}` : ""}`);
        setJobCatalog(cat.jobs || []);
      } catch { /* catalog is a convenience; profile still works without it */ }
    }
    catch (e: any) { setErr(e.message); }
  };

  const filtered = roster.filter((s) => `${s.name} ${s.email || ""}`.toLowerCase().includes(query.trim().toLowerCase()));
  const sorted = [...filtered].sort((a, b) => {
    const val = (s: any) => sortKey === "last" ? (s.last_active_at || "")
      : sortKey === "class" ? (s.class_name || "")
      : sortKey === "portfolio" ? (s.portfolioCents ?? 0)
      : sortKey === "invested" ? (s.investedCents ?? 0)
      : sortKey === "return" ? (s.gainLossCents ?? 0)
      : sortKey === "trades" ? (s.trades ?? 0)
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
      setNotice(r.deduped ? "Already processed — duplicate ignored." : `Done. ${selected.name}'s brokerage cash was updated.`);
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

  const refreshOpenProfile = async (id = profileId) => {
    if (!id) return;
    const updated: any = await api(`/api/teacher/student?studentId=${id}`);
    setProfile(updated);
    setSelected((current: any) => current?.id === id ? { ...current, name: updated.student.name, class_id: updated.student.class_id, cash_cents: updated.portfolio.cashCents, job_title: updated.student.job_title, job_pay_cents: updated.student.job_pay_cents } : current);
  };

  const submitBankAdjustment = async () => {
    if (!profileId || busy) return;
    setBusy(true); setErr(""); setNotice("");
    try {
      const signed = (bankDirection === "add" ? 1 : -1) * Math.abs(Number(bankDollars));
      const r = await api<any>("/api/teacher/bank/adjust", { method: "POST", body: JSON.stringify({ studentId: profileId, account: bankAccount, dollars: signed, reason: bankReason, idempotencyKey: bankKey.current }) });
      bankKey.current = uid(); setBankDollars(""); setBankReason("");
      setNotice(r.deduped ? "Already processed — duplicate ignored." : `${profile.student.name}'s ${bankAccount} balance was updated.`);
      await load(); await refreshOpenProfile();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  const saveStudent = async () => {
    if (!profileId || busy) return;
    setBusy(true); setErr("");
    try {
      await api("/api/teacher/student", { method: "PATCH", body: JSON.stringify({ studentId: profileId, name: editName, classId: editClass || null }) });
      setNotice("Student profile updated."); await load(); await refreshOpenProfile();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  const saveJob = async () => {
    if (!profileId || busy) return;
    setBusy(true); setErr(""); setNotice("");
    try {
      const r = await api<any>("/api/teacher/student/job", {
        method: "POST",
        body: JSON.stringify({ studentId: profileId, jobTitle: jobTitle.trim(), jobPayDollars: jobPay.trim() === "" ? null : Number(jobPay), carPaymentDollars: carPayment.trim() === "" ? null : Number(carPayment), rentDollars: rent.trim() === "" ? null : Number(rent) }),
      });
      setNotice(r.student?.job_title ? `Job set to ${r.student.job_title}.` : "Job cleared.");
      setJobTitle(r.student?.job_title || "");
      setJobPay(r.student?.job_pay_cents == null ? "" : String(Number(r.student.job_pay_cents) / 100));
      setCarPayment(r.student?.car_payment_cents == null ? "" : String(Number(r.student.car_payment_cents) / 100));
      setRent((r.student as any)?.rent_cents == null ? "" : String(Number((r.student as any).rent_cents) / 100));
      await load(); await refreshOpenProfile();
      // Refresh catalog so a new custom title appears for classmates too.
      try {
        const cid = profile?.student?.class_id || editClass || "";
        const cat: any = await api(`/api/teacher/job-catalog${cid ? `?classId=${cid}` : ""}`);
        setJobCatalog(cat.jobs || []);
      } catch { /* ignore */ }
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  const submitDelete = async () => {
    if (!profileId || busy) return;
    setBusy(true); setErr("");
    try {
      const name = profile.student.name;
      await api(`/api/teacher/students/${profileId}`, { method: "DELETE", body: JSON.stringify({ confirmation: deleteConfirm }) });
      setProfileId(null); setProfile(null); setSelected(null); setNotice(`${name}'s empty account was deleted.`); await load();
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
      <button role="tab" aria-selected={tsection === "class"} className={`pill${tsection === "class" ? " active" : ""}`} onClick={() => setTsection("class")}>Class</button>
    </div>
  );

  // Shared period filter (CodeWorld pattern): one pill row under the workspace
  // tabs, used by every tab — pick a period once, and roster, banking, module
  // visibility, and activity results below all follow it top to bottom.
  const periodBar = (
    <div className="period-bar">
      <div className="section-kicker">Periods</div>
      <div className="pills">
        <button className={`pill${classId === "" ? " active" : ""}`} onClick={() => setClassId("")}>All students</button>
        {classes.map((c) => (
          <button key={c.id} title={`Join code: ${c.join_code}`} className={`pill${classId === c.id ? " active" : ""}`} onClick={() => setClassId(c.id)}>
            {c.name}<span className="pill-count"> · {c.students ?? 0}</span>{c.trading_frozen ? " — frozen" : ""}
          </button>
        ))}
        {updating && <span className="small" style={{ alignSelf: "center" }}>Updating…</span>}
      </div>
      {classes.length > 0 && (
        <div className="join-codes">
          {classes.map((c) => <span key={c.id}>{c.name} code <strong>{c.join_code}</strong></span>)}
        </div>
      )}
    </div>
  );

  // Shared between the Brokerage and Banking drawer views (same panel,
  // rendered once per tab branch).
  const cashAdjustPanel = profile && selected ? (
    <div className="panel cash-panel">
      <h2>Adjust brokerage cash</h2>
      <p className="hint">Current brokerage cash: {money(profile.portfolio.cashCents)}. This is uninvested money inside the student's brokerage account—not checking or savings. Removing it never sells shares; if brokerage cash is short, the student must sell first.</p>
      <div className="row">
        <div className="field"><label>Brokerage action</label><select value={direction} onChange={(e) => { setDirection(e.target.value as any); setConfirming(false); }}><option value="add">Add brokerage cash</option><option value="remove">Remove brokerage cash</option></select></div>
        <div className="field"><label>Dollars</label><input value={dollars} onChange={(e) => { setDollars(e.target.value); setConfirming(false); }} placeholder="50.00" inputMode="decimal" /></div>
      </div>
      <div className="field" style={{ marginTop: 9 }}><label>Reason (required — student can see this)</label><textarea value={reason} onChange={(e) => { setReason(e.target.value); setConfirming(false); }} rows={2} placeholder="e.g. Transferred from ClassBank per student's signed slip." /></div>
      {!confirming
        ? <div className="row" style={{ marginTop: 9 }}><button disabled={!(Number(dollars) > 0) || reason.trim().length < 3} onClick={() => setConfirming(true)}>Review brokerage {direction === "add" ? "deposit" : "withdrawal"}</button></div>
        : <div className="confirm"><p><strong>Confirm:</strong> {direction === "add" ? "add" : "remove"} <strong>{money(Math.round(Number(dollars) * 100))}</strong> {direction === "add" ? "to" : "from"} <strong>{selected.name}</strong>?</p><p className="small">Reason: {reason}</p><div className="row"><button disabled={busy} onClick={submitCash}>Yes, record it</button><button className="ghost" onClick={() => setConfirming(false)}>Cancel</button></div></div>}
    </div>
  ) : null;

  const profileDrawer = (
    <>
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
                {tsection === "brokerage" && (
                  <div className="panel">
                    <div className="panel-heading"><div><h2>Portfolio</h2><p className="hint">Cash, holdings, and what the account is worth right now.</p></div></div>
                    <div className="stat-grid">
                      <div className="stat"><div className="label">Brokerage cash</div><div className="value">{money(profile.portfolio.cashCents)}</div></div>
                      <div className="stat"><div className="label">Invested</div><div className="value">{money(profile.portfolio.investedCents)}</div></div>
                      <div className="stat"><div className="label">Account value</div><div className="value">{money(profile.portfolio.portfolioCents)}</div></div>
                      <div className="stat"><div className="label">Total return</div><div className={`value ${profile.portfolio.gainLossCents >= 0 ? "up" : "down"}`}>{money(profile.portfolio.gainLossCents)}</div></div>
                    </div>
                    {profile.portfolio.holdings.length === 0 ? (
                      <p className="small">No holdings yet — {money(profile.portfolio.cashCents)} in cash is ready to invest.</p>
                    ) : (
                      <div className="table-wrap"><table>
                        <thead><tr><th>Ticker</th><th>Shares</th><th>Avg cost</th><th>Price</th><th>Value</th><th>Gain/loss</th></tr></thead>
                        <tbody>
                          {profile.portfolio.holdings.map((h: any) => {
                            const pct = h.costBasisCents > 0 ? (h.gainLossCents / h.costBasisCents) * 100 : 0;
                            return (
                              <tr key={h.ticker}>
                                <td><strong className="ticker">{h.ticker}</strong></td>
                                <td>{h.shares.toFixed(4)}</td>
                                <td>{money(h.avgCostCents)}</td>
                                <td>{h.priceCents == null ? "—" : money(h.priceCents)}</td>
                                <td>{money(h.marketCents)}</td>
                                <td className={h.gainLossCents >= 0 ? "up" : "down"}>{money(h.gainLossCents)} <span className="small">({pct >= 0 ? "+" : ""}{pct.toFixed(1)}%)</span></td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table></div>
                    )}
                    <p className="hint">Prices delayed · {profile.portfolio.quoteSource}</p>
                  </div>
                )}
                {tsection === "brokerage" && (
                  <div className="panel">
                    <h2>Investment history</h2>
                    <p className="hint">Every buy, sell, and cash adjustment on this account — newest first.</p>
                    {profile.history.length === 0 ? (
                      <p className="small">No activity yet.</p>
                    ) : (
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
                    )}
                  </div>
                )}
                {tsection === "brokerage" && cashAdjustPanel}
                {tsection === "class" && (() => {
                  const mods = profile.modules || [];
                  const started = mods.filter((m: any) => m.status !== "not_started").length;
                  const done = mods.filter((m: any) => m.status === "submitted").length;
                  return (
                    <div className="panel module-breakdown">
                      <div className="panel-heading"><div><h2>Modules</h2><p className="hint">{started} started · {done} of {mods.length} submitted</p></div></div>
                      {mods.length === 0 && <p className="small">No published modules for this class yet.</p>}
                      {mods.map((mod: any) => (
                        <details className="module-row" key={mod.key}>
                          <summary>
                            <span className="module-row-name">Module {mod.moduleNumber} · {mod.title}</span>
                            <span className="module-row-parts">{mod.partsDone}/{mod.partsTotal} {mod.partsLabel}</span>
                            <span className={mod.status === "submitted" ? "badge-paid" : mod.status === "in_progress" ? "badge-ready" : "badge-due"}>
                              {mod.status === "submitted" ? "Submitted" : mod.status === "in_progress" ? "In progress" : "Not started"}
                            </span>
                          </summary>
                          <div className="module-row-body">
                            {mod.kind === "sort" ? <TeacherSortDetail mod={mod} /> : <TeacherMissionDetail mod={mod} />}
                          </div>
                        </details>
                      ))}
                    </div>
                  );
                })()}
                <div className="panel">
                  <h2>Student details</h2>
                  <div className="row"><div className="field grow"><label>Name</label><input value={editName} onChange={(e) => setEditName(e.target.value)} /></div><div className="field grow"><label>Class</label><select value={editClass} onChange={(e) => setEditClass(e.target.value)}><option value="">No class</option>{classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div><button disabled={busy || editName.trim().length < 2} onClick={saveStudent}>Save details</button></div>
                  <p className="hint">Email is tied to Google sign-in and cannot be edited here.</p>
                </div>
                {tsection === "banking" && (<>
                <div className="panel">
                  <h2>Job</h2>
                  <p className="hint">
                    {profile.student.job_title
                      ? <>Current: <strong>{profile.student.job_title}</strong>{profile.student.job_pay_cents != null ? <> · {money(profile.student.job_pay_cents)} per paycheck</> : " · pay not set"}</>
                      : "No job assigned yet."}
                    {(() => {
                      const ref = refById[profileId];
                      return ref?.job ? <> · ClassBank says: {ref.job}</> : null;
                    })()}
                  </p>
                  <div className="row">
                    <div className="field grow">
                      <label>Job (prepopulated for this period — or type a custom title)</label>
                      <input
                        value={jobTitle}
                        onChange={(e) => setJobTitle(e.target.value)}
                        placeholder="e.g. Electrician"
                        list={`job-catalog-${profileId}`}
                      />
                      <datalist id={`job-catalog-${profileId}`}>
                        {jobCatalog.map((j: any) => (
                          <option key={j.title} value={j.title} />
                        ))}
                      </datalist>
                    </div>
                    <div className="field"><label>Pay per paycheck ($)</label><input value={jobPay} onChange={(e) => setJobPay(e.target.value)} placeholder="e.g. 850.00" inputMode="decimal" /></div>
                  </div>
                  {jobCatalog.length > 0 && (
                    <div className="row" style={{ marginTop: 8, flexWrap: "wrap", gap: 6 }}>
                      {jobCatalog.slice(0, 12).map((j: any) => (
                        <button key={j.title} className="ghost" disabled={busy} onClick={() => setJobTitle(j.title)} title={j.source === "custom" ? "Custom title set earlier" : "From ClassBank snapshot"}>{j.title}</button>
                      ))}
                      {jobCatalog.length > 12 && <span className="small">+{jobCatalog.length - 12} more — type to search</span>}
                    </div>
                  )}
                  <div className="row" style={{ marginTop: 8 }}>
                    <button disabled={busy || (jobTitle.trim().length !== 0 && jobTitle.trim().length < 2)} onClick={saveJob}>Save job</button>
                    {(jobTitle.trim() || jobPay.trim()) && <button className="ghost" disabled={busy} onClick={() => { setJobTitle(""); setJobPay(""); }}>Clear job</button>}
                  </div>
                </div>
                <div className="panel">
                  <h2>Recurring expenses</h2>
                  <p className="hint">
                    Current: {(profile.student as any).rent_cents != null ? <><strong>{money((profile.student as any).rent_cents)}</strong> rent</> : "rent not set"}{" · "}{profile.student.car_payment_cents != null ? <><strong>{money(profile.student.car_payment_cents)}</strong> car</> : "car not set"}. Bill these from Banking → Send bills → assigned amounts.
                  </p>
                  <div className="row">
                    <div className="field"><label>Monthly rent ($)</label><input value={rent} onChange={(e) => setRent(e.target.value)} placeholder="e.g. 800.00" inputMode="decimal" /></div>
                    <div className="field"><label>Monthly car payment ($)</label><input value={carPayment} onChange={(e) => setCarPayment(e.target.value)} placeholder="e.g. 275.00" inputMode="decimal" /></div>
                  </div>
                  <div className="row" style={{ marginTop: 8 }}>
                    <button disabled={busy} onClick={saveJob}>Save expenses</button>
                    {(rent.trim() || carPayment.trim()) && <button className="ghost" disabled={busy} onClick={() => { setRent(""); setCarPayment(""); }}>Clear expenses</button>}
                  </div>
                  <p className="hint">Leave fields blank and Save to clear. Saving never touches the job above.</p>
                </div>
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
                {profile.bank && <div className="panel">
                  <h2>Banking</h2>
                  <p className="hint">Checking {money(profile.bank.checkingCents)} · savings {money(profile.bank.savingsCents)} · {((profile.bank.savingsInterest?.apy || 0) * 100).toFixed(2)}% APY{profile.bankInvariant && !profile.bankInvariant.ok ? " · INVARIANT BROKEN" : ""}</p>
                  <div className="cash-panel">
                    <h3>Adjust bank balance</h3>
                    <div className="row"><div className="field"><label>Account</label><select value={bankAccount} onChange={(e) => setBankAccount(e.target.value as any)}><option value="checking">Checking</option><option value="savings">Savings</option></select></div><div className="field"><label>Change</label><select value={bankDirection} onChange={(e) => setBankDirection(e.target.value as any)}><option value="add">Add money</option><option value="remove">Remove money</option></select></div><div className="field"><label>Dollars</label><input value={bankDollars} onChange={(e) => setBankDollars(e.target.value)} placeholder="50.00" inputMode="decimal" /></div></div>
                    <div className="field" style={{ marginTop: 8 }}><label>Reason (required — student can see this)</label><input value={bankReason} onChange={(e) => setBankReason(e.target.value)} placeholder="Correct starting balance" /></div>
                    <div className="row" style={{ marginTop: 8 }}><button disabled={busy || !(Number(bankDollars) > 0) || bankReason.trim().length < 3} onClick={submitBankAdjustment}>{bankDirection === "add" ? "Add to" : "Remove from"} {bankAccount}</button></div>
                  </div>
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
                </>)}
                <div className="panel danger-zone">
                  <h2>Delete unused account</h2>
                  <p className="hint">Deletion is only available when there are no transactions, bills, payments, disputes, or paychecks. This prevents accidental loss of financial history.</p>
                  <div className="field"><label>Type {profile.student.name} to delete this empty account</label><input value={deleteConfirm} onChange={(e) => setDeleteConfirm(e.target.value)} disabled={!profile.deletion?.canDelete} /></div>
                  <div className="row" style={{ marginTop: 8 }}><button className="danger-solid" disabled={busy || !profile.deletion?.canDelete || deleteConfirm !== profile.student.name} onClick={submitDelete}>Delete empty account</button>{!profile.deletion?.canDelete && <span className="small">Protected: this account has financial history.</span>}</div>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );

  if (tsection === "class") {
    return (
      <>
        {workspaceTabs}
        <TeacherClass classes={classes} classId={classId} periodBar={periodBar} roster={roster} moduleProgress={moduleProgress} onOpenStudent={(id) => void openProfile(id)} onDashboardChanged={load} />
        {profileDrawer}
      </>
    );
  }

  if (tsection === "banking") {
    return (
      <>
        {workspaceTabs}
        {err && <div className="error" role="alert">{err}</div>}
        {notice && <div className="notice" role="status" aria-live="polite">{notice}</div>}
        <div className="banking-experience teacher-banking-experience"><TeacherBanking periodBar={periodBar} classId={classId} classes={classes} onChanged={load} onOpenStudent={(id) => void openProfile(id)} /></div>
        {profileDrawer}
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
      {periodBar}
      {cls && <div className="row" style={{ marginTop: -4, marginBottom: 12 }}>
        <button className={cls.trading_frozen ? "" : "danger"} onClick={() => setFreezeConfirm(cls)}>{cls.trading_frozen ? "Reopen trading" : "Close trading"}</button>
        <span className="small">{cls.name} · {cls.trading_frozen ? "trading closed" : "trading open"}</span>
      </div>}
      {freezeConfirm && <div className="confirm" role="dialog" aria-modal="true" aria-labelledby="freeze-title"><h3 id="freeze-title">{freezeConfirm.trading_frozen ? "Reopen" : "Close"} trading?</h3><p>{freezeConfirm.name} students {freezeConfirm.trading_frozen ? "will be able to buy and sell again" : "will immediately be blocked from buying and selling"}.</p><div className="row"><button className={freezeConfirm.trading_frozen ? "" : "danger-solid"} disabled={busy} onClick={() => toggleFreeze(freezeConfirm)}>Yes, {freezeConfirm.trading_frozen ? "reopen" : "close"} trading</button><button className="ghost" onClick={() => setFreezeConfirm(null)}>Cancel</button></div></div>}
      {err && <div className="error" role="alert">{err}</div>}
      {notice && <div className="notice" role="status" aria-live="polite">{notice}</div>}

      <div className="panel">
        <h2>Roster — portfolios at a glance</h2>
        <p className="hint">See who has invested and how each account is doing. Click a student for holdings and investment history.</p>
        <div className="roster-tools"><div className="field"><label htmlFor="roster-search">Find a student</label><input id="roster-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name or email" /></div><span className="small">{filtered.length} result{filtered.length === 1 ? "" : "s"}</span></div>
        <div className="table-wrap"><table>
          <thead><tr>{th("Student", "name")}{th("Class", "class")}{th("Portfolio", "portfolio")}{th("Invested", "invested")}{th("Return", "return")}{th("Trades", "trades")}{th("Last active", "last")}</tr></thead>
          <tbody>
            {sorted.map((s) => {
              const ref = refById[s.id];
              const jobLabel = s.job_title || ref?.job;
              return (
                <tr key={s.id} className={selected?.id === s.id ? "selected-row" : "clickable-row"} onClick={() => openProfile(s.id)}>
                  <td><strong>{s.name}</strong><br /><span className="small">{jobLabel || s.email || "no email yet"}{jobLabel && s.email ? ` · ${s.email}` : ""}</span></td>
                  <td className="small">{s.class_name || "—"}</td>
                  <td><strong>{money(s.portfolioCents ?? 0)}</strong></td>
                  <td>{money(s.investedCents ?? 0)}</td>
                  <td className={(s.gainLossCents ?? 0) >= 0 ? "up" : "down"}>{money(s.gainLossCents ?? 0)}</td>
                  <td>{s.trades ?? 0}</td>
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

      {profileDrawer}
    </>
  );
}

function TeacherBanking({ periodBar, classId, classes, onChanged, onOpenStudent }: {
  periodBar: React.ReactNode; classId: string; classes: any[]; onChanged: () => void; onOpenStudent: (id: string) => void;
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
  const [payMode, setPayMode] = useState<"assigned" | "flat">("assigned");
  const [payPreview, setPayPreview] = useState<any>(null);
  const payBatch = useRef("");
  // Bill form
  const [billMode, setBillMode] = useState<"assigned_rent" | "assigned_car" | "flat">("assigned_rent");
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
  // Per-student bill drafts (teacher reviews, then explicitly sends).
  const [billDrafts, setBillDrafts] = useState<any[]>([]);
  const [draftStudent, setDraftStudent] = useState("");
  const [draftTitle, setDraftTitle] = useState("Rent");
  const [draftDollars, setDraftDollars] = useState("");
  const [draftDue, setDraftDue] = useState(() => new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10));
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
  // Preloaded roster/onboarding
  const [onboardingProfiles, setOnboardingProfiles] = useState<any[]>([]);
  const [importSource, setImportSource] = useState("ClassBank migration");
  const [importCsv, setImportCsv] = useState("");
  const importKey = useRef(uid());
  const [profileAssignments, setProfileAssignments] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const qs = classId ? `?classId=${classId}` : "";
      const [s, t, d, o, bd] = await Promise.all([
        api<{ students: any[] }>(`/api/teacher/bank${qs}`),
        api<{ templates: any[] }>("/api/teacher/bills/templates"),
        api<{ disputes: any[] }>(`/api/teacher/disputes${qs}`),
        api<{ profiles: any[] }>(`/api/teacher/onboarding${qs}`),
        classId ? api<{ drafts: any[] }>(`/api/teacher/bill-drafts?classId=${encodeURIComponent(classId)}`) : Promise.resolve({ drafts: [] }),
      ]);
      setSummary(s.students);
      setTemplates(t.templates);
      setDisputes(d.disputes);
      setOnboardingProfiles(o.profiles);
      setBillDrafts(bd.drafts);
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
  const allIds = summary.map((s: any) => s.id);
  const allChecked = summary.length > 0 && summary.every((s: any) => checked.has(s.id));
  const toggleAll = () => setChecked(allChecked ? new Set() : new Set(allIds));

  const previewPay = async () => {
    setErr(""); setNotice("");
    try {
      const r = await api<any>("/api/teacher/income/preview", {
        method: "POST",
        body: JSON.stringify({ classId, studentIds: ids, label: payLabel, mode: payMode, dollars: Number(payDollars) }),
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
        body: JSON.stringify({ classId, studentIds: ids, label: payLabel, mode: payMode, dollars: Number(payDollars), batchId: payBatch.current }),
      });
      setNotice(r.posted === 0 ? "That paycheck batch was already posted — no duplicate deposits were made." : `Posted ${money(r.totalCents)} to ${r.posted} student${r.posted === 1 ? "" : "s"}.`);
      setPayPreview(null); setPayDollars("");
      await load(); onChanged();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  const useTemplate = (id: string) => {
    setBillTemplate(id);
    const t = templates.find((x) => x.id === id);
    if (t) {
      setBillMode("flat");
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
          title: billTitle, mode: billMode, dollars: Number(billDollars),
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
          title: billTitle, mode: billMode, dollars: Number(billDollars),
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

  const createDraft = async () => {
    if (!classId || !draftStudent || !(Number(draftDollars) > 0) || !draftDue || busy) return;
    setBusy(true); setErr(""); setNotice("");
    try {
      await api("/api/teacher/bill-drafts", { method: "POST", body: JSON.stringify({
        classId, studentId: draftStudent, title: draftTitle, dollars: Number(draftDollars),
        dueAt: `${draftDue}T12:00:00Z`, sender: "SimLife Housing", documentTitle: `${draftTitle} statement`,
      }) });
      setNotice("Bill draft added. Review it below, then press Send when ready.");
      setDraftStudent(""); setDraftDollars(""); await load();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  const saveDraft = async (draft: any, send: boolean) => {
    if (busy) return;
    setBusy(true); setErr(""); setNotice("");
    try {
      await api(`/api/teacher/bill-drafts/${draft.id}`, { method: "PUT", body: JSON.stringify({
        classId, studentId: draft.user_id, title: draft.title, dollars: Number(draft.dollars),
        lateFeeDollars: Number(draft.lateFeeDollars || 0), dueAt: `${draft.dueDate}T12:00:00Z`,
        sender: draft.sender, documentTitle: draft.documentTitle, documentBody: draft.documentBody,
      }) });
      if (send) {
        const result = await api<any>(`/api/teacher/bill-drafts/${draft.id}/send`, { method: "POST" });
        setNotice(result.deduped ? "That bill was already sent—no duplicate was created." : `Sent “${draft.title}” to the student's mailbox.`);
      } else setNotice("Bill draft saved.");
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
  const pendingProfiles = onboardingProfiles.filter((p) => p.status === "pending");

  const parseCsv = () => {
    const lines = importCsv.trim().split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) throw new Error("Paste a header row and at least one student row.");
    const split = (line: string) => {
      const cells: string[] = []; let cell = ""; let quoted = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"' && quoted && line[i + 1] === '"') { cell += '"'; i++; }
        else if (ch === '"') quoted = !quoted;
        else if (ch === "," && !quoted) { cells.push(cell.trim()); cell = ""; }
        else cell += ch;
      }
      cells.push(cell.trim()); return cells;
    };
    const headers = split(lines[0]).map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, ""));
    const aliases: Record<string, string[]> = {
      fullName: ["name", "fullname", "student", "studentname"], jobTitle: ["job", "jobtitle"], jobPay: ["pay", "jobpay", "paycheck", "payperpaycheck"],
      checking: ["checking", "checkingbalance"], savings: ["savings", "savingsbalance"], brokerage: ["brokerage", "brokeragecash", "investment", "investmentcash"],
      carPayment: ["carpayment", "monthlycarpayment", "car"], rent: ["rent", "monthlyrent", "rentshare"],
      externalRef: ["studentid", "id", "externalref"],
    };
    const at = (cells: string[], key: string) => { const i = headers.findIndex((h) => aliases[key].includes(h)); return i < 0 ? "" : cells[i] || ""; };
    const cents = (v: string) => v.trim() === "" ? null : Math.round(Number(v.replace(/[$,]/g, "")) * 100);
    return lines.slice(1).map(split).map((cells) => ({
      fullName: at(cells, "fullName"), externalRef: at(cells, "externalRef") || null, jobTitle: at(cells, "jobTitle") || null,
      jobPayCents: cents(at(cells, "jobPay")), checkingCents: cents(at(cells, "checking")), savingsCents: cents(at(cells, "savings")),
      brokerageCents: cents(at(cells, "brokerage")), carPaymentCents: cents(at(cells, "carPayment")), rentCents: cents(at(cells, "rent")),
    }));
  };

  const importProfiles = async () => {
    if (!classId || busy) return;
    setBusy(true); setErr(""); setNotice("");
    try {
      const rows = parseCsv();
      const r = await api<any>("/api/teacher/onboarding/import", { method: "POST", body: JSON.stringify({ classId, sourceLabel: importSource, importKey: importKey.current, rows }) });
      setNotice(`${r.deduped ? "Already imported" : "Imported"} ${r.count} preloaded student profile${r.count === 1 ? "" : "s"}.`);
      if (!r.deduped) importKey.current = uid();
      setImportCsv(""); await load();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  const approveProfile = async (id: string) => {
    setBusy(true); setErr("");
    try { await api(`/api/teacher/onboarding/${id}/approve`, { method: "POST" }); setNotice("Profile correction approved and matched. No money was moved."); await load(); onChanged(); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  const assignProfile = async (id: string) => {
    const studentId = profileAssignments[id];
    if (!studentId || busy) return;
    setBusy(true); setErr("");
    try { await api(`/api/teacher/onboarding/${id}/assign`, { method: "POST", body: JSON.stringify({ studentId }) }); setNotice("Profile matched to the signed-in student. No money was moved."); await load(); onChanged(); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  const applyProfile = async (id: string) => {
    if (busy) return;
    setBusy(true); setErr("");
    try { await api(`/api/teacher/onboarding/${id}/apply`, { method: "POST" }); setNotice("Approved job and opening balances posted with audit entries."); await load(); onChanged(); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

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
      {periodBar}
      {err && <div className="error" role="alert">{err}</div>}
      {notice && <div className="notice" role="status" aria-live="polite">{notice}</div>}
      {!classId && <div className="notice">Choose a period above to issue paychecks or bills. Issuance is always scoped to one period.</div>}

      <div className="panel">
        <h2>Class accounts</h2>
        <p className="hint">Check students to target paychecks and bills. Unchecked students are skipped.</p>
        {checked.size > 0 && (
          <div className="row" style={{ marginBottom: 8, background: "#eef0ff", padding: 8, borderRadius: 10 }} role="toolbar" aria-label="Selected student actions">
            <span className="small"><strong>{checked.size} student{checked.size === 1 ? "" : "s"} selected</strong></span>
            <button style={{ background: "#dff2dc", borderColor: "#8fce8f", color: "#2c7a2f", borderRadius: 999, padding: "7px 13px" }} onClick={() => { setPayLabel("Bonus"); setPayMode("flat"); setPayPreview(null); document.getElementById("send-paychecks")?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>Send bonuses</button>
            <button style={{ background: "#fbdcdc", borderColor: "#e88", color: "#b3261e", borderRadius: 999, padding: "7px 13px" }} onClick={() => { setBillMode("flat"); setBillTitle("Fine"); setBillPreview(null); document.getElementById("send-bills")?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>Send fines</button>
            <button style={{ background: "#dfe3ff", borderColor: "#8f9bf0", color: "#353dc6", borderRadius: 999, padding: "7px 13px" }} onClick={() => { setPayLabel("Weekly paycheck"); setPayMode("assigned"); setPayPreview(null); document.getElementById("send-paychecks")?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>Send paychecks</button>
            <button style={{ background: "#fdf0c3", borderColor: "#e3c25a", color: "#8a6d00", borderRadius: 999, padding: "7px 13px" }} onClick={() => { setBillMode("assigned_rent"); setBillTitle("Rent"); setBillPreview(null); document.getElementById("send-bills")?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>Send expenses</button>
            <button className="ghost" onClick={() => setChecked(new Set())}>Clear</button>
          </div>
        )}
        <div className="table-wrap"><table>
          <thead><tr><th><input type="checkbox" aria-label="Check all students" checked={allChecked} onChange={toggleAll} style={{ width: 22, height: 22 }} /></th><th>Student</th><th>Checking</th><th>Savings</th><th>Brokerage</th><th>Bills due</th><th>Late</th></tr></thead>
          <tbody>
            {summary.map((s) => (
              <tr key={s.id} className="clickable-row" onClick={() => onOpenStudent(s.id)}>
                <td onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label={`Select ${s.name}`} checked={checked.has(s.id)} onChange={() => toggle(s.id)} style={{ width: 22, height: 22, cursor: "pointer" }} /></td>
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
        <p className="small">{checked.size} of {summary.length} selected</p>
      </div>

      <div className="panel onboarding-admin">
        <div className="panel-heading"><div><h2>First-login profiles</h2><p className="hint">Match identities first. Matching never moves money; use Post opening data only after you approve the migration amounts.</p></div><span className="portfolio-count">{pendingProfiles.length} need review</span></div>
        {classId ? <>
          <details>
            <summary>Import or paste a class CSV</summary>
            <p className="hint">Headers supported: Name, Job, Pay, Checking, Savings, Brokerage, Car Payment, Rent, Student ID. Blank cells stay blank.</p>
            <div className="field"><label>Source label</label><input value={importSource} onChange={(e) => setImportSource(e.target.value)} /></div>
            <div className="field" style={{ marginTop: 8 }}><label>CSV data</label><textarea rows={7} value={importCsv} onChange={(e) => setImportCsv(e.target.value)} placeholder={'Name,Job,Pay,Checking,Savings,Brokerage,Car Payment\nJordan Lee,Electrician,850,1200,300,500,275'} /></div>
            <div className="row" style={{ marginTop: 8 }}><button disabled={busy || importCsv.trim().split(/\r?\n/).length < 2} onClick={importProfiles}>Import preloaded profiles</button></div>
          </details>
          {onboardingProfiles.length === 0 ? <p className="small">No profiles imported for this class yet.</p> : <div className="table-wrap"><table>
            <thead><tr><th>Student</th><th>Job/pay</th><th>Opening balances</th><th>Car</th><th>Status</th><th /></tr></thead>
            <tbody>{onboardingProfiles.map((p) => { const proposed = p.proposed_json ? JSON.parse(p.proposed_json) : null; return <tr key={p.id}>
              <td><strong>{p.full_name}</strong><br /><span className="small">{p.source_label}</span></td>
              <td>{proposed?.jobTitle ?? p.job_title ?? "—"}<br /><span className="small">{(proposed?.jobPayCents ?? p.job_pay_cents) == null ? "pay blank" : money(proposed?.jobPayCents ?? p.job_pay_cents)}</span></td>
              <td className="small">C {((proposed?.checkingCents ?? p.checking_cents) == null) ? "—" : money(proposed?.checkingCents ?? p.checking_cents)} · S {((proposed?.savingsCents ?? p.savings_cents) == null) ? "—" : money(proposed?.savingsCents ?? p.savings_cents)} · I {((proposed?.brokerageCents ?? p.brokerage_cents) == null) ? "—" : money(proposed?.brokerageCents ?? p.brokerage_cents)}</td>
              <td>{(proposed?.carPaymentCents ?? p.car_payment_cents) == null ? "—" : money(proposed?.carPaymentCents ?? p.car_payment_cents)}</td>
              <td><span className={p.status === "claimed" || p.status === "matched" ? "badge-paid" : p.status === "pending" ? "badge-late" : "badge-due"}>{p.status === "claimed" ? "funded" : p.status}</span></td>
              <td>{p.status === "pending" && <button disabled={busy} onClick={() => approveProfile(p.id)}>Approve match</button>}{p.status === "matched" && <button disabled={busy} onClick={() => applyProfile(p.id)}>Post opening data</button>}{p.status === "unclaimed" && <div className="row"><select aria-label={`Connect ${p.full_name} to signed-in student`} value={profileAssignments[p.id] || ""} onChange={(e) => setProfileAssignments({ ...profileAssignments, [p.id]: e.target.value })}><option value="">Connect…</option>{summary.filter((s) => s.email).map((s) => <option value={s.id} key={s.id}>{s.name} · {s.email}</option>)}</select><button disabled={busy || !profileAssignments[p.id]} onClick={() => assignProfile(p.id)}>Match</button></div>}</td>
            </tr>; })}</tbody>
          </table></div>}
        </> : <p className="hint">Choose a class to import or review first-login profiles.</p>}
      </div>

      {classId && <div className="panel">
        <div className="panel-heading"><div><h2>Assigned bill drafts</h2><p className="hint">Drafts are invisible to students until you press Send. You can edit the student, amount, and due date first.</p></div><span className="portfolio-count">{billDrafts.filter((d) => d.status === "draft").length} ready</span></div>
        <div className="row">
          <div className="field grow"><label>Student</label><select value={draftStudent} onChange={(e) => setDraftStudent(e.target.value)}><option value="">Choose student…</option>{summary.filter((s) => s.email).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
          <div className="field grow"><label>Bill</label><input value={draftTitle} onChange={(e) => setDraftTitle(e.target.value)} placeholder="Rent" /></div>
          <div className="field"><label>Dollars</label><input inputMode="decimal" value={draftDollars} onChange={(e) => setDraftDollars(e.target.value)} placeholder="800.00" /></div>
          <div className="field"><label>Due date</label><input type="date" value={draftDue} onChange={(e) => setDraftDue(e.target.value)} /></div>
          <button disabled={busy || !draftStudent || draftTitle.trim().length < 2 || !(Number(draftDollars) > 0) || !draftDue} onClick={createDraft}>Add draft</button>
        </div>
        {billDrafts.length === 0 ? <p className="small">No assigned bill drafts for this class.</p> : <div className="table-wrap"><table>
          <thead><tr><th>Student</th><th>Bill</th><th>Amount</th><th>Due</th><th>Status</th><th /></tr></thead>
          <tbody>{billDrafts.map((draft) => <BillDraftRow key={`${draft.id}:${draft.updated_at}`} draft={draft} students={summary.filter((s) => s.email)} busy={busy} onSubmit={saveDraft} />)}</tbody>
        </table></div>}
      </div>}

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
          <div className="panel" id="send-paychecks">
            <h2>Send paychecks</h2>
            <p className="hint">Deposits land in checking. Use each student's assigned pay or enter one flat amount.</p>
            <div className="field"><label>Label</label><input value={payLabel} onChange={(e) => { setPayLabel(e.target.value); setPayPreview(null); }} placeholder="Weekly paycheck" /></div>
            <div className="field" style={{ marginTop: 8 }}><label>Pay source</label><select value={payMode} onChange={(e) => { setPayMode(e.target.value as any); setPayPreview(null); }}><option value="assigned">Each student's assigned paycheck</option><option value="flat">One amount for everyone</option></select></div>
            {payMode === "flat" && <div className="field" style={{ marginTop: 8 }}><label>Dollars per student</label><input value={payDollars} onChange={(e) => { setPayDollars(e.target.value); setPayPreview(null); }} placeholder="1500.00" inputMode="decimal" /></div>}
            <div className="row" style={{ marginTop: 8 }}>
              <button disabled={(payMode === "flat" && !(Number(payDollars) > 0)) || checked.size === 0 || busy} onClick={previewPay}>Preview ({checked.size})</button>
            </div>
            {payPreview && (
              <div className="confirm">
                <p><strong>Confirm:</strong> post <strong>{money(payPreview.totalCents)}</strong> total to {payPreview.count} students labeled “{payLabel}”?</p>
                <p className="small">{payPreview.students.slice(0, 6).map((s: any) => `${s.name}: ${money(s.amountCents)}`).join(" · ")}{payPreview.count > 6 ? ` · +${payPreview.count - 6} more` : ""}</p>
                <div className="row"><button disabled={busy} onClick={issuePay}>Yes, post paychecks</button><button className="ghost" onClick={() => setPayPreview(null)}>Cancel</button></div>
              </div>
            )}
          </div>

          <div className="panel" id="send-bills">
            <h2>Send bills</h2>
            <p className="hint">Bills arrive in each student's mailbox. Students pay from checking — nothing is taken automatically. Use each student's assigned rent or car payment, or enter one flat amount.</p>
            <div className="field"><label>Bill source</label><select value={billMode} onChange={(e) => { setBillMode(e.target.value as any); setBillPreview(null); }}><option value="assigned_rent">Each student's assigned rent</option><option value="assigned_car">Each student's assigned car payment</option><option value="flat">One amount for everyone</option></select></div>
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
              {billMode === "flat" && <div className="field"><label>Dollars</label><input value={billDollars} onChange={(e) => { setBillDollars(e.target.value); setBillPreview(null); }} placeholder="80.00" inputMode="decimal" /></div>}
              <div className="field"><label>Late fee ($)</label><input value={billFee} onChange={(e) => { setBillFee(e.target.value); setBillPreview(null); }} placeholder="15.00" inputMode="decimal" /></div>
              <div className="field"><label>Due date</label><input type="date" value={billDue} onChange={(e) => { setBillDue(e.target.value); setBillPreview(null); }} /></div>
            </div>
            <div className="row" style={{ marginTop: 8 }}>
              <button disabled={(billMode === "flat" && !(Number(billDollars) > 0)) || !billDue || checked.size === 0 || busy} onClick={previewBill}>Preview ({checked.size})</button>
            </div>
            {billPreview && (
              <div className="confirm">
                {billPreview.mode && billPreview.mode !== "flat" ? (
                  <><p><strong>Confirm:</strong> issue “{billPreview.title}” at each student's assigned {billPreview.mode === "assigned_rent" ? "rent" : "car payment"} ({money(billPreview.totalCents)} total to {billPreview.count} students), due {new Date(billPreview.dueAt).toLocaleDateString()}{billPreview.lateFeeCents > 0 ? `, ${money(billPreview.lateFeeCents)} late fee` : ""}?</p>
                  <p className="small">{billPreview.students.slice(0, 6).map((s: any) => `${s.name}: ${money(s.amountCents)}`).join(" · ")}{billPreview.count > 6 ? ` · +${billPreview.count - 6} more` : ""}</p></>
                ) : (
                  <p><strong>Confirm:</strong> issue “{billPreview.title}” ({money(billPreview.perStudentCents)} × {billPreview.count} students = {money(billPreview.totalCents)}), due {new Date(billPreview.dueAt).toLocaleDateString()}{billPreview.lateFeeCents > 0 ? `, ${money(billPreview.lateFeeCents)} late fee` : ""}?</p>
                )}
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

// ---------------- class: sector sort ----------------
//
// Placement is CLICK-TO-PLACE, not drag and drop. Students are on Chromebooks
// and phones, where HTML5 drag events are unreliable and inaccessible to
// keyboard and screen-reader users. Pick a ticker, pick a bucket. Less code,
// works everywhere, and is undoable.

// Shared cover for every module card: same frame, palette, and line style —
// only the motif changes with the activity (dropping a coin into sector trays
// vs. a five-slice portfolio pie). Inline SVG so both cards read as one family
// instead of one stock illustration + one ad-hoc chip collage.
function ModuleCover({ moduleNumber, kindLabel, submitted, art }: {
  moduleNumber?: number; kindLabel: string; submitted?: boolean; art: "sort" | "portfolio";
}) {
  return (
    <div className="module-cover">
      <span className="module-kind">{moduleNumber ? `Module ${moduleNumber} · ${kindLabel}` : kindLabel}</span>
      {submitted && <span className="module-complete">Submitted ✓</span>}
      <div className="module-cover-art" aria-hidden="true">
        {art === "sort" ? (
          <svg viewBox="0 0 280 132" fill="none">
            <circle cx="140" cy="32" r="18" fill="#f4e7c4" stroke="#585a3a" strokeWidth="3" />
            <text x="140" y="39" textAnchor="middle" fontSize="20" fill="#585a3a" style={{ fontFamily: "var(--serif)", fontWeight: 600 }}>$</text>
            <path d="M140 54v14m0 0-5-5m5 5 5-5" stroke="#585a3a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
            <rect x="48" y="74" width="52" height="50" rx="10" fill="#eeefe5" stroke="#585a3a" strokeWidth="2.5" />
            <rect x="114" y="74" width="52" height="50" rx="10" fill="#f4e7c4" stroke="#585a3a" strokeWidth="2.5" />
            <rect x="180" y="74" width="52" height="50" rx="10" fill="#f5e9e6" stroke="#585a3a" strokeWidth="2.5" />
            <circle cx="74" cy="99" r="7" stroke="#585a3a" strokeWidth="2.5" />
            <path d="M140 92l8 14h-16z" stroke="#585a3a" strokeWidth="2.5" strokeLinejoin="round" />
            <rect x="200" y="92" width="14" height="14" rx="2" stroke="#585a3a" strokeWidth="2.5" />
          </svg>
        ) : (
          <svg viewBox="0 0 280 132" fill="none">
            <path d="M140 66 140 16A50 50 0 0 1 187.55 50.55Z" fill="#f4e7c4" stroke="#585a3a" strokeWidth="2.5" strokeLinejoin="round" />
            <path d="M140 66 187.55 50.55A50 50 0 0 1 169.39 106.45Z" fill="#eeefe5" stroke="#585a3a" strokeWidth="2.5" strokeLinejoin="round" />
            <path d="M140 66 169.39 106.45A50 50 0 0 1 110.61 106.45Z" fill="#f5e9e6" stroke="#585a3a" strokeWidth="2.5" strokeLinejoin="round" />
            <path d="M140 66 110.61 106.45A50 50 0 0 1 92.45 50.55Z" fill="#e3e8d4" stroke="#585a3a" strokeWidth="2.5" strokeLinejoin="round" />
            <path d="M140 66 92.45 50.55A50 50 0 0 1 140 16Z" fill="#e8dfc8" stroke="#585a3a" strokeWidth="2.5" strokeLinejoin="round" />
            <circle cx="196" cy="98" r="16" fill="#f4e7c4" stroke="#585a3a" strokeWidth="3" />
            <text x="196" y="104" textAnchor="middle" fontSize="17" fill="#585a3a" style={{ fontFamily: "var(--serif)", fontWeight: 600 }}>$</text>
            <circle cx="140" cy="66" r="6" fill="#fffefb" stroke="#585a3a" strokeWidth="2.5" />
          </svg>
        )}
      </div>
    </div>
  );
}

const wordCount = (value: string): number => value.trim().split(/\s+/).filter(Boolean).length;

// Shared chrome for every Class-tab detail page: back link, mono eyebrow with
// the stable module number, serif title, one-line description. Module 1 (sort)
// and Module 2 (mission) read as one product because they share this header.
function ModuleHead({ moduleNumber, kind, title, detail, onBack }: {
  moduleNumber?: number; kind: string; title?: string; detail?: React.ReactNode; onBack: () => void;
}) {
  return (
    <header className="module-head">
      <button className="class-back" onClick={onBack}>← Modules</button>
      {title && <>
        <div className="eyebrow">{moduleNumber ? `Module ${moduleNumber} · ${kind}` : kind}</div>
        <h2>{title}</h2>
        {detail && <p className="module-detail">{detail}</p>}
      </>}
    </header>
  );
}

function WordCount({ value, min }: { value: string; min: number }) {
  const n = wordCount(value);
  return <span className={`word-count${n >= min ? " met" : ""}`}>{n} / {min} words</span>;
}

function ClassSection({ onOpenInvesting }: { onOpenInvesting: () => void }) {
  const [activities, setActivities] = useState<any[] | null>(null);
  const [posts, setPosts] = useState<any[] | null>(null);
  const [open, setOpen] = useState<{ kind: "sort" | "mission"; id: string; moduleNumber?: number } | null>(null);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    try {
      const [activityResult, postResult] = await Promise.all([
        api<any>("/api/class/activities"), api<any>("/api/class/posts"),
      ]);
      setActivities(activityResult.activities); setPosts(postResult.posts);
    }
    catch (e: any) { setErr(e.message); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const close = useCallback(() => { setOpen(null); void load(); }, [load]);
  if (open?.kind === "sort") return <SortActivity id={open.id} moduleNumber={open.moduleNumber} onBack={close} />;
  if (open?.kind === "mission") return <PortfolioMission id={open.id} moduleNumber={open.moduleNumber} onBack={close} onOpenInvesting={onOpenInvesting} />;

  const announcements = posts?.filter((post) => post.kind === "announcement") ?? [];
  const missions = posts?.filter((post) => post.kind === "portfolio_mission") ?? [];
  const modules = [
    ...missions.map((post) => ({ kind: "mission" as const, moduleNumber: post.moduleNumber, createdAt: post.createdAt, data: post })),
    ...(activities ?? []).map((activity) => ({ kind: "sort" as const, moduleNumber: activity.moduleNumber, createdAt: activity.createdAt, data: activity })),
  ].sort((a, b) => Number(a.moduleNumber || 999) - Number(b.moduleNumber || 999) || String(a.createdAt).localeCompare(String(b.createdAt)));
  const empty = activities?.length === 0 && posts?.length === 0;

  return (
    <div className="class-section">
      <div className="page-intro">
        <div>
          <div className="eyebrow">Class</div>
          <h2>Modules</h2>
          <p>Read the brief, do the work in SimLife, and submit the thinking behind your decisions.</p>
        </div>
      </div>
      {err && <div className="error" role="alert">{err}</div>}
      {(activities === null || posts === null) && <p>Loading…</p>}
      {announcements.length > 0 && <section className="class-announcements" aria-label="Announcements">
        <div className="section-kicker">From your teacher</div>
        {announcements.map((post) => <article className="class-announcement" key={post.id}><span aria-hidden="true">✦</span><div><strong>{post.title}</strong><p>{post.body}</p></div></article>)}
      </section>}
      {empty && (
        <div className="panel"><p className="hint">Nothing posted yet. Check back after class.</p></div>
      )}
      {modules.length > 0 && <div className="section-kicker">Assignments and practice</div>}
      <div className="module-grid">
        {modules.map((module) => module.kind === "mission" ? (() => { const post = module.data; const m = post.mission;
          const status = post.submittedAt ? "Submitted" : m.met ? "Ready to submit" : m.counts.companies === 0 ? "Not started" : "In progress";
          return (
          <button key={`post:${post.id}`} className="module-card" onClick={() => setOpen({ kind: "mission", id: post.id, moduleNumber: post.moduleNumber })}>
            <ModuleCover moduleNumber={post.moduleNumber} kindLabel="Portfolio mission" submitted={!!post.submittedAt} art="portfolio" />
            <div className="module-card-body">
              <h3>{post.title}</h3><p>{post.summary}</p>
              <div className="module-progress-line">
                <span>{m.counts.companies}/{m.targets.minCompanies} companies</span>
                <span>{m.counts.sectors}/{m.targets.minSectors} sectors</span>
              </div>
              <span className={status === "Submitted" ? "badge-paid" : status === "Ready to submit" ? "badge-ready" : "badge-due"}>{status}</span>
            </div>
          </button>
        ); })() : (() => { const a = module.data; return (
          <button key={`sort:${a.id}`} className="module-card" onClick={() => setOpen({ kind: "sort", id: a.id, moduleNumber: a.moduleNumber })}>
            <ModuleCover moduleNumber={a.moduleNumber} kindLabel="Sector practice" submitted={a.attempts > 0} art="sort" />
            <div className="module-card-body">
              <h3>{a.title}</h3><p>Sort every ticker into the sector its business belongs to.</p>
              <div className="module-progress-line">
                <span>{a.tokenCount} companies</span>
                <span>{a.bucketCount} sectors</span>
              </div>
              {a.attempts === 0
                ? (a.hasDraft
                  ? <span className="badge-due">Draft saved</span>
                  : <span className="badge-due">Not started</span>)
                : <span className="badge-paid">Submitted</span>}
            </div>
          </button>
          ); })())}
      </div>
    </div>
  );
}

function LeaderboardSection() {
  const [board, setBoard] = useState<any | null>(null);
  const [err, setErr] = useState("");
  const [sort, setSort] = useState<"percent" | "stable">("percent");
  // Server-side ordering is the source of truth for each view.
  useEffect(() => {
    let cancelled = false;
    setBoard(null);
    api<any>(`/api/class/leaderboard?sort=${sort}`, { cache: "no-store" })
      .then((result) => { if (!cancelled) { setBoard(result); setErr(""); } })
      .catch((e: any) => { if (!cancelled) setErr(e.message); });
    return () => { cancelled = true; };
  }, [sort]);
  return (
    <div className="leaderboard-section">
      <div className="page-intro">
        <div>
          <div className="eyebrow">Class</div>
          <h2>Leaderboard</h2>
          <p>See how portfolios in your class are performing.</p>
        </div>
      </div>
      <Leaderboard board={board} err={err} sort={sort} onSort={setSort} />
    </div>
  );
}

// Quiet table, percent
// only, sectors and largest position beside the return so concentration is
// visible at a glance (LEADERBOARD_PLAN.md §4). Stable gains is a filter+sort:
// only students up at least the bar with enough history, steadiest first —
// an empty answer is fine and says so without drama.
function Leaderboard({ board, err, sort, onSort }: {
  board: any | null; err: string;
  sort: "percent" | "stable"; onSort: (s: "percent" | "stable") => void;
}) {
  const fmtBp = (bp: number) => `${bp >= 0 ? "+" : "-"}${(Math.abs(bp) / 100).toFixed(2)}%`;
  const barPct = board ? (board.stableMinReturnBp / 100).toFixed(2) : "6.00";
  return (
    <section className="class-leaderboard" aria-label="Leaderboard">
      <div className="leaderboard-head">
        <div className="pills" role="group" aria-label="Sort the leaderboard">
          <button className={`pill${sort === "percent" ? " active" : ""}`} aria-pressed={sort === "percent"} onClick={() => onSort("percent")}>Percent gain</button>
          <button className={`pill${sort === "stable" ? " active" : ""}`} aria-pressed={sort === "stable"} onClick={() => onSort("stable")}>Stable gains</button>
        </div>
        {board?.asOfDate && <span className="small">As of {board.asOfDate}</span>}
      </div>
      {err && <div className="error" role="alert">{err}</div>}
      {!board && !err && <p className="hint">Loading standings…</p>}
      {board && !board.asOfDate && (
        <div className="panel"><p className="hint" style={{ margin: 0 }}>No snapshots yet — standings start accumulating with the daily snapshot.</p></div>
      )}
      {board?.asOfDate && sort === "stable" && (
        <p className="hint">Gainers of at least {barPct}% with 3+ days of history, steadiest daily path first. Not everyone makes the bar.</p>
      )}
      {board?.asOfDate && sort === "stable" && board.entries.length === 0 && (
        <div className="panel"><p className="hint" style={{ margin: 0 }}>Nobody qualifies yet — nobody is up at least {barPct}% over enough days. That's fine; check back after the next snapshot.</p></div>
      )}
      {board?.asOfDate && board.entries.length > 0 && (
        <div className="table-wrap">
          <table className="leaderboard-table">
            <thead>
              <tr>
                <th>#</th><th>Student</th><th>Return</th>
                {sort === "stable" && <th>Volatility</th>}
                <th>Sectors</th><th>Largest position</th><th>Holdings</th>
              </tr>
            </thead>
            <tbody>
              {board.entries.map((e: any, i: number) => (
                <tr key={`${e.name}:${i}`} className={e.self ? "is-self" : undefined}>
                  <td>{i + 1}</td>
                  <td>{e.name}{e.self ? " (you)" : ""}</td>
                  <td className={`lb-return ${e.returnBp >= 0 ? "up" : "down"}`}>{fmtBp(e.returnBp)}</td>
                  {sort === "stable" && <td>{e.volBp == null ? "—" : `±${(e.volBp / 100).toFixed(2)}%/day`}</td>}
                  <td>{e.sectorsHeld ?? "—"}</td>
                  <td>{e.topPositionBp == null ? "—" : `${Math.round(e.topPositionBp / 100)}%`}</td>
                  <td>{e.holdingsCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// Module 2 — portfolio mission, checked against current holdings only.
//
// The old page showed the whole assignment at once: a hero, three big steps,
// a form full of empty dropdowns, and a cryptic evidence sidebar — a wall that
// overwhelmed even the teacher. The rethought page answers one question at a
// time: (1) what is the assignment, (2) where do I stand against its goals,
// checked live against my real portfolio, (3) write it up once the evidence is
// there. The write-up is LOCKED until every goal is met, so nobody faces four
// empty textboxes before they have done the trading that makes them answerable.
function PortfolioMission({ id, moduleNumber, onBack, onOpenInvesting }: {
  id: string; moduleNumber?: number; onBack: () => void; onOpenInvesting: () => void;
}) {
  const [post, setPost] = useState<any>(null);
  const [picks, setPicks] = useState([{ ticker: "", thesis: "" }, { ticker: "", thesis: "" }, { ticker: "", thesis: "" }]);
  const [reflection, setReflection] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState("");
  const key = useRef(uid());
  const hydrated = useRef(false);

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (opts?.silent) setRefreshing(true);
    try {
      const result = await api<any>(`/api/class/posts/${id}`, { cache: "no-store" });
      setPost(result);
      // Hydrate the form from the stored write-up once. A silent refresh while
      // the student is typing must never overwrite what they are working on.
      if (result.submission?.response && !hydrated.current) {
        setPicks(result.submission.response.picks);
        setReflection(result.submission.response.reflection);
      }
      hydrated.current = true;
    } catch (e: any) { if (!opts?.silent) setErr(e.message); }
    finally { setRefreshing(false); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  // Trading happens in another section or tab — re-check evidence when the
  // student comes back, so goals tick over without a manual reload.
  useEffect(() => {
    const onFocus = () => { if (!busy) void load({ silent: true }); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load, busy]);

  if (err && !post) return <div className="class-section"><ModuleHead kind="Portfolio mission" onBack={onBack} /><div className="error" role="alert">{err}</div></div>;
  if (!post) return <div className="class-section"><ModuleHead kind="Portfolio mission" onBack={onBack} /><p>Loading mission…</p></div>;

  const mission = post.mission;
  const t = mission.targets;
  const options = mission.companies.map((holding: any) => holding.ticker) as string[];
  const updatePick = (index: number, changes: any) => setPicks(picks.map((pick, i) => i === index ? { ...pick, ...changes } : pick));

  // Both goals use the live portfolio, regardless of earlier trades.
  const goals = [
    {
      done: mission.checks.companies,
      label: `Hold ${t.minCompanies} companies`,
      detail: mission.checks.companies
        ? `${mission.counts.companies} of ${t.minCompanies} held.`
        : `${mission.counts.companies} of ${t.minCompanies} held — buy ${t.minCompanies - mission.counts.companies} more individual companies.`,
    },
    {
      done: mission.checks.sectors,
      label: `Cover ${t.minSectors} sectors`,
      detail: mission.checks.sectors
        ? `${mission.counts.sectors} of ${t.minSectors} sectors represented — one bad year in one industry can no longer take the whole account.`
        : `${mission.counts.sectors} of ${t.minSectors} sectors. Look at which industries you already own, then buy where you have a gap.`,
    },
  ];
  const progress = (
    Math.min(1, mission.counts.companies / t.minCompanies) +
    Math.min(1, mission.counts.sectors / t.minSectors)
  ) / 2;

  const submitted = !!post.submission;
  const problems: string[] = [];
  if (!mission.met) problems.push("Meet every goal above — the write-up unlocks when your portfolio evidence is complete.");
  const chosen = picks.map((pick) => pick.ticker.trim().toUpperCase()).filter(Boolean);
  if (new Set(chosen).size !== 3 || chosen.some((ticker) => !options.includes(ticker))) {
    problems.push("Choose three different stocks you currently hold.");
  }
  picks.forEach((pick, index) => {
    if (wordCount(pick.thesis) < t.pickThesisMinWords) problems.push(`Stock ${index + 1} needs at least ${t.pickThesisMinWords} words.`);
  });
  if (wordCount(reflection) < t.reflectionMinWords) problems.push(`The final reflection needs at least ${t.reflectionMinWords} words.`);
  const ready = problems.length === 0;

  const submit = async () => {
    if (busy || !ready) return;
    setBusy(true); setErr("");
    try {
      await api(`/api/class/posts/${id}/submit`, { method: "POST", body: JSON.stringify({ response: { picks, reflection }, idempotencyKey: key.current }) });
      key.current = uid();   // a fresh key so a resubmit is its own submission
      hydrated.current = false;
      await load();
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="class-section module-page">
      <ModuleHead moduleNumber={moduleNumber} kind="Portfolio mission" title={post.title} detail={post.summary} onBack={onBack} />
      {err && <div className="error" role="alert">{err}</div>}
      {submitted && (
        <div className="notice" role="status" aria-live="polite">
          <strong>Submitted ✓ · {new Date(post.submission.createdAt).toLocaleString()}</strong>{" "}
          Your teacher received a snapshot of your holdings plus your write-up. You can keep editing and update it if you change your mind.
        </div>
      )}

      <section className="panel">
        <div className="section-kicker">The assignment</div>
        <p className="mission-brief-body">{post.body}</p>
        <div className="mission-holdings" aria-label="Current stock holdings and sectors">
          <strong>Stocks you hold now · {mission.counts.companies}</strong>
          <p className="small">These are the stocks counted toward your goals. A sector counts once even when several stocks share it.</p>
          {mission.companies.length ? (
            <div className="mission-holdings-list">
              {mission.companies.map((holding: any) => (
                <div className="mission-holding" key={holding.ticker}>
                  <strong>{holding.ticker}</strong>
                  <span>{holding.sector}</span>
                </div>
              ))}
            </div>
          ) : <p className="small">No individual company stocks held yet.</p>}
        </div>
      </section>

      <section className="panel goals-card" aria-label="Where you stand">
        <div className="panel-heading">
          <div>
            <h3>Where you stand</h3>
            <p className="hint">Checked against your live SimLife portfolio — nothing on this list is typed in. Trade, then Refresh.</p>
          </div>
          <div className="goals-score" aria-label={`${mission.counts.companies} of ${t.minCompanies} stocks and ${mission.counts.sectors} of ${t.minSectors} sectors`}>
            <div><strong>{mission.counts.companies}/{t.minCompanies}</strong><span>stocks</span></div>
            <div><strong>{mission.counts.sectors}/{t.minSectors}</strong><span>sectors</span></div>
          </div>
        </div>
        <div className="goal-bar"><div style={{ width: `${progress * 100}%` }} /></div>
        <ol className="goal-list">
          {goals.map((goal) => (
            <li className={`goal-item${goal.done ? " done" : ""}`} key={goal.label}>
              <span className="goal-tick" aria-hidden="true">{goal.done ? "✓" : "○"}</span>
              <div>
                <div className="goal-label">{goal.label}<span className="sr-only">{goal.done ? " — done" : " — not yet"}</span></div>
                <div className="goal-detail">{goal.detail}</div>
              </div>
            </li>
          ))}
        </ol>
        {mission.sectors.length > 0 && (
          <div className="goal-sectors">
            <div>
              <span className="small">Sectors you hold now</span>
              <div className="sector-chip-row">
                {mission.sectors.map((sector: string) => <span className="sector-chip now" key={sector}>{sector}</span>)}
              </div>
            </div>
          </div>
        )}
        <div className="row goals-actions">
          <button onClick={onOpenInvesting}>Open Investing →</button>
          <button className="ghost" disabled={refreshing} onClick={() => void load({ silent: true })}>{refreshing ? "Refreshing…" : "Refresh"}</button>
          <span className="small">Buys and sells update these goals as soon as you come back to this page.</span>
        </div>
      </section>

      <section className="panel">
        <div className="section-kicker">Explain what you built</div>
        {!mission.met ? (
          <div className="explain-lock">
            <p><strong>The write-up opens once every goal above is checked.</strong>{" "}
              {!mission.checks.companies && `Buy ${t.minCompanies - mission.counts.companies} more ${t.minCompanies - mission.counts.companies === 1 ? "company" : "companies"}${
                !mission.checks.sectors ? ` and reach ${t.minSectors} sectors (you're at ${mission.counts.sectors})` : ""
              }.`}
              {mission.checks.companies && !mission.checks.sectors && `Cover ${t.minSectors - mission.counts.sectors} more sector${t.minSectors - mission.counts.sectors === 1 ? "" : "s"} — you're at ${mission.counts.sectors}.`}
              {" "}Do the trading first — your teacher checks the holdings snapshot against what you write.</p>
            {options.length > 0 && (
              <>
                <span className="small">Your current stocks — choose three to explain when the goals are met</span>
                <div className="sector-chip-row">
                  {options.map((ticker) => (
                    <span className="sector-chip now" key={ticker}>
                      <strong>{ticker}</strong> {mission.companies.find((c: any) => c.ticker === ticker)?.sector || "company"}
                    </span>
                  ))}
                </div>
              </>
            )}
            <button onClick={onOpenInvesting}>Open Investing →</button>
          </div>
        ) : (
          <>
            <p className="hint">Choose three stocks you currently hold. Explain what each business does and how the mix of sectors affects your risk.</p>
            {picks.map((pick, index) => (
              <div className="explain-pick" key={index}>
                <div className="pick-head">
                  <span className="pick-no" aria-hidden="true">{index + 1}</span>
                  <select value={pick.ticker} onChange={(e) => updatePick(index, { ticker: e.target.value })} aria-label={`Stock ${index + 1} holding`}>
                    <option value="">Choose a stock you currently hold…</option>
                    {options.map((ticker) => (
                      <option key={ticker} value={ticker} disabled={chosen.includes(ticker) && pick.ticker !== ticker}>
                        {ticker} · {mission.companies.find((c: any) => c.ticker === ticker)?.sector}
                      </option>
                    ))}
                  </select>
                </div>
                <textarea rows={3} value={pick.thesis} onChange={(e) => updatePick(index, { thesis: e.target.value })}
                  placeholder="What does this business do, and how does its sector contribute to your portfolio?" />
                <WordCount value={pick.thesis} min={t.pickThesisMinWords} />
              </div>
            ))}
            <div className="field reflect-field">
              <label>How does your current mix of sectors affect your risk?</label>
              <textarea rows={5} value={reflection} onChange={(e) => setReflection(e.target.value)}
                placeholder={`Explain how your current stocks spread risk across sectors — at least ${t.reflectionMinWords} words…`} />
              <WordCount value={reflection} min={t.reflectionMinWords} />
            </div>
          </>
        )}
      </section>

      <div className="module-action-bar">
        <div>
          <strong>{mission.met ? (submitted ? "Update your submission" : "Evidence complete") : `${mission.counts.companies}/${t.minCompanies} stocks · ${mission.counts.sectors}/${t.minSectors} sectors`}</strong>
          <span>{ready ? "Your teacher receives the holdings snapshot plus your write-up." : problems[0]}</span>
        </div>
        <button disabled={busy || !ready} onClick={submit}>
          {busy ? "Submitting…" : submitted ? "Update submission" : "Submit mission"}
        </button>
      </div>
    </div>
  );
}

function SortActivity({ id, moduleNumber, onBack }: { id: string; moduleNumber?: number; onBack: () => void }) {
  const [act, setAct] = useState<any>(null);
  const [placements, setPlacements] = useState<Record<string, string>>({});
  const [picked, setPicked] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<any>(null);
  const [saved, setSaved] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const key = useRef(uid());

  // Drag state. POINTER EVENTS, not HTML5 drag-and-drop: pointer events fire
  // for mouse, touch and pen alike, so the same code works on a Chromebook
  // trackpad and a phone. HTML5 `draggable` does not fire on touch at all,
  // which would leave any student on a phone unable to do the assignment.
  const [drag, setDrag] = useState<{ ticker: string; x: number; y: number; moved: boolean } | null>(null);
  const bucketRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const trayRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const a = await api<any>(`/api/class/activities/${id}`);
        setAct(a);
        // Resume from the most recent submission so a reload never loses work.
        if (a.attempts?.length) {
          setPlacements(a.attempts[0].placements || {});
          setSubmitted({ attemptNo: a.attempts[0].attemptNo, submittedAt: a.attempts[0].createdAt });
        } else if (a.draft) {
          setPlacements(a.draft.placements || {});
          setSaved({ savedAt: a.draft.updatedAt });
        }
      } catch (e: any) { setErr(e.message); }
    })();
  }, [id]);

  const zoneAt = useCallback((x: number, y: number): string | null => {
    for (const [name, el] of Object.entries(bucketRefs.current)) {
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return name;
    }
    const tray = trayRef.current?.getBoundingClientRect();
    if (tray && x >= tray.left && x <= tray.right && y >= tray.top && y <= tray.bottom) return "__tray__";
    return null;
  }, []);

  const onPointerDown = (ticker: string) => (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    setDrag({ ticker, x: e.clientX, y: e.clientY, moved: false });
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    // A few pixels of slop so a tap is not mistaken for a drag.
    const moved = drag.moved || Math.abs(e.clientX - drag.x) > 6 || Math.abs(e.clientY - drag.y) > 6;
    setDrag({ ...drag, x: e.clientX, y: e.clientY, moved });
    if (moved) setHover(zoneAt(e.clientX, e.clientY));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (!drag) return;
    const { ticker, moved } = drag;
    const zone = moved ? zoneAt(e.clientX, e.clientY) : null;
    setDrag(null); setHover(null);
    if (moved) {
      if (zone === "__tray__") unplace(ticker);
      else if (zone) { assign(ticker, zone); }
      else unplace(ticker);
      return;
    }
    // Not a drag: treat as a tap. Tap a chip then a bucket also works, which is
    // what keyboard and screen-reader users get via the buttons.
    if (placements[ticker]) unplace(ticker);
    else setPicked(picked === ticker ? null : ticker);
  };

  const assign = (ticker: string, bucket: string) => {
    setPlacements((p) => ({ ...p, [ticker]: bucket }));
    setPicked(null);
  };
  const unplace = (ticker: string) => {
    setPlacements((p) => { const n = { ...p }; delete n[ticker]; return n; });
    setPicked(null);
  };

  if (err && !act) return <div className="class-section"><ModuleHead kind="Sector practice" onBack={onBack} /><div className="error" role="alert">{err}</div></div>;
  if (!act) return <div className="class-section"><ModuleHead kind="Sector practice" onBack={onBack} /><p>Loading…</p></div>;

  const unplaced = act.tokens.filter((t: any) => !placements[t.ticker]);
  const allPlaced = unplaced.length === 0;
  const placedCount = act.tokens.length - unplaced.length;

  const submit = async () => {
    if (busy) return;
    setBusy(true); setErr("");
    try {
      const r = await api<any>(`/api/class/activities/${id}/submit`, {
        method: "POST", body: JSON.stringify({ placements, idempotencyKey: key.current }),
      });
      setSubmitted(r);
      setSaved(null);
      key.current = uid();   // a fresh key so a resubmit is its own submission
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const save = async () => {
    if (saving || busy) return;
    setSaving(true); setErr("");
    try {
      const r = await api<any>(`/api/class/activities/${id}/draft`, {
        method: "POST", body: JSON.stringify({ placements }),
      });
      setSaved(r);
    } catch (e: any) { setErr(e.message); }
    finally { setSaving(false); }
  };

  const chip = (t: any, placed: boolean) => {
    return (
      <button key={t.ticker}
        className={`ticker-chip${placed ? " placed" : ""}${picked === t.ticker ? " picked" : ""}${drag && drag.ticker === t.ticker && drag.moved ? " dragging" : ""}`}
        aria-pressed={picked === t.ticker}
        onPointerDown={onPointerDown(t.ticker)}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => { setDrag(null); setHover(null); }}>
        {t.ticker}
      </button>
    );
  };

  return (
    <div className="class-section">
      <ModuleHead moduleNumber={moduleNumber} kind="Sector practice" title={act.title} detail={act.prompt} onBack={onBack} />
      {err && <div className="error" role="alert">{err}</div>}

      {submitted && (
        <div className="notice" role="status" aria-live="polite">
          <strong>Submitted{submitted.submittedAt ? ` · ${new Date(submitted.submittedAt).toLocaleString()}` : ""}.</strong>{" "}
          Your teacher will check it. You can move companies and submit again if you need to change it.
        </div>
      )}
      {!submitted && saved && (
        <div className="frozen" role="status" aria-live="polite">
          <strong>Progress saved{saved.savedAt ? ` · ${new Date(saved.savedAt).toLocaleString()}` : ""}.</strong>{" "}
          Not submitted yet — finish sorting and hit Submit when you are done.
        </div>
      )}

      <div ref={trayRef} className={`panel sort-tray${hover === "__tray__" ? " over" : ""}`}>
        <h3>{unplaced.length ? `Still to sort — ${unplaced.length}` : "All sorted"}</h3>
        {unplaced.length === 0
          ? <p className="hint">Every company is in a category. Hit Submit when you are done.</p>
          : <div className="chip-row">{unplaced.map((t: any) => chip(t, false))}</div>}
        <p className="small">Drag a company into a category — or tap it, then tap the category.</p>
      </div>

      <div className="bucket-grid">
        {act.buckets.map((b: string) => {
          const inHere = act.tokens.filter((t: any) => placements[t.ticker] === b);
          return (
            <div key={b}
              ref={(el) => { bucketRefs.current[b] = el; }}
              className={`panel bucket${picked ? " targetable" : ""}${hover === b ? " over" : ""}`}>
              <button className="bucket-head" disabled={!picked} onClick={() => picked && assign(picked, b)}>
                <h3>{b}</h3>
                <span className="small">{picked ? `Put ${picked} here` : `${inHere.length} placed`}</span>
              </button>
              <div className="chip-row">
                {inHere.map((t: any) => chip(t, true))}
                {inHere.length === 0 && <span className="small">drop here</span>}
              </div>
            </div>
          );
        })}
      </div>

      {drag?.moved && (
        <div className="drag-ghost" style={{ left: drag.x, top: drag.y }}>{drag.ticker}</div>
      )}

      <div className="module-action-bar">
        <div>
          <strong>
            {submitted
              ? `Submitted · ${submitted.submittedAt ? new Date(submitted.submittedAt).toLocaleString() : ""}`
              : saved
                ? `Draft saved · ${saved.savedAt ? new Date(saved.savedAt).toLocaleString() : ""}`
                : `${placedCount} of ${act.tokens.length} placed`}
          </strong>
          <span>
            {submitted
              ? `Submission ${submitted.attemptNo} — your teacher will check it. Move companies and submit again if you change your mind.`
              : allPlaced
                ? "Every company is in a category — submit when you are happy with it."
                : `Sort all ${act.tokens.length} to submit — or Save to finish later.`}
          </span>
        </div>
        <div className="row">
          <button className="ghost" disabled={saving || busy || placedCount === 0} onClick={save}>
            {saving ? "Saving…" : "Save draft"}
          </button>
          <button disabled={busy || !allPlaced} onClick={submit}>
            {busy ? "Submitting…" : submitted ? "Submit again" : "Submit"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------- teacher: class activity results ----------------

function TeacherModuleVisibility({ classId, refreshKey, onChanged }: { classId: string; refreshKey: number; onChanged: () => void }) {
  const [modules, setModules] = useState<any[]>([]);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    if (!classId) { setModules([]); setHidden(new Set()); return; }
    const result = await api<any>(`/api/teacher/classes/${classId}/modules`);
    setModules(result.modules); setHidden(new Set(result.hidden));
  }, [classId]);
  useEffect(() => { load().catch((e: any) => setErr(e.message)); }, [load, refreshKey]);

  const save = async (next: Set<string>) => {
    const previous = hidden;
    setHidden(next); setBusy(true); setSaved(false); setErr("");
    try {
      const result = await api<any>(`/api/teacher/classes/${classId}/modules`, {
        method: "PUT", body: JSON.stringify({ hidden: [...next] }),
      });
      setHidden(new Set(result.hidden)); setSaved(true); onChanged();
      window.setTimeout(() => setSaved(false), 1600);
    } catch (e: any) { setHidden(previous); setErr(e.message); }
    finally { setBusy(false); }
  };
  const toggle = (key: string) => {
    const next = new Set(hidden);
    next.has(key) ? next.delete(key) : next.add(key);
    void save(next);
  };
  const setAll = (show: boolean) => void save(show ? new Set() : new Set(modules.map((module) => module.key)));

  return <div className="panel module-visibility-desk">
    <div className="panel-heading"><div><h2>Modules shown to this period</h2><p className="hint">Untick a module to remove it from those students' Class page. Their saved work and submissions stay intact.</p></div>{classId && <div className="row"><button className="ghost" disabled={busy || modules.length === 0} onClick={() => setAll(true)}>Show all</button><button className="ghost" disabled={busy || modules.length === 0} onClick={() => setAll(false)}>Hide all</button></div>}</div>
    {!classId && <p className="small">Choose a period above to manage what its students can see.</p>}
    {err && <div className="error" role="alert">{err}</div>}
    {classId && modules.length === 0 && <p className="small">No published modules yet. Publish a sector sort or portfolio mission first.</p>}
    {classId && modules.length > 0 && <div className="module-visibility-grid">{modules.map((module) => <label key={module.key} className={hidden.has(module.key) ? "module-hidden" : ""}><input type="checkbox" checked={!hidden.has(module.key)} disabled={busy} onChange={() => toggle(module.key)} /><span><strong>Module {module.moduleNumber}</strong>{module.title}<small>{module.kind === "sort" ? "Sector practice" : "Portfolio mission"}</small></span></label>)}</div>}
    {classId && <div className="module-save-state" aria-live="polite">{busy ? "Saving…" : saved ? "Saved ✓" : `${modules.length - hidden.size} shown · ${hidden.size} hidden`}</div>}
  </div>;
}

function TeacherClassPosts({ classes, defaultClassId, onModulesChanged }: { classes: any[]; defaultClassId: string; onModulesChanged: () => void }) {
  const [posts, setPosts] = useState<any[]>([]);
  const [open, setOpen] = useState<"" | "announcement" | "portfolio_mission">("");
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [body, setBody] = useState("");
  const [scope, setScope] = useState(defaultClassId);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => setPosts((await api<any>("/api/teacher/class-posts")).posts), []);
  useEffect(() => { load().catch((e: any) => setErr(e.message)); }, [load]);
  useEffect(() => { if (open) setScope(defaultClassId); }, [defaultClassId, open]);

  const start = (kind: "announcement" | "portfolio_mission") => {
    setOpen(kind); setErr(""); setNotice("");
    if (kind === "portfolio_mission") {
      setTitle("Build a five-sector portfolio");
      setSummary("Hold at least six individual stocks across at least five sectors, then explain how your portfolio is diversified.");
      setBody("Build a portfolio that currently holds at least six individual stocks across at least five different sectors. You may buy and sell as you choose; only your current holdings count. Multiple stocks in the same sector count as one sector. ETFs do not count toward the six-stock target.");
    } else { setTitle(""); setSummary(""); setBody(""); }
  };
  const createPost = async () => {
    setBusy(true); setErr(""); setNotice("");
    try {
      const created = await api<any>("/api/teacher/class-posts", { method: "POST", body: JSON.stringify({
        kind: open, classId: scope || null, title, summary, body,
        heroUrl: open === "portfolio_mission" ? "/module-art/balanced-portfolio.svg" : null,
        spec: open === "portfolio_mission" ? { minCompanies: 6, minSectors: 5, pickThesisMinWords: 12, reflectionMinWords: 40 } : {},
      }) });
      setOpen(""); await load(); onModulesChanged(); setNotice(`Draft “${created.title}” created.`);
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };
  const status = async (id: string, next: string) => {
    setBusy(true); setErr(""); setNotice("");
    try {
      await api(`/api/teacher/class-posts/${id}/status`, { method: "POST", body: JSON.stringify({ status: next }) });
      await load(); onModulesChanged(); setNotice(next === "published" ? "Posted to students." : next === "archived" ? "Post archived." : "Post returned to draft.");
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };
  const published = posts.filter((post) => post.status === "published").length;
  const drafts = posts.filter((post) => post.status === "draft").length;
  return <details className="panel class-post-desk">
    <summary className="class-post-summary"><span><strong>Create & publish</strong><small>Announcements and portfolio assignments</small></span><span className="small">{published} live · {drafts} draft</span></summary>
    <div className="class-post-body">
    <div className="panel-heading"><div><h2>Assignments & announcements</h2><p className="hint"><strong>Announcements</strong> are messages only. <strong>Portfolio assignments</strong> become numbered modules with completion evidence.</p></div><div className="row"><button className="ghost" onClick={() => start("announcement")}>New announcement</button><button onClick={() => start("portfolio_mission")}>New portfolio assignment</button></div></div>
    {err && <div className="error">{err}</div>}{notice && <div className="notice">{notice}</div>}
    {open && <div className="class-post-form">
      <div className="grid2"><div className="field"><label>Title</label><input value={title} onChange={(e) => setTitle(e.target.value)} /></div><div className="field"><label>Who gets it</label><select value={scope} onChange={(e) => setScope(e.target.value)}><option value="">Every class</option>{classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div></div>
      {open === "portfolio_mission" && <div className="field"><label>Card summary</label><textarea rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} /></div>}
      <div className="field"><label>{open === "announcement" ? "Message" : "Mission brief"}</label><textarea rows={5} value={body} onChange={(e) => setBody(e.target.value)} /></div>
      {open === "portfolio_mission" && <p className="hint">Built-in evidence: 6 current stocks · 5 current sectors · three research explanations · final reflection.</p>}
      <div className="row"><button disabled={busy || title.trim().length < 2 || body.trim().length < 2} onClick={createPost}>Save draft</button><button className="ghost" onClick={() => setOpen("")}>Cancel</button></div>
    </div>}
    {posts.length > 0 && <div className="class-post-list">{posts.map((post) => <div className="class-post-row" key={post.id}><div><span className="small">{post.kind === "announcement" ? "Announcement · message only" : "Portfolio assignment · numbered module"} · {post.classId ? classes.find((c) => c.id === post.classId)?.name || "One class" : "Every class"}</span><strong>{post.title}</strong></div><span className={post.status === "published" ? "badge-paid" : "badge-due"}>{post.status}</span><div className="row">{post.status !== "published" && <button disabled={busy} onClick={() => status(post.id, "published")}>Publish</button>}{post.status === "published" && <button className="ghost" disabled={busy} onClick={() => status(post.id, "draft")}>Unpublish</button>}{post.status !== "archived" && <button className="ghost" disabled={busy} onClick={() => status(post.id, "archived")}>Archive</button>}</div></div>)}</div>}
    </div>
  </details>;
}

function TeacherClass({ classes, classId, periodBar, roster, moduleProgress, onOpenStudent, onDashboardChanged }: {
  classes: any[];
  classId: string;
  periodBar: React.ReactNode;
  roster: any[];
  moduleProgress: { modules: any[]; students: Record<string, { assigned: number; started: number; completed: number }> };
  onOpenStudent: (id: string) => void;
  onDashboardChanged: () => void;
}) {
  const [activities, setActivities] = useState<any[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [composing, setComposing] = useState(false);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("Put each ticker in its sector.");
  const [activityClass, setActivityClass] = useState("");
  const [bucketsText, setBucketsText] = useState([
    "Consumer Discretionary", "Consumer Staples", "Information Technology",
    "Health Care", "Financials", "Utilities",
  ].join("\n"));
  const [tickersText, setTickersText] = useState("NKE\nSBUX\nCOST\nPG\nNVDA\nAAPL\nAMZN\nJNJ\nJPM\nBAC\nNEE\nDUK");
  const [moduleRevision, setModuleRevision] = useState(0);
  const [studentQuery, setStudentQuery] = useState("");

  const loadActivities = useCallback(async (preferId?: string) => {
    const r = await api<any>("/api/teacher/activities");
    setActivities(r.activities);
    setSelected((current) => preferId || current || r.activities[0]?.id || "");
  }, []);
  useEffect(() => { loadActivities().catch((e: any) => setErr(e.message)); }, [loadActivities]);

  const load = useCallback(async () => {
    if (!selected) { setData(null); return; }
    setBusy(true);
    try {
      setData(await api<any>(`/api/teacher/activities/${selected}/progress${classId ? `?classId=${classId}` : ""}`));
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  }, [selected, classId]);
  useEffect(() => { void load(); }, [load]);

  const lines = (value: string) => value.split(/[\n,]+/).map((part) => part.trim()).filter(Boolean);
  const create = async () => {
    setBusy(true); setErr(""); setNotice("");
    try {
      const act = await api<any>("/api/teacher/activities", {
        method: "POST",
        body: JSON.stringify({
          classId: activityClass || null,
          title, prompt,
          buckets: lines(bucketsText),
          tokens: lines(tickersText).map((ticker) => ({ ticker: ticker.toUpperCase() })),
          status: "draft",
        }),
      });
      await loadActivities(act.id);
      setComposing(false); setTitle("");
      setNotice(`Draft “${act.title}” created. Review it, then publish when ready.`);
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const changeStatus = async (status: "draft" | "published" | "archived") => {
    if (!selected) return;
    setBusy(true); setErr(""); setNotice("");
    try {
      await api(`/api/teacher/activities/${selected}/status`, {
        method: "POST", body: JSON.stringify({ status }),
      });
      await loadActivities(selected); await load(); setModuleRevision((value) => value + 1); onDashboardChanged();
      setNotice(status === "published" ? "Activity published to students." : status === "archived" ? "Activity archived." : "Activity returned to draft.");
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const act = data?.activity;
  const tickers: string[] = act ? act.tokens.map((t: any) => String(t.ticker)) : [];
  const started = (data?.students ?? []).filter((s: any) => s.attempts > 0);
  const perfect = started.filter((s: any) => s.bestCorrect === s.total);

  const csv = () => {
    if (!data) return;
    const head = ["Student", "Submissions", "SubmittedAt", "Best", "Total", ...tickers];
    const lines = [head.join(",")];
    for (const s of data.students) {
      const cells = tickers.map((t) => {
        if (!s.bestPlacements) return "";
        const placed = s.bestPlacements[t];
        if (!placed) return "";
        return placed === data.answerKey[t] ? "correct" : placed;
      });
      lines.push([`"${s.name}"`, s.attempts, s.lastAt ? `"${s.lastAt}"` : "", s.bestCorrect ?? "", s.total ?? "", ...cells].join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${act.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="teacher-class">
      <div className="page-intro">
        <div>
          <div className="eyebrow">Teacher desk</div>
          <h2>Class progress</h2>
          <p>Choose a period, set its modules, then scan student progress.</p>
        </div>
        <div className="row">
          {data && <div className="teacher-summary"><strong>{started.length}</strong><span>of {data.students.length} started</span></div>}
          <button className="ghost" onClick={() => { setComposing((open) => !open); setActivityClass(classId); setErr(""); }}>{composing ? "Close sort creator" : "Create sector sort"}</button>
        </div>
      </div>

      {periodBar}

      {err && <div className="error" role="alert">{err}</div>}
      {notice && <div className="notice" role="status">{notice}</div>}

      <TeacherModuleVisibility classId={classId} refreshKey={moduleRevision} onChanged={onDashboardChanged} />

      <div className="panel class-module-roster">
        <div className="panel-heading"><div><h2>Student progress</h2><p className="hint">{classId ? `${classes.find((c) => c.id === classId)?.name || "This period"} students only.` : "All periods."} Click a student to see every module, submission, and piece of evidence.</p></div><div className="teacher-summary"><strong>{roster.length}</strong><span>students</span></div></div>
        <div className="roster-tools"><div className="field"><label htmlFor="class-roster-search">Find a student</label><input id="class-roster-search" value={studentQuery} onChange={(e) => setStudentQuery(e.target.value)} placeholder="Search name or email" /></div></div>
        <div className="table-wrap"><table>
          <thead><tr><th>Student</th><th>Class</th><th>Assigned</th><th>Started</th><th>Submitted</th><th>Last active</th></tr></thead>
          <tbody>
            {roster.filter((student) => `${student.name} ${student.email || ""}`.toLowerCase().includes(studentQuery.trim().toLowerCase())).map((student) => {
              const progress = moduleProgress.students[student.id] ?? { assigned: 0, started: 0, completed: 0 };
              return <tr key={student.id} className="clickable-row" onClick={() => onOpenStudent(student.id)}>
                <td><strong>{student.name}</strong><br /><span className="small">{student.email || "no email yet"}</span></td>
                <td className="small">{student.class_name || "—"}</td>
                <td><strong>{progress.assigned}</strong></td>
                <td>{progress.started}/{progress.assigned}</td>
                <td><span className={progress.completed === progress.assigned && progress.assigned > 0 ? "badge-paid" : "badge-due"}>{progress.completed}/{progress.assigned}</span></td>
                <td className="small">{fmtWhen(student.last_active_at)}</td>
              </tr>;
            })}
            {roster.length === 0 && <tr><td colSpan={6} className="small">No students in this view.</td></tr>}
          </tbody>
        </table></div>
      </div>

      {composing && (
        <div className="panel activity-composer">
          <div className="panel-heading"><div><h2>New sector sort</h2><p className="hint">The answer key comes from the ticker directory. New activities stay private until you publish them.</p></div><span className="badge-due">Draft</span></div>
          <div className="grid2">
            <div className="field"><label htmlFor="new-act-title">Title</label><input id="new-act-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Sector sort — Week 2" /></div>
            <div className="field"><label htmlFor="new-act-class">Who gets it</label><select id="new-act-class" value={activityClass} onChange={(e) => setActivityClass(e.target.value)}><option value="">Every class</option>{classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
          </div>
          <div className="field"><label htmlFor="new-act-prompt">Directions</label><textarea id="new-act-prompt" rows={2} value={prompt} onChange={(e) => setPrompt(e.target.value)} /></div>
          <div className="grid2">
            <div className="field"><label htmlFor="new-act-buckets">Categories — one per line</label><textarea id="new-act-buckets" rows={8} value={bucketsText} onChange={(e) => setBucketsText(e.target.value)} /></div>
            <div className="field"><label htmlFor="new-act-tickers">Tickers — one per line</label><textarea id="new-act-tickers" rows={8} value={tickersText} onChange={(e) => setTickersText(e.target.value)} /></div>
          </div>
          <div className="row"><button disabled={busy || title.trim().length < 2 || lines(bucketsText).length < 2 || lines(tickersText).length < 2} onClick={create}>{busy ? "Saving…" : "Save draft"}</button><span className="small">You can publish it from the activity controls below.</span></div>
        </div>
      )}

      <div className="module-results-heading">
        <div className="section-kicker">One module at a time</div>
        <h2>Sector-sort results</h2>
        <p className="hint">This section is the class-wide breakdown for the selected sector-sort assignment. Portfolio-assignment evidence is in each student's progress drawer above.</p>
      </div>

      <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
        <div className="field grow">
          <label htmlFor="act-pick">Activity</label>
          <select id="act-pick" value={selected} onChange={(e) => setSelected(e.target.value)}>
            {activities.length === 0 && <option value="">No activities yet — run npm run seed:sort</option>}
            {activities.map((a) => <option key={a.id} value={a.id}>{a.title}{a.status !== "published" ? ` (${a.status})` : ""}</option>)}
          </select>
        </div>
        {data && <button className="ghost" onClick={csv} style={{ alignSelf: "end" }}>Export CSV</button>}
      </div>

      {act && (
        <div className="activity-publish-bar">
          <div><strong>{act.title}</strong> <span className={act.status === "published" ? "badge-paid" : "badge-due"}>{act.status}</span><div className="small">{activities.find((a) => a.id === act.id)?.classId ? classes.find((c) => c.id === activities.find((a) => a.id === act.id)?.classId)?.name || "One class" : "Every class"}</div></div>
          <div className="row">
            {act.status !== "published" && <button disabled={busy} onClick={() => changeStatus("published")}>Publish</button>}
            {act.status === "published" && <button className="ghost" disabled={busy} onClick={() => changeStatus("draft")}>Unpublish</button>}
            {act.status !== "archived" && <button className="ghost" disabled={busy} onClick={() => changeStatus("archived")}>Archive</button>}
          </div>
        </div>
      )}

      {busy && <p className="small">Loading…</p>}

      {data && (
        <>
          <div className="cards" style={{ marginTop: 14 }}>
            <div className="card"><div className="label">Submitted</div><div className="value">{started.length}</div><div className="sub">of {data.students.length} students</div></div>
            <div className="card"><div className="label">All correct</div><div className="value">{perfect.length}</div><div className="sub">got every company right</div></div>
            <div className="card"><div className="label">Not submitted</div><div className="value">{data.students.length - started.length}</div><div className="sub">no submission yet</div></div>
          </div>

          <div className="panel" style={{ marginTop: 14 }}>
            <h2>Which companies the class misfiled</h2>
            <p className="hint">Ranked by how often it was put in the wrong category. The last column is where they put it — that is the misconception, not just the miss.</p>
            <div className="table-wrap"><table>
              <thead><tr><th>Company</th><th>Correct category</th><th>Got it wrong</th><th>Most common wrong answer</th></tr></thead>
              <tbody>
                {data.misses.filter((m: any) => m.attempts > 0).map((m: any) => (
                  <tr key={m.ticker}>
                    <td><strong className="ticker">{m.ticker}</strong></td>
                    <td className="small">{data.answerKey[m.ticker] || "—"}</td>
                    <td>{m.wrong} of {m.attempts}</td>
                    <td className="small">{m.commonWrongBucket || "—"}</td>
                  </tr>
                ))}
                {data.misses.every((m: any) => m.attempts === 0) && <tr><td colSpan={4} className="small">No submissions yet.</td></tr>}
              </tbody>
            </table></div>
          </div>

          <div className="panel" style={{ marginTop: 14 }}>
            <h2>Every student</h2>
            <p className="hint">Latest submission shown with teacher checking. ✓ correct · ✕ wrong category · blank means they never placed it.</p>
            <div className="table-wrap"><table className="sort-grid">
              <thead>
                <tr>
                  <th>Student</th><th>Subs</th><th>Submitted</th><th>Best</th>
                  {tickers.map((t) => <th key={t} className="tick-col">{t}</th>)}
                </tr>
              </thead>
              <tbody>
                {data.students.map((s: any) => (
                  <tr key={s.userId}>
                    <td>{s.name}</td>
                    <td className="small">{s.attempts || "—"}</td>
                    <td className="small">{s.lastAt ? new Date(s.lastAt).toLocaleString() : "—"}</td>
                    <td>{s.bestCorrect == null ? <span className="small">—</span> : <strong>{s.bestCorrect}/{s.total}</strong>}</td>
                    {tickers.map((t) => {
                      const placed = s.bestPlacements?.[t];
                      const correct = placed && placed === data.answerKey[t];
                      return (
                        <td key={t} className={`cell ${!placed ? "cell-none" : correct ? "cell-ok" : "cell-bad"}`}
                          title={!placed ? `${s.name}: ${t} not placed` : `${s.name}: ${t} → ${placed}${correct ? "" : ` (should be ${data.answerKey[t]})`}`}>
                          {!placed ? "" : correct ? "✓" : "✕"}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table></div>
          </div>
        </>
      )}

      <TeacherClassPosts classes={classes} defaultClassId={classId} onModulesChanged={() => { setModuleRevision((value) => value + 1); onDashboardChanged(); }} />
    </div>
  );
}

function BillDraftRow({ draft, students, busy, onSubmit }: { draft: any; students: any[]; busy: boolean; onSubmit: (draft: any, send: boolean) => void }) {
  const [form, setForm] = useState({
    id: draft.id, user_id: draft.user_id, title: draft.title, dollars: (Number(draft.amount_cents) / 100).toFixed(2),
    lateFeeDollars: (Number(draft.late_fee_cents) / 100).toFixed(2), dueDate: String(draft.due_at).slice(0, 10),
    sender: draft.sender || "", documentTitle: draft.document_title || "", documentBody: draft.document_body || "",
  });
  const sent = draft.status === "sent";
  return <tr>
    <td><select disabled={sent || busy} aria-label={`Student for ${draft.title}`} value={form.user_id} onChange={(e) => setForm({ ...form, user_id: e.target.value })}>{students.map((s) => <option value={s.id} key={s.id}>{s.name}</option>)}</select></td>
    <td><input disabled={sent || busy} aria-label={`Title for ${draft.student_name}`} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></td>
    <td><input className="compact-money" disabled={sent || busy} aria-label={`Amount for ${draft.student_name}`} inputMode="decimal" value={form.dollars} onChange={(e) => setForm({ ...form, dollars: e.target.value })} /></td>
    <td><input disabled={sent || busy} aria-label={`Due date for ${draft.student_name}`} type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} /></td>
    <td><span className={sent ? "badge-paid" : "badge-due"}>{sent ? "sent" : "draft"}</span></td>
    <td>{sent ? <span className="small">In mailbox</span> : <div className="row"><button className="ghost" disabled={busy} onClick={() => onSubmit(form, false)}>Save</button><button disabled={busy || !(Number(form.dollars) > 0) || !form.dueDate || form.title.trim().length < 2} onClick={() => onSubmit(form, true)}>Send</button></div>}</td>
  </tr>;
}
