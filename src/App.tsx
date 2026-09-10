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
      <div className="banner">SIMULATED MONEY — FOR CLASS ONLY. Not real investing. No investment advice.</div>
      <div className="wrap">
        <div className="topbar">
          <div className="brand">
            <div className="brand-mark">$</div>
            <div>
              <h1>SimLife Investing</h1>
              <p>Classroom brokerage simulator</p>
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
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  // One idempotency key per form submission; reused across retries.
  const buyKey = useRef(uid());
  const sellKey = useRef(uid());

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

  return (
    <>
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

        <div className="panel">
          <h2>Holdings (simulated)</h2>
          <p className="hint">What you own right now, with gain or loss per holding.</p>
          {!pf?.holdings.length && <p className="small">No holdings yet. Look up a ticker to buy your first simulated shares.</p>}
          {pf && pf.holdings.length > 0 && (
            <div className="table-wrap"><table>
              <thead><tr><th>Ticker</th><th>Shares</th><th>Value</th><th>Gain/Loss</th><th></th></tr></thead>
              <tbody>
                {pf.holdings.map((h) => (
                  <tr key={h.ticker}>
                    <td><strong>{h.ticker}</strong><br /><span className="small">avg {money(h.avgCostCents)}/sh</span></td>
                    <td>{h.shares.toFixed(4)}</td>
                    <td>{money(h.marketCents)}</td>
                    <td className={h.gainLossCents >= 0 ? "up" : "down"}>{money(h.gainLossCents)}</td>
                    <td><button className="ghost" disabled={busy || frozen} onClick={() => submitSell(h, true)}>Sell all</button></td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
          {pf && pf.holdings.length > 0 && (
            <div className="sell-controls">
              <div className="field"><label>Investment</label><select value={sellTicker} onChange={(e) => setSellTicker(e.target.value)}><option value="">Choose a ticker</option>{pf.holdings.map((h) => <option key={h.ticker} value={h.ticker}>{h.ticker} · {h.shares.toFixed(4)} shares</option>)}</select></div>
              <div className="field"><label>Shares to sell</label><input value={sellQty} onChange={(e) => setSellQty(e.target.value)} placeholder="0.25" inputMode="decimal" /></div>
              <button disabled={busy || frozen || !sellTicker || !(Number(sellQty) > 0)} onClick={() => {
                const holding = pf.holdings.find((h) => h.ticker === sellTicker);
                if (holding) submitSell(holding, false);
              }}>Sell selected shares</button>
            </div>
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
    </>
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
    setSelected(roster.find((s) => s.id === id) ?? null); setConfirming(false);
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
      load();
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

  return (
    <>
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
        <p className="hint">Click a row for the student profile (logins, trades, history). Select a student below to adjust simulated cash.</p>
        <div className="roster-tools"><div className="field"><label htmlFor="roster-search">Find a student</label><input id="roster-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name or email" /></div><span className="small">{filtered.length} result{filtered.length === 1 ? "" : "s"}</span></div>
        <div className="table-wrap"><table>
          <thead><tr>{th("Student", "name")}{th("Class", "class")}{th("Cash", "cash")}{th("Invested", "invested")}{th("Portfolio", "portfolio")}{th("Total return", "gain")}{th("Trades", "trades")}{th("Last active", "last")}<th></th></tr></thead>
          <tbody>
            {sorted.map((s) => {
              const ref = refById[s.id];
              const funded = ref && (ref.checking != null || ref.savings != null);
              return (
                <tr key={s.id} style={selected?.id === s.id ? { background: "#eef6f3" } : { cursor: "pointer" }} onClick={() => openProfile(s.id)}>
                  <td><strong>{s.name}</strong><br /><span className="small">{s.email || "no email yet"}{funded && Number(s.cash_cents) === 0 ? " · awaiting funding" : ""}</span></td>
                  <td className="small">{s.class_name || "—"}</td>
                  <td>{money(s.cash_cents)}</td>
                  <td>{money(s.investedCents)}</td>
                  <td>{money(s.portfolioCents)}</td>
                  <td className={s.gainLossCents >= 0 ? "up" : "down"}>{money(s.gainLossCents)}</td>
                  <td>{s.trades}</td>
                  <td className="small">{fmtWhen(s.last_active_at)}</td>
                  <td><button className="ghost" onClick={(e) => { e.stopPropagation(); setSelected(s); setConfirming(false); }}>Select</button></td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
      </div>

      {selected && (
        <div className="panel">
          <h2>Adjust cash — {selected.name} (simulated)</h2>
          <p className="hint">Current simulated cash: {money(selected.cash_cents)}. Removing cash never sells shares — if cash is short, the student must sell first.</p>
          <div className="row">
            <div className="field"><label>Add or remove</label>
              <select value={direction} onChange={(e) => setDirection(e.target.value as any)}>
                <option value="add">Add cash</option>
                <option value="remove">Remove cash</option>
              </select>
            </div>
            <div className="field"><label>Dollars</label><input value={dollars} onChange={(e) => setDollars(e.target.value)} placeholder="50.00" inputMode="decimal" /></div>
          </div>
          <div className="field" style={{ marginTop: 8 }}>
            <label>Reason (required — shown to the student and in the audit log)</label>
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="e.g. Transferred from ClassBank per student's signed slip." />
          </div>
          {!confirming
            ? <div className="row" style={{ marginTop: 8 }}><button disabled={!dollars || reason.trim().length < 3} onClick={() => setConfirming(true)}>Review {direction === "add" ? "deposit" : "withdrawal"}</button></div>
            : (
              <div className="confirm">
                <p><strong>Confirm:</strong> {direction === "add" ? "add" : "remove"} <strong>{money(Math.round(Number(dollars || 0) * 100))}</strong> of simulated cash {direction === "add" ? "to" : "from"} <strong>{selected.name}</strong>?</p>
                <p className="small">Reason: {reason}</p>
                <div className="row">
                  <button disabled={busy} onClick={submitCash}>Yes, record it</button>
                  <button className="ghost" onClick={() => setConfirming(false)}>Cancel</button>
                </div>
              </div>
            )}
        </div>
      )}

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
                <div className="row" style={{ marginTop: 12 }}>
                  <button onClick={() => { setProfileId(null); setSelected(roster.find((s) => s.id === profileId) ?? null); }}>Adjust this student's cash ↓</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
