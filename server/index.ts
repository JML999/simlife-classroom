/**
 * SimLife Investing API. One Express process serves /api and (in production)
 * the built Vite app. Ports, cookie, database, and env vars are all
 * SimLife-specific — nothing shared with CodeWorld.
 */
import "./env.js";
import express from "express";
import cookieParser from "cookie-parser";
import path from "node:path";
import fs from "node:fs";
import { ROOT, validateProductionEnv } from "./env.js";
import { initSchema, ensureColumn, dialect, one, q, run, newId, nowIso } from "./db.js";
import { readSession, setSessionCookie, clearSessionCookie, requireAuth } from "./session.js";
import {
  verifyGoogleToken, isTeacherEmail, googleClientId, allowedDomain,
  demoEnabled, normalizeJoinCode, validateJoinCode, generateJoinCode,
} from "./auth.js";
import {
  adjustCash, reverseCash, buy, sell, holdingsFor, historyFor, checkInvariant,
  LedgerError, MICRO,
} from "./ledger.js";
import {
  postIncome, transfer, payBill, disputeBill, resolveDispute, listDisputes, createBillTemplate, issueIncomeBatch,
  issueBillBatch, bankSummaryFor, checkBankInvariant, BankError,
  adjustBankBalance,
} from "./bank.js";
import { deletionStatus, deleteEmptyStudent, StudentAdminError } from "./student-admin.js";
import {
  importRosterProfiles, onboardingStatus, claimRosterProfile, listRosterProfiles, approveRosterProfile, assignRosterProfile, applyRosterProfile, OnboardingError,
} from "./onboarding.js";
import { makeQuoteProvider, normalizeTicker, QuoteError } from "./quotes.js";
import { ensureDemoUsers, DEMO_IDS } from "./seed.js";
import { createBillDraft, listBillDrafts, sendBillDraft, updateBillDraft } from "./bill-drafts.js";
import {
  createActivity, getActivity, listActivities, setStatus, submit as submitSort,
  attemptsFor, draftFor, saveDraft, progressFor, missesFor, answerKeyFor, SortError,
} from "./sorting.js";
import {
  createClassPost, getClassPost, listClassPosts, setClassPostStatus,
  portfolioMissionState, latestClassPostSubmission, submitPortfolioMission, ClassPostError,
} from "./class-posts.js";
import {
  classModuleCatalog, classModuleKey, hiddenClassModuleKeys, replaceHiddenClassModules,
} from "./class-modules.js";
import { moduleProgress, studentModuleDetail } from "./module-progress.js";
import { leaderboardFor, STABLE_MIN_RETURN_BP } from "./leaderboard.js";
import { ensureLeaderboardFresh } from "./leaderboard-refresh.js";

// Render and similar hosts supply PORT and reach the process over 0.0.0.0.
// Local development stays loopback-only and keeps SimLife on its own port.
const PORT = Number(process.env["PORT"] || process.env["SIMLIFE_PORT"] || 4101);
const HOST = process.env["SIMLIFE_HOST"] || (process.env["NODE_ENV"] === "production" ? "0.0.0.0" : "127.0.0.1");
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error("PORT/SIMLIFE_PORT must be a valid TCP port.");
}
const app = express();
app.use(express.json({ limit: "100kb" }));
app.use(cookieParser());

const quotes = makeQuoteProvider();

// ---------- helpers ----------

async function currentUser(req: express.Request) {
  const s = readSession(req);
  if (!s) return null;
  const user = await one<{ id: string; email: string | null; name: string; role: string; class_id: string | null; job_title: string | null; job_pay_cents: number | null; car_payment_cents: number | null }>(
    `SELECT id, email, name, role, class_id, job_title, job_pay_cents, car_payment_cents FROM users WHERE id = ?`, [s.userId],
  );
  if (!user) return null;
  // Heartbeat: every authenticated request marks the account seen.
  // Powers the teacher roster's "last active" column.
  await run(`UPDATE users SET last_active_at = ? WHERE id = ?`, [nowIso(), user.id]).catch(() => {});
  // Role is authoritative from the DB (set server-side at login).
  return user;
}

/** Teacher authorization is checked against the database on every request.
 * The cookie proves identity; it is not the source of truth for privileges. */
async function requireCurrentTeacher(req: express.Request, res: express.Response, next: express.NextFunction) {
  try {
    const user = await currentUser(req);
    if (!user) { res.status(401).json({ error: "Sign in required." }); return; }
    if (user.role !== "teacher") { res.status(403).json({ error: "Teacher access only." }); return; }
    (req as any).currentUser = user;
    next();
  } catch (err) { next(err); }
}

async function tradingFrozenFor(userId: string): Promise<boolean> {
  const row = await one<{ trading_frozen: number }>(
    `SELECT c.trading_frozen AS trading_frozen FROM users u JOIN classes c ON c.id = u.class_id WHERE u.id = ?`,
    [userId],
  );
  return (row?.trading_frozen ?? 0) === 1;
}

function ledgerError(res: express.Response, err: unknown) {
  if (err instanceof LedgerError) {
    const status =
      err.code === "INSUFFICIENT_CASH" || err.code === "INSUFFICIENT_SHARES" ? 422
      : err.code === "TRADING_FROZEN" ? 423
      : err.code === "NOT_FOUND" ? 404
      : 400;
    res.status(status).json({ error: err.message, code: err.code });
    return;
  }
  throw err;
}

// ---------- public ----------

app.get("/api/health", async (_req, res) => {
  try {
    await one(`SELECT 1 AS ok`);
    res.json({ ok: true, app: "simlife-investing", quotes: quotes.providerName });
  } catch (e) {
    res.status(503).json({ ok: false });
  }
});

app.get("/api/auth/config", (_req, res) => {
  res.json({
    googleClientId: googleClientId(),
    domain: allowedDomain(),
    demoEnabled: demoEnabled(),
  });
});

app.post("/api/auth/google", async (req, res) => {
  const identity = await verifyGoogleToken(req.body?.credential);
  if (!identity) { res.status(401).json({ error: "Google sign-in failed. Use your school account." }); return; }
  const role = isTeacherEmail(identity.email) ? "teacher" : "student";
  const now = nowIso();
  let user = await one<{ id: string; role: string }>(`SELECT id, role FROM users WHERE google_sub = ?`, [identity.sub]);
  if (!user) {
    user = await one<{ id: string; role: string }>(
      `SELECT u.id, u.role FROM user_aliases a JOIN users u ON u.id = a.user_id
       WHERE a.google_sub = ? OR (a.email IS NOT NULL AND a.email = ?) LIMIT 1`,
      [identity.sub, identity.email],
    );
  }
  if (!user) {
    const byEmail = identity.email
      ? await one<{ id: string }>(`SELECT id FROM users WHERE email = ?`, [identity.email])
      : undefined;
    const id = byEmail?.id ?? newId("u");
    if (byEmail) {
      await run(`UPDATE users SET google_sub = ?, name = ?, role = ?, last_active_at = ? WHERE id = ?`, [identity.sub, identity.name, role, now, id]);
    } else {
      await run(`INSERT INTO users (id, email, name, role, google_sub, created_at, last_active_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, identity.email, identity.name, role, identity.sub, now, now]);
    }
    user = { id, role };
  } else if (user.role !== role) {
    await run(`UPDATE users SET role = ? WHERE id = ?`, [role, user.id]);
    user.role = role;
  }
  setSessionCookie(res, { userId: user.id, role: user.role as "student" | "teacher" });
  res.json({ ok: true, role: user.role });
});

app.post("/api/auth/demo", async (req, res) => {
  if (!demoEnabled()) { res.status(404).json({ error: "Not found." }); return; }
  const id = String(req.body?.userId || "");
  const user = await one<{ id: string; role: string; name: string }>(
    `SELECT id, role, name FROM users WHERE id = ?`, [id],
  );
  if (!user || !(DEMO_IDS as readonly string[]).includes(id)) {
    res.status(404).json({ error: "Unknown demo user." });
    return;
  }
  await run(`UPDATE users SET last_active_at = ? WHERE id = ?`, [nowIso(), user.id]).catch(() => {});
  setSessionCookie(res, { userId: user.id, role: user.role as "student" | "teacher" });
  res.json({ ok: true, role: user.role, name: user.name });
});

app.post("/api/auth/logout", (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

if (demoEnabled()) {
  app.get("/api/demo/users", async (_req, res) => {
    const users = await q<{ id: string; name: string; role: string }>(
      `SELECT id, name, role FROM users WHERE id LIKE 'demo-%' ORDER BY id`,
    );
    res.json({ users });
  });
  // Demo-only price override ("what if it goes up?"). The mock provider is
  // the only one that supports it; the cache is cleared so the next quote
  // reflects the new price. Unreachable in production (404 like demo login).
  app.post("/api/demo/quote", async (req, res) => {
    const inner = quotes.provider;
    if (inner.name !== "mock" || typeof (inner as any).setPrice !== "function") {
      res.status(409).json({ error: "Price override needs the mock provider." });
      return;
    }
    const cents = Math.round(Number(req.body?.priceCents));
    if (!Number.isFinite(cents) || cents <= 0 || cents > 100000000) {
      res.status(400).json({ error: "priceCents must be a positive integer of cents." });
      return;
    }
    try {
      const ticker = normalizeTicker(req.body?.ticker);
      (inner as any).setPrice(ticker, cents);
      quotes.clear();
      const { quote } = await quotes.getQuote(ticker);
      res.json({ ok: true, quote });
    } catch (err) {
      if (err instanceof QuoteError) { res.status(404).json({ error: err.message }); return; }
      throw err;
    }
  });
}

// ---------- student ----------

app.get("/api/me", requireAuth, async (req, res) => {
  const user = await currentUser(req);
  if (!user) { res.status(401).json({ error: "Sign in required." }); return; }
  const cls = user.class_id
    ? await one(`SELECT id, name, join_code, trading_frozen FROM classes WHERE id = ?`, [user.class_id])
    : null;
  res.json({ user: { id: user.id, email: user.email, name: user.name, role: user.role, job_title: user.job_title ?? null, job_pay_cents: user.job_pay_cents ?? null, car_payment_cents: user.car_payment_cents ?? null }, class: cls });
});

app.post("/api/classes/join", requireAuth, async (req, res) => {
  const user = await currentUser(req);
  if (!user) { res.status(401).json({ error: "Sign in required." }); return; }
  const code = normalizeJoinCode(req.body?.code);
  if (!validateJoinCode(code)) { res.status(400).json({ error: "Enter the 4–12 character join code from your teacher." }); return; }
  const cls = await one<{ id: string; name: string }>(`SELECT id, name FROM classes WHERE join_code = ?`, [code]);
  if (!cls) { res.status(404).json({ error: "No class uses that code. Check with your teacher." }); return; }
  await run(`UPDATE users SET class_id = ? WHERE id = ?`, [cls.id, user.id]);
  res.json({ ok: true, class: cls });
});

function onboardingError(res: express.Response, err: unknown) {
  if (err instanceof OnboardingError) {
    const status = err.code === "NOT_FOUND" ? 404 : err.code === "FORBIDDEN" ? 403 : err.code === "CONFLICT" ? 409 : 400;
    res.status(status).json({ error: err.message, code: err.code });
    return;
  }
  throw err;
}

app.get("/api/onboarding", requireAuth, async (req, res) => {
  const user = await currentUser(req);
  if (!user || user.role !== "student") { res.status(403).json({ error: "Student access only." }); return; }
  res.json(await onboardingStatus(user.id));
});

app.post("/api/onboarding/claim", requireAuth, async (req, res) => {
  const user = await currentUser(req);
  if (!user || user.role !== "student") { res.status(403).json({ error: "Student access only." }); return; }
  try {
    res.json(await claimRosterProfile({ userId: user.id, profileId: String(req.body?.profileId || ""), proposed: req.body?.proposed }));
  } catch (err) { onboardingError(res, err); }
});

app.get("/api/search", requireAuth, async (req, res) => {
  const results = await quotes.search(String(req.query["q"] || ""));
  res.json({ results, delayed: true });
});

app.get("/api/quotes", requireAuth, async (req, res) => {
  try {
    const { quote, cached } = await quotes.getQuote(String(req.query["symbol"] || ""));
    res.json({ quote, cached, delayed: quote.delayed });
  } catch (err) {
    if (err instanceof QuoteError) {
      const status = err.code === "NOT_FOUND" || err.code === "INVALID_TICKER" ? 404 : 503;
      res.status(status).json({ error: err.message, code: err.code });
      return;
    }
    throw err;
  }
});

async function portfolioFor(userId: string) {
  // Batch current prices (mock is sync-fast; live path is cached server-side).
  const { holdings, cashCents } = await holdingsFor(userId, () => null);
  let invested = 0;
  let value = cashCents;
  const enriched = [];
  for (const h of holdings) {
    let price: number | null = null;
    try { price = (await quotes.getQuote(h.ticker)).quote.priceCents; } catch { price = null; }
    const market = price == null ? h.costBasisCents : Math.round((h.qtyMicro * price) / MICRO);
    invested += h.costBasisCents;
    value += market;
    enriched.push({ ...h, priceCents: price, marketCents: market, gainLossCents: market - h.costBasisCents });
  }
  const funding = await one<{ net_funding: number }>(
    `SELECT COALESCE(SUM(CASE WHEN l.kind IN ('cash_adjust','cash_reversal') THEN l.amount_cents ELSE 0 END), 0) AS net_funding
     FROM ledger l JOIN accounts ac ON ac.id = l.account_id WHERE ac.user_id = ?`,
    [userId],
  );
  const unrealizedGainLoss = value - cashCents - invested;
  const gainLoss = value - Number(funding?.net_funding ?? 0);
  return {
    cashCents,
    investedCents: invested,
    portfolioCents: value,
    gainLossCents: gainLoss,
    unrealizedGainLossCents: unrealizedGainLoss,
    realizedGainLossCents: gainLoss - unrealizedGainLoss,
    holdings: enriched,
    quotesDelayed: true,
    quoteSource: quotes.providerName,
  };
}

app.get("/api/portfolio", requireAuth, async (req, res) => {
  const user = await currentUser(req);
  if (!user) { res.status(401).json({ error: "Sign in required." }); return; }
  res.json(await portfolioFor(user.id));
});

app.get("/api/history", requireAuth, async (req, res) => {
  const user = await currentUser(req);
  if (!user) { res.status(401).json({ error: "Sign in required." }); return; }
  res.json({ entries: await historyFor(user.id) });
});

app.post("/api/trades/buy", requireAuth, async (req, res) => {
  const user = await currentUser(req);
  if (!user) { res.status(401).json({ error: "Sign in required." }); return; }
  if (user.role !== "student") { res.status(403).json({ error: "Teachers cannot trade." }); return; }
  try {
    const ticker = normalizeTicker(req.body?.ticker);
    const { quote } = await quotes.getQuote(ticker);
    const qtyMicro = req.body?.qtyMicro !== undefined ? Math.floor(Number(req.body.qtyMicro)) : undefined;
    const dollarsCents = req.body?.dollarsCents !== undefined ? Math.floor(Number(req.body.dollarsCents)) : undefined;
    const frozen = await tradingFrozenFor(user.id);
    const r = await buy({
      userId: user.id, ticker, qtyMicro, dollarsCents,
      priceCents: quote.priceCents, quoteTs: quote.asOf, quoteSource: quote.source,
      idempotencyKey: String(req.body?.idempotencyKey || ""),
      tradingFrozen: frozen,
    });
    res.json({ ok: true, deduped: r.deduped, entry: r.entry, qtyMicro: r.qtyMicro, costCents: r.costCents, portfolio: await portfolioFor(user.id) });
  } catch (err) {
    if (err instanceof QuoteError) { res.status(err.code === "UNAVAILABLE" ? 503 : 404).json({ error: err.message, code: err.code }); return; }
    ledgerError(res, err);
  }
});

app.post("/api/trades/sell", requireAuth, async (req, res) => {
  const user = await currentUser(req);
  if (!user) { res.status(401).json({ error: "Sign in required." }); return; }
  if (user.role !== "student") { res.status(403).json({ error: "Teachers cannot trade." }); return; }
  try {
    const ticker = normalizeTicker(req.body?.ticker);
    const { quote } = await quotes.getQuote(ticker);
    const frozen = await tradingFrozenFor(user.id);
    const r = await sell({
      userId: user.id, ticker,
      qtyMicro: req.body?.qtyMicro !== undefined ? Math.floor(Number(req.body.qtyMicro)) : undefined,
      sellAll: req.body?.sellAll === true,
      priceCents: quote.priceCents, quoteTs: quote.asOf, quoteSource: quote.source,
      idempotencyKey: String(req.body?.idempotencyKey || ""),
      tradingFrozen: frozen,
    });
    res.json({ ok: true, deduped: r.deduped, entry: r.entry, qtyMicro: r.qtyMicro, proceedsCents: r.proceedsCents, portfolio: await portfolioFor(user.id) });
  } catch (err) {
    if (err instanceof QuoteError) { res.status(err.code === "UNAVAILABLE" ? 503 : 404).json({ error: err.message, code: err.code }); return; }
    ledgerError(res, err);
  }
});

// ---------- teacher ----------

app.get("/api/teacher/roster", requireCurrentTeacher, async (req, res) => {
  const classId = String(req.query["classId"] || "");
  const students = await q(
    `SELECT u.id, u.name, u.email, u.class_id, u.created_at, u.last_active_at,
            u.job_title, u.job_pay_cents,
            c.name AS class_name, c.trading_frozen,
            ac.id AS account_id, COALESCE(ac.cash_cents, 0) AS cash_cents
     FROM users u LEFT JOIN classes c ON c.id = u.class_id
     LEFT JOIN accounts ac ON ac.user_id = u.id
     WHERE u.role = 'student' ${classId ? "AND u.class_id = ?" : ""}
     ORDER BY u.name`,
    classId ? [classId] : [],
  );
  // Batched enrichment: ONE aggregate query for every student's share legs
  // (was: N sequential portfolio computations × several round-trips each —
  // the lag when switching classes).
  const acctIds = (students as any[]).map((s) => s.account_id).filter(Boolean);
  let legs: any[] = [];
  let fundingRows: any[] = [];
  if (acctIds.length) {
    const d = await dialect();
    const where = d === "pg" ? `WHERE account_id = ANY(?)` : `WHERE account_id IN (${acctIds.map(() => "?").join(",")})`;
    legs = await q(
      `SELECT account_id, ticker,
         COALESCE(SUM(CASE WHEN kind = 'buy' THEN qty_micro ELSE 0 END), 0) AS buy_qty,
         COALESCE(SUM(CASE WHEN kind = 'buy' THEN -amount_cents ELSE 0 END), 0) AS buy_cost,
         COALESCE(SUM(CASE WHEN kind = 'sell' THEN -qty_micro ELSE 0 END), 0) AS sell_qty,
         COALESCE(SUM(CASE WHEN kind IN ('buy','sell') THEN 1 ELSE 0 END), 0) AS trades
       FROM ledger ${where} AND ticker IS NOT NULL GROUP BY account_id, ticker`,
      d === "pg" ? [acctIds] : acctIds,
    );
    fundingRows = await q(
      `SELECT account_id, COALESCE(SUM(CASE WHEN kind IN ('cash_adjust','cash_reversal') THEN amount_cents ELSE 0 END), 0) AS net_funding
       FROM ledger ${where} GROUP BY account_id`,
      d === "pg" ? [acctIds] : acctIds,
    );
  }
  const tickers = [...new Set(legs.map((l) => l.ticker))];
  const prices = new Map<string, number>();
  await Promise.all(tickers.map(async (t) => {
    try { prices.set(t, (await quotes.getQuote(t)).quote.priceCents); } catch { /* unknown → basis */ }
  }));
  const byAccount = new Map<string, { invested: number; market: number }>();
  const tradeCounts = new Map<string, number>();
  for (const l of legs) {
    tradeCounts.set(l.account_id, (tradeCounts.get(l.account_id) ?? 0) + Number(l.trades));
  }
  const fundingByAccount = new Map(fundingRows.map((r) => [r.account_id, Number(r.net_funding)]));
  for (const l of legs) {
    const remaining = Number(l.buy_qty) - Number(l.sell_qty);
    if (remaining <= 0) continue;
    const avgPerMicro = Number(l.buy_qty) > 0 ? Number(l.buy_cost) / Number(l.buy_qty) : 0;
    const basis = Math.round(avgPerMicro * remaining);
    const price = prices.get(l.ticker);
    const market = price == null ? basis : Math.round((remaining * price) / MICRO);
    const cur = byAccount.get(l.account_id) ?? { invested: 0, market: 0 };
    cur.invested += basis; cur.market += market;
    byAccount.set(l.account_id, cur);
  }
  const out = (students as any[]).map((s) => {
    const agg = byAccount.get(s.account_id) ?? { invested: 0, market: 0 };
    const portfolioCents = Number(s.cash_cents) + agg.market;
    return {
      ...s,
      investedCents: agg.invested,
      portfolioCents,
      gainLossCents: portfolioCents - (fundingByAccount.get(s.account_id) ?? 0),
      trades: tradeCounts.get(s.account_id) ?? 0,
    };
  });
  res.json({ students: out });
});

app.get("/api/teacher/classes", requireCurrentTeacher, async (_req, res) => {
  res.json({ classes: await q(`SELECT c.*, (SELECT COUNT(*) FROM users u WHERE u.class_id = c.id AND u.role = 'student') AS students FROM classes c ORDER BY c.created_at`) });
});

app.get("/api/teacher/onboarding", requireCurrentTeacher, async (req, res) => {
  res.json({ profiles: await listRosterProfiles(String(req.query["classId"] || "") || undefined) });
});

app.post("/api/teacher/onboarding/import", requireCurrentTeacher, async (req, res) => {
  const teacher = (req as any).currentUser;
  try {
    res.json(await importRosterProfiles({
      classId: String(req.body?.classId || ""), actorId: teacher.id,
      sourceLabel: String(req.body?.sourceLabel || ""), importKey: String(req.body?.importKey || ""), rows: req.body?.rows,
    }));
  } catch (err) { onboardingError(res, err); }
});

app.post("/api/teacher/onboarding/:id/approve", requireCurrentTeacher, async (req, res) => {
  const teacher = (req as any).currentUser;
  try { res.json(await approveRosterProfile({ profileId: String(req.params.id || ""), actorId: teacher.id })); }
  catch (err) { onboardingError(res, err); }
});

app.post("/api/teacher/onboarding/:id/assign", requireCurrentTeacher, async (req, res) => {
  const teacher = (req as any).currentUser;
  try { res.json(await assignRosterProfile({ profileId: String(req.params.id || ""), userId: String(req.body?.studentId || ""), actorId: teacher.id })); }
  catch (err) { onboardingError(res, err); }
});

app.post("/api/teacher/onboarding/:id/apply", requireCurrentTeacher, async (req, res) => {
  const teacher = (req as any).currentUser;
  try { res.json(await applyRosterProfile({ profileId: String(req.params.id || ""), actorId: teacher.id })); }
  catch (err) { onboardingError(res, err); }
});

app.post("/api/teacher/classes", requireCurrentTeacher, async (req, res) => {
  const name = String(req.body?.name || "").trim();
  if (name.length < 2 || name.length > 80) { res.status(400).json({ error: "Class name must be 2–80 characters." }); return; }
  let code = normalizeJoinCode(req.body?.joinCode || generateJoinCode());
  if (!validateJoinCode(code)) { res.status(400).json({ error: "Join code must be 4–12 letters/digits." }); return; }
  const id = newId("cls");
  try {
    await run(`INSERT INTO classes (id, name, join_code, trading_frozen, created_at) VALUES (?, ?, ?, 0, ?)`,
      [id, name, code, nowIso()]);
  } catch {
    res.status(409).json({ error: "That join code is taken. Pick another." });
    return;
  }
  res.json({ ok: true, class: { id, name, join_code: code } });
});

app.post("/api/teacher/freeze", requireCurrentTeacher, async (req, res) => {
  const classId = String(req.body?.classId || "");
  const frozen = req.body?.frozen === true ? 1 : 0;
  const n = await run(`UPDATE classes SET trading_frozen = ? WHERE id = ?`, [frozen, classId]);
  if (!n) { res.status(404).json({ error: "Class not found." }); return; }
  res.json({ ok: true, frozen });
});

app.post("/api/teacher/cash", requireCurrentTeacher, async (req, res) => {
  const teacher = (req as any).currentUser;
  try {
    const studentId = String(req.body?.studentId || "");
    const student = await one<{ id: string; role: string }>(`SELECT id, role FROM users WHERE id = ?`, [studentId]);
    if (!student || student.role !== "student") { res.status(404).json({ error: "Student not found." }); return; }
    const dollars = Number(req.body?.dollars);
    if (!Number.isFinite(dollars) || dollars === 0 || Math.abs(dollars) > 100000) {
      res.status(400).json({ error: "Enter a non-zero dollar amount (max $100,000)." });
      return;
    }
    const amountCents = Math.round(dollars * 100);
    const r = await adjustCash({
      userId: studentId, actorId: teacher.id, amountCents,
      reason: String(req.body?.reason || ""),
      idempotencyKey: String(req.body?.idempotencyKey || ""),
    });
    res.json({ ok: true, deduped: r.deduped, entry: r.entry, portfolio: await portfolioFor(studentId) });
  } catch (err) { ledgerError(res, err); }
});

app.post("/api/teacher/cash/reverse", requireCurrentTeacher, async (req, res) => {
  const teacher = (req as any).currentUser;
  try {
    const r = await reverseCash({
      entryId: String(req.body?.entryId || ""),
      actorId: teacher.id,
      reason: String(req.body?.reason || ""),
      idempotencyKey: String(req.body?.idempotencyKey || ""),
    });
    res.json({ ok: true, deduped: r.deduped, entry: r.entry });
  } catch (err) { ledgerError(res, err); }
});

app.get("/api/teacher/audit", requireCurrentTeacher, async (req, res) => {
  const classId = String(req.query["classId"] || "");
  const studentId = String(req.query["studentId"] || "");
  const rows = await q(
    `SELECT l.*, u.name AS student_name, a.name AS actor_name
     FROM ledger l
     JOIN accounts ac ON ac.id = l.account_id
     JOIN users u ON u.id = ac.user_id
     LEFT JOIN users a ON a.id = l.actor_id
     ${studentId ? "WHERE u.id = ?" : classId ? "WHERE u.class_id = ?" : "WHERE 1=1"}
     ORDER BY l.created_at DESC LIMIT 500`,
    studentId ? [studentId] : classId ? [classId] : [],
  );
  // SQLite quirk note (resolved): actor name comes from users.name via alias.
  res.json({ entries: rows });
});

app.get("/api/teacher/student", requireCurrentTeacher, async (req, res) => {
  const studentId = String(req.query["studentId"] || "");
  const student = await one(`SELECT id, name, email, class_id, created_at, last_active_at, job_title, job_pay_cents, car_payment_cents, rent_cents, job_updated_at FROM users WHERE id = ? AND role = 'student'`, [studentId]);
  if (!student) { res.status(404).json({ error: "Student not found." }); return; }
  const counts = await q<{ kind: string; n: number }>(
    `SELECT l.kind AS kind, COUNT(*) AS n FROM ledger l
     JOIN accounts ac ON ac.id = l.account_id WHERE ac.user_id = ? GROUP BY l.kind`, [studentId],
  );
  const totals = await one<{ added: number; removed: number }>(
    `SELECT COALESCE(SUM(CASE WHEN l.amount_cents > 0 AND l.kind IN ('cash_adjust','cash_reversal') THEN l.amount_cents ELSE 0 END), 0) AS added,
            COALESCE(SUM(CASE WHEN l.amount_cents < 0 AND l.kind IN ('cash_adjust','cash_reversal') THEN -l.amount_cents ELSE 0 END), 0) AS removed
     FROM ledger l JOIN accounts ac ON ac.id = l.account_id WHERE ac.user_id = ?`, [studentId],
  );
  res.json({ student, counts, totals, portfolio: await portfolioFor(studentId), history: await historyFor(studentId), invariant: await checkInvariant(studentId), bank: await bankSummaryFor(studentId), bankInvariant: await checkBankInvariant(studentId), deletion: await deletionStatus(studentId), modules: await studentModuleDetail(studentId) });
});

// Roster feed for the main dashboard: started / submitted counts per student.
app.get("/api/teacher/module-progress", requireCurrentTeacher, async (req, res) => {
  const classId = typeof req.query["classId"] === "string" && req.query["classId"] ? String(req.query["classId"]) : null;
  res.json(await moduleProgress(classId));
});

app.patch("/api/teacher/student", requireCurrentTeacher, async (req, res) => {
  const studentId = String(req.body?.studentId || "");
  const name = String(req.body?.name || "").trim();
  const classId = req.body?.classId == null ? null : String(req.body.classId);
  if (name.length < 2 || name.length > 100) { res.status(400).json({ error: "Student name must be 2–100 characters." }); return; }
  if (classId && !(await one(`SELECT id FROM classes WHERE id = ?`, [classId]))) { res.status(404).json({ error: "Class not found." }); return; }
  const n = await run(`UPDATE users SET name = ?, class_id = ? WHERE id = ? AND role = 'student'`, [name, classId, studentId]);
  if (!n) { res.status(404).json({ error: "Student not found." }); return; }
  res.json({ ok: true });
});

function parseJobPay(raw: unknown): number | null | undefined {
  // undefined = not supplied (leave unchanged); null = clear; number = set (cents).
  if (raw === undefined) return undefined;
  if (raw === null || raw === "") return null;
  const dollars = typeof raw === "number" ? raw : Number(String(raw).replace(/[$,]/g, ""));
  if (!Number.isFinite(dollars) || dollars < 0 || dollars > 100000) return undefined;
  return Math.round(dollars * 100);
}

/** Teacher sets/clears a student's job + per-paycheck pay. */
app.post("/api/teacher/student/job", requireCurrentTeacher, async (req, res) => {
  const studentId = String(req.body?.studentId || "");
  const rawTitle = req.body?.jobTitle;
  const jobTitle = rawTitle == null ? null : String(rawTitle).trim();
  if (jobTitle !== null && (jobTitle.length < 2 || jobTitle.length > 80)) {
    res.status(400).json({ error: "Job title must be 2–80 characters (or empty to clear)." });
    return;
  }
  // Accept pay as dollars (jobPayDollars / jobPay) or integer cents (jobPayCents).
  let pay: number | null | undefined;
  if (req.body?.jobPayCents !== undefined) {
    const c = req.body.jobPayCents;
    if (c === null || c === "") pay = null;
    else if (!Number.isInteger(c) || c < 0 || c > 10000000) {
      res.status(400).json({ error: "Pay must be between $0 and $100,000 per paycheck (or empty to clear)." });
      return;
    } else pay = c;
  } else if (req.body?.jobPayDollars !== undefined || req.body?.jobPay !== undefined) {
    pay = parseJobPay(req.body?.jobPayDollars ?? req.body?.jobPay);
    if (pay === undefined) {
      res.status(400).json({ error: "Pay must be between $0 and $100,000 per paycheck (or empty to clear)." });
      return;
    }
  }
  let carPayment: number | null | undefined;
  if (req.body?.carPaymentDollars !== undefined) {
    carPayment = parseJobPay(req.body.carPaymentDollars);
    if (carPayment === undefined) { res.status(400).json({ error: "Car payment must be between $0 and $100,000 per month (or empty to clear)." }); return; }
  }
  let rent: number | null | undefined;
  if (req.body?.rentDollars !== undefined) {
    rent = parseJobPay(req.body.rentDollars);
    if (rent === undefined) { res.status(400).json({ error: "Rent must be between $0 and $100,000 per month (or empty to clear)." }); return; }
  }
  const student = await one<{ id: string }>(`SELECT id FROM users WHERE id = ? AND role = 'student'`, [studentId]);
  if (!student) { res.status(404).json({ error: "Student not found." }); return; }
  const sets: string[] = [];
  const params: unknown[] = [];
  if (rawTitle !== undefined) {
    sets.push(`job_title = ?`);
    params.push(jobTitle && jobTitle.length ? jobTitle : null);
  }
  if (pay !== undefined) {
    sets.push(`job_pay_cents = ?`);
    params.push(pay);
  }
  if (carPayment !== undefined) {
    sets.push(`car_payment_cents = ?`);
    params.push(carPayment);
  }
  if (rent !== undefined) {
    sets.push(`rent_cents = ?`);
    params.push(rent);
  }
  if (!sets.length) { res.status(400).json({ error: "No job changes supplied." }); return; }
  sets.push(`job_updated_at = ?`);
  params.push(nowIso());
  params.push(studentId);
  await run(`UPDATE users SET ${sets.join(", ")} WHERE id = ? AND role = 'student'`, params);
  const updated = await one(`SELECT id, name, job_title, job_pay_cents, car_payment_cents, rent_cents, job_updated_at FROM users WHERE id = ?`, [studentId]);
  res.json({ ok: true, student: updated });
});

/** Prepopulated job titles for a period: ClassBank snapshot + any teacher-set custom titles. */
app.get("/api/teacher/job-catalog", requireCurrentTeacher, async (req, res) => {
  const classId = String(req.query["classId"] || "");
  const file = classId === "class-p3-2026" ? "third-period.json" : classId === "class-p4-2026" ? "fourth-period.json" : null;
  const titles = new Map<string, { title: string; source: string }>();
  if (file) {
    try {
      const raw = fs.readFileSync(path.join(ROOT, "server", "seed-data", file), "utf8");
      const data = JSON.parse(raw);
      for (const s of data.students || []) {
        const t = String(s.job || "").trim();
        if (t && t.length >= 2 && !titles.has(t.toLowerCase())) titles.set(t.toLowerCase(), { title: t, source: "period" });
      }
    } catch { /* fall through to DB titles */ }
  } else {
    // No class filter: merge both periods so "All students" still offers every title.
    for (const f of ["third-period.json", "fourth-period.json"]) {
      try {
        const raw = fs.readFileSync(path.join(ROOT, "server", "seed-data", f), "utf8");
        const data = JSON.parse(raw);
        for (const s of data.students || []) {
          const t = String(s.job || "").trim();
          if (t && t.length >= 2 && !titles.has(t.toLowerCase())) titles.set(t.toLowerCase(), { title: t, source: "period" });
        }
      } catch { /* ignore */ }
    }
  }
  try {
    const rows = classId
      ? await q<{ job_title: string }>(`SELECT DISTINCT job_title FROM users WHERE role = 'student' AND class_id = ? AND job_title IS NOT NULL`, [classId])
      : await q<{ job_title: string }>(`SELECT DISTINCT job_title FROM users WHERE role = 'student' AND job_title IS NOT NULL`);
    for (const r of rows) {
      const t = String(r.job_title || "").trim();
      if (t && !titles.has(t.toLowerCase())) titles.set(t.toLowerCase(), { title: t, source: "custom" });
    }
  } catch { /* job columns may predate migration on a stale boot; snapshot titles still work */ }
  res.json({ jobs: [...titles.values()].sort((a, b) => a.title.localeCompare(b.title)) });
});

app.post("/api/teacher/bank/adjust", requireCurrentTeacher, async (req, res) => {
  const teacher = (req as any).currentUser;
  try {
    const dollars = Number(req.body?.dollars);
    if (!Number.isFinite(dollars) || dollars === 0 || Math.abs(dollars) > 100000) { res.status(400).json({ error: "Enter a non-zero dollar amount (max $100,000)." }); return; }
    const result = await adjustBankBalance({
      userId: String(req.body?.studentId || ""), actorId: teacher.id,
      account: String(req.body?.account || "") as "checking" | "savings",
      amountCents: Math.round(dollars * 100), reason: String(req.body?.reason || ""),
      idempotencyKey: String(req.body?.idempotencyKey || ""),
    });
    res.json({ ok: true, ...result });
  } catch (err) { bankError(res, err); }
});

app.delete("/api/teacher/students/:id", requireCurrentTeacher, async (req, res) => {
  try {
    res.json(await deleteEmptyStudent({ userId: String(req.params.id || ""), confirmation: String(req.body?.confirmation || "") }));
  } catch (err) {
    if (err instanceof StudentAdminError) { res.status(err.code === "NOT_FOUND" ? 404 : err.code === "HAS_ACTIVITY" ? 409 : 400).json({ error: err.message, code: err.code }); return; }
    throw err;
  }
});

/** ClassBank reference snapshot (teacher-only): the pasted checking/savings
 *  figures next to live brokerage balances, for approving starting amounts. */
app.get("/api/teacher/reference", requireCurrentTeacher, async (req, res) => {
  const classId = String(req.query["classId"] || "");
  const file = classId === "class-p3-2026" ? "third-period.json" : classId === "class-p4-2026" ? "fourth-period.json" : null;
  if (!file) { res.json({ students: [] }); return; }
  try {
    const raw = fs.readFileSync(path.join(ROOT, "server", "seed-data", file), "utf8");
    const data = JSON.parse(raw);
    res.json({ students: data.students });
  } catch {
    res.json({ students: [] });
  }
});

// ---------- banking (student) ----------

function bankError(res: express.Response, err: unknown) {
  if (err instanceof BankError) {
    const status =
      err.code === "INSUFFICIENT_FUNDS" ? 422
      : err.code === "NOT_FOUND" ? 404
      : err.code === "NOT_YOUR_BILL" ? 403
      : err.code === "IDEMPOTENCY_CONFLICT" || err.code === "ALREADY_PAID" || err.code === "ALREADY_RESOLVED" ? 409
      : 400;
    res.status(status).json({ error: err.message, code: err.code });
    return;
  }
  throw err;
}

// ---- Class: sector sort activity ------------------------------------------
// Students file a basket of tickers into sector buckets. Practice, not a test:
// retries are allowed and every attempt is kept.

app.get("/api/class/activities", requireAuth, async (req, res) => {
  const user = await currentUser(req);
  if (!user) { res.status(401).json({ error: "Sign in required." }); return; }
  const acts = await listActivities({ classId: user.class_id, publishedOnly: true });
  const [catalog, hidden] = await Promise.all([
    classModuleCatalog(user.class_id), hiddenClassModuleKeys(user.class_id),
  ]);
  const moduleNumbers = new Map(catalog.map((item) => [item.key, item.moduleNumber]));
  const out = [];
  for (const a of acts) {
    const key = classModuleKey("sort", a.id);
    if (hidden.has(key)) continue;
    const attempts = await attemptsFor(a.id, user.id);
    // Grading stays teacher-side: students only learn whether they submitted.
    const last = attempts.reduce((b: any, r: any) => (!b || r.attempt_no > b.attempt_no ? r : b), null);
    const draft = attempts.length ? null : await draftFor(a.id, user.id);
    out.push({
      id: a.id, title: a.title, prompt: a.prompt,
      tokenCount: a.tokens.length, bucketCount: a.buckets.length,
      attempts: attempts.length,
      submittedAt: last ? last.created_at : null,
      hasDraft: !!draft,
      createdAt: a.createdAt,
      moduleNumber: moduleNumbers.get(key),
    });
  }
  res.json({ activities: out });
});

app.get("/api/class/activities/:id", requireAuth, async (req, res) => {
  const user = await currentUser(req);
  if (!user) { res.status(401).json({ error: "Sign in required." }); return; }
  const act = await getActivity(String(req.params["id"]));
  // An unpublished or other-class activity is reported as missing, not
  // forbidden: an unannounced assignment should not be discoverable.
  if (!act || act.status !== "published" || (act.classId && act.classId !== user.class_id)) {
    res.status(404).json({ error: "Activity not found." }); return;
  }
  const attempts = await attemptsFor(act.id, user.id);
  const draft = await draftFor(act.id, user.id);
  // No scores or correctness here — the teacher does the checking.
  res.json({
    id: act.id, title: act.title, prompt: act.prompt,
    buckets: act.buckets, tokens: act.tokens,
    attempts: attempts.map((a: any) => ({
      attemptNo: a.attempt_no,
      placements: JSON.parse(a.placements), createdAt: a.created_at,
    })),
    draft: draft ?? null,
  });
});

app.post("/api/class/activities/:id/draft", requireAuth, async (req, res) => {
  const user = await currentUser(req);
  if (!user) { res.status(401).json({ error: "Sign in required." }); return; }
  if (user.role !== "student") { res.status(403).json({ error: "Teachers do not save drafts." }); return; }
  const act = await getActivity(String(req.params["id"]));
  if (!act || (act.classId && act.classId !== user.class_id)) { res.status(404).json({ error: "Activity not found." }); return; }
  try {
    const d = await saveDraft({
      activityId: act.id, userId: user.id, placements: req.body?.placements ?? {},
    });
    res.json({ savedAt: d.updatedAt, placed: Object.keys(d.placements).length });
  } catch (err) {
    if (err instanceof SortError) { res.status(err.code === "NOT_FOUND" ? 404 : 400).json({ error: err.message }); return; }
    throw err;
  }
});

app.post("/api/class/activities/:id/submit", requireAuth, async (req, res) => {
  const user = await currentUser(req);
  if (!user) { res.status(401).json({ error: "Sign in required." }); return; }
  if (user.role !== "student") { res.status(403).json({ error: "Teachers do not submit activities." }); return; }
  const act = await getActivity(String(req.params["id"]));
  if (!act || (act.classId && act.classId !== user.class_id)) { res.status(404).json({ error: "Activity not found." }); return; }
  try {
    const result = await submitSort({
      activityId: act.id, userId: user.id,
      placements: req.body?.placements ?? {},
      idempotencyKey: typeof req.body?.idempotencyKey === "string" ? req.body.idempotencyKey : undefined,
    });
    // Grading is recorded for the teacher dashboard but never sent to the
    // student: a submit means "I'm done, please check it."
    const attempts = await attemptsFor(act.id, user.id);
    const saved = attempts.find((a: any) => a.attempt_no === result.attemptNo) ?? attempts[0];
    res.json({
      attemptNo: result.attemptNo,
      totalCount: result.totalCount,
      deduped: result.deduped,
      submittedAt: saved ? saved.created_at : new Date().toISOString(),
    });
  } catch (err) {
    if (err instanceof SortError) { res.status(err.code === "NOT_FOUND" ? 404 : 400).json({ error: err.message }); return; }
    throw err;
  }
});

app.get("/api/teacher/activities", requireCurrentTeacher, async (_req, res) => {
  res.json({ activities: await listActivities({}) });
});

app.post("/api/teacher/activities", requireCurrentTeacher, async (req, res) => {
  const user = await currentUser(req);
  try {
    const act = await createActivity({
      classId: req.body?.classId || null,
      title: String(req.body?.title || ""),
      prompt: String(req.body?.prompt || ""),
      buckets: req.body?.buckets,
      tokens: req.body?.tokens,
      status: req.body?.status === "published" ? "published" : "draft",
      createdBy: user?.id ?? null,
    });
    res.json(act);
  } catch (err) {
    if (err instanceof SortError) { res.status(400).json({ error: err.message }); return; }
    throw err;
  }
});

app.post("/api/teacher/activities/:id/status", requireCurrentTeacher, async (req, res) => {
  const status = String(req.body?.status || "");
  if (!["draft", "published", "archived"].includes(status)) { res.status(400).json({ error: "Bad status." }); return; }
  try {
    await setStatus(String(req.params["id"]), status as any);
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof SortError) { res.status(404).json({ error: err.message }); return; }
    throw err;
  }
});

app.get("/api/teacher/activities/:id/progress", requireCurrentTeacher, async (req, res) => {
  const classId = typeof req.query["classId"] === "string" && req.query["classId"] ? String(req.query["classId"]) : null;
  const id = String(req.params["id"]);
  const act = await getActivity(id);
  if (!act) { res.status(404).json({ error: "Activity not found." }); return; }
  res.json({
    activity: { id: act.id, title: act.title, status: act.status, buckets: act.buckets, tokens: act.tokens },
    answerKey: answerKeyFor(act),
    students: await progressFor(id, classId),
    misses: await missesFor(id, classId),
  });
});

// ---- Class feed: announcements + portfolio-linked missions ----------------

app.get("/api/class/posts", requireAuth, async (req, res) => {
  const user = await currentUser(req);
  if (!user) { res.status(401).json({ error: "Sign in required." }); return; }
  const posts = await listClassPosts({ classId: user.class_id, publishedOnly: true });
  const [catalog, hidden] = await Promise.all([
    classModuleCatalog(user.class_id), hiddenClassModuleKeys(user.class_id),
  ]);
  const moduleNumbers = new Map(catalog.map((item) => [item.key, item.moduleNumber]));
  const out = [];
  for (const post of posts) {
    const key = post.kind === "portfolio_mission" ? classModuleKey("post", post.id) : null;
    if (key && hidden.has(key)) continue;
    const submission = post.kind === "portfolio_mission" ? await latestClassPostSubmission(post.id, user.id) : null;
    const mission = post.kind === "portfolio_mission" ? await portfolioMissionState(post, user.id) : null;
    out.push({ ...post, body: post.kind === "announcement" ? post.body : undefined, submittedAt: submission?.createdAt ?? null, mission, moduleNumber: key ? moduleNumbers.get(key) : undefined });
  }
  res.json({ posts: out });
});

app.get("/api/class/posts/:id", requireAuth, async (req, res) => {
  res.set("Cache-Control", "private, no-store");
  const user = await currentUser(req);
  if (!user) { res.status(401).json({ error: "Sign in required." }); return; }
  const post = await getClassPost(String(req.params.id));
  if (!post || post.status !== "published" || (post.classId && post.classId !== user.class_id)) {
    res.status(404).json({ error: "Class post not found." }); return;
  }
  const submission = post.kind === "portfolio_mission" ? await latestClassPostSubmission(post.id, user.id) : null;
  const mission = post.kind === "portfolio_mission" ? await portfolioMissionState(post, user.id) : null;
  res.json({ ...post, submission, mission });
});

// ---- Leaderboard: percent-only, public class periods, never students' dollars --

app.get("/api/class/leaderboard", requireAuth, async (req, res) => {
  const user = await currentUser(req);
  if (!user) { res.status(401).json({ error: "Sign in required." }); return; }
  const period = req.query.period;
  if (period !== undefined && period !== "3" && period !== "4") {
    res.status(400).json({ error: "Choose 3rd or 4th period." });
    return;
  }
  const classId = period === "3" ? "class-p3-2026"
    : period === "4" ? "class-p4-2026"
    : user.class_id;
  if (!classId) {
    res.json({ asOfDate: null, sort: "percent", stableMinReturnBp: STABLE_MIN_RETURN_BP, entries: [] });
    return;
  }
  const sort = req.query.sort === "stable" ? "stable" as const : "percent" as const;
  const refresh = ensureLeaderboardFresh(classId, quotes);
  const board = await leaderboardFor(classId, { sort });
  // Map explicitly: valueCents and userIds of other students never leave here.
  res.json({
    asOfDate: board.asOfDate,
    sort: board.sort,
    stableMinReturnBp: board.stableMinReturnBp,
    ...refresh,
    entries: board.entries.map((e) => ({
      name: e.name,
      returnBp: e.returnBp,
      volBp: e.volBp,
      days: e.days,
      sectorsHeld: e.sectorsHeld,
      topPositionBp: e.topPositionBp,
      holdingsCount: e.holdingsCount,
      self: e.userId === user.id,
    })),
  });
});

app.post("/api/class/posts/:id/submit", requireAuth, async (req, res) => {
  const user = await currentUser(req);
  if (!user || user.role !== "student") { res.status(403).json({ error: "Student access only." }); return; }
  const post = await getClassPost(String(req.params.id));
  if (!post || (post.classId && post.classId !== user.class_id)) { res.status(404).json({ error: "Mission not found." }); return; }
  try {
    res.json(await submitPortfolioMission({
      post, userId: user.id, response: req.body?.response,
      idempotencyKey: typeof req.body?.idempotencyKey === "string" ? req.body.idempotencyKey : undefined,
    }));
  } catch (err) {
    if (err instanceof ClassPostError) {
      res.status(err.code === "NOT_FOUND" ? 404 : err.code === "NOT_READY" ? 422 : 400).json({ error: err.message, code: err.code }); return;
    }
    throw err;
  }
});

app.get("/api/teacher/class-posts", requireCurrentTeacher, async (_req, res) => {
  res.json({ posts: await listClassPosts({}) });
});

app.post("/api/teacher/class-posts", requireCurrentTeacher, async (req, res) => {
  const teacher = (req as any).currentUser;
  try {
    res.json(await createClassPost({
      kind: String(req.body?.kind || ""), classId: req.body?.classId || null,
      title: String(req.body?.title || ""), summary: String(req.body?.summary || ""),
      body: String(req.body?.body || ""), spec: req.body?.spec,
      heroUrl: req.body?.heroUrl ? String(req.body.heroUrl) : null, createdBy: teacher.id,
    }));
  } catch (err) {
    if (err instanceof ClassPostError) { res.status(400).json({ error: err.message, code: err.code }); return; }
    throw err;
  }
});

app.post("/api/teacher/class-posts/:id/status", requireCurrentTeacher, async (req, res) => {
  const status = String(req.body?.status || "");
  if (!['draft', 'published', 'archived'].includes(status)) { res.status(400).json({ error: "Bad status." }); return; }
  try {
    await setClassPostStatus(String(req.params.id), status as any);
    res.json({ ok: true, status });
  } catch (err) {
    if (err instanceof ClassPostError) { res.status(404).json({ error: err.message }); return; }
    throw err;
  }
});

app.get("/api/teacher/classes/:id/modules", requireCurrentTeacher, async (req, res) => {
  const classId = String(req.params.id);
  if (!(await one(`SELECT id FROM classes WHERE id = ?`, [classId]))) { res.status(404).json({ error: "Class not found." }); return; }
  const [modules, hidden] = await Promise.all([classModuleCatalog(classId), hiddenClassModuleKeys(classId)]);
  res.json({ modules, hidden: [...hidden] });
});

app.put("/api/teacher/classes/:id/modules", requireCurrentTeacher, async (req, res) => {
  try {
    const hidden = await replaceHiddenClassModules(String(req.params.id), Array.isArray(req.body?.hidden) ? req.body.hidden : []);
    res.json({ ok: true, hidden });
  } catch (err: any) {
    if (String(err?.message) === "Class not found.") { res.status(404).json({ error: err.message }); return; }
    throw err;
  }
});

app.get("/api/bank", requireAuth, async (req, res) => {
  const user = await currentUser(req);
  if (!user) { res.status(401).json({ error: "Sign in required." }); return; }
  const bank = await bankSummaryFor(user.id);
  const pf = await portfolioFor(user.id);
  res.json({
    checkingCents: bank.checkingCents,
    savingsCents: bank.savingsCents,
    savingsInterest: bank.savingsInterest,
    bills: bank.bills,
    recent: bank.recent,
    brokerage: { cashCents: pf.cashCents, portfolioCents: pf.portfolioCents },
    job: { title: (user as any).job_title ?? null, payCents: (user as any).job_pay_cents ?? null },
  });
});

app.post("/api/bank/transfer", requireAuth, async (req, res) => {
  const user = await currentUser(req);
  if (!user) { res.status(401).json({ error: "Sign in required." }); return; }
  if (user.role !== "student") { res.status(403).json({ error: "Teachers cannot move student money." }); return; }
  try {
    const dollars = Number(req.body?.dollars);
    if (!Number.isFinite(dollars) || dollars <= 0) {
      res.status(400).json({ error: "Enter a positive dollar amount." });
      return;
    }
    const r = await transfer({
      userId: user.id,
      from: req.body?.from,
      to: req.body?.to,
      amountCents: Math.round(dollars * 100),
      memo: String(req.body?.memo || ""),
      idempotencyKey: String(req.body?.idempotencyKey || ""),
    });
    const bank = await bankSummaryFor(user.id);
    res.json({ ok: true, deduped: r.deduped, entry: r.entry, bank });
  } catch (err) { bankError(res, err); }
});

app.post("/api/bank/bills/:id/pay", requireAuth, async (req, res) => {
  const user = await currentUser(req);
  if (!user) { res.status(401).json({ error: "Sign in required." }); return; }
  if (user.role !== "student") { res.status(403).json({ error: "Teachers cannot pay student bills." }); return; }
  try {
    const dollars = req.body?.dollars === undefined || req.body?.dollars === "" ? undefined : Number(req.body.dollars);
    if (dollars !== undefined && (!Number.isFinite(dollars) || dollars <= 0)) {
      res.status(400).json({ error: "Enter a positive payment amount." }); return;
    }
    const r = await payBill({
      userId: user.id, billId: String(req.params.id),
      amountCents: dollars === undefined ? undefined : Math.round(dollars * 100),
      idempotencyKey: String(req.body?.idempotencyKey || ""),
    });
    const bank = await bankSummaryFor(user.id);
    res.json({ ok: true, deduped: r.deduped, paidCents: r.paidCents, remainingCents: r.remainingCents, bank });
  } catch (err) { bankError(res, err); }
});

app.post("/api/bank/bills/:id/dispute", requireAuth, async (req, res) => {
  const user = await currentUser(req);
  if (!user) { res.status(401).json({ error: "Sign in required." }); return; }
  if (user.role !== "student") { res.status(403).json({ error: "Teachers cannot dispute student bills." }); return; }
  try {
    const r = await disputeBill({
      userId: user.id, billId: String(req.params.id), reason: String(req.body?.reason || ""),
      idempotencyKey: String(req.body?.idempotencyKey || ""),
    });
    res.json({ ok: true, deduped: r.deduped, dispute: r.dispute, bank: await bankSummaryFor(user.id) });
  } catch (err) { bankError(res, err); }
});

// ---------- banking (teacher) ----------

app.get("/api/teacher/disputes", requireCurrentTeacher, async (req, res) => {
  const classId = String(req.query["classId"] || "") || undefined;
  if (classId) {
    const cls = await one(`SELECT id FROM classes WHERE id = ?`, [classId]);
    if (!cls) { res.status(404).json({ error: "Class not found." }); return; }
  }
  res.json({ disputes: await listDisputes(classId) });
});

app.post("/api/teacher/disputes/:id/resolve", requireCurrentTeacher, async (req, res) => {
  const teacher = readSession(req)!;
  try {
    const r = await resolveDispute({
      disputeId: String(req.params.id),
      actorId: teacher.userId,
      resolution: String(req.body?.resolution || ""),
      idempotencyKey: String(req.body?.idempotencyKey || ""),
    });
    res.json({ ok: true, deduped: r.deduped, dispute: r.dispute });
  } catch (err) { bankError(res, err); }
});

/** Resolve + validate the student set for a class-scoped batch. */
async function batchStudents(classId: string, studentIds: unknown): Promise<{ id: string; name: string; job_pay_cents: number | null; car_payment_cents: number | null; rent_cents: number | null }[]> {
  if (!classId) throw new BankError("INVALID_INPUT", "Choose a class first.");
  const cls = await one(`SELECT id FROM classes WHERE id = ?`, [classId]);
  if (!cls) throw new BankError("NOT_FOUND", "Class not found.");
  const all = await q<{ id: string; name: string; job_pay_cents: number | null; car_payment_cents: number | null; rent_cents: number | null }>(
    `SELECT id, name, job_pay_cents, car_payment_cents, rent_cents FROM users WHERE role = 'student' AND class_id = ? ORDER BY name`, [classId],
  );
  if (studentIds === undefined || studentIds === null || studentIds === "") return all;
  if (!Array.isArray(studentIds) || !studentIds.length) {
    throw new BankError("EMPTY_BATCH", "Nothing selected — pick at least one student.");
  }
  const set = new Set(all.map((s) => s.id));
  const picked = all.filter((s) => (studentIds as unknown[]).includes(s.id));
  if (picked.length !== (studentIds as unknown[]).length) {
    throw new BankError("NOT_FOUND", "One or more selected students are not in this class.");
  }
  void set;
  return picked;
}

app.get("/api/teacher/bank", requireCurrentTeacher, async (req, res) => {
  const classId = String(req.query["classId"] || "");
  const where = classId ? "AND u.class_id = ?" : "";
  const params = classId ? [classId] : [];
  const rows = await q(
    `SELECT u.id, u.name, u.email, u.class_id, c.name AS class_name,
            COALESCE(b.checking_cents, 0) AS checking_cents,
            COALESCE(b.savings_cents, 0) AS savings_cents,
            COALESCE(a.cash_cents, 0) AS brokerage_cents,
            (SELECT COUNT(*) FROM bills bl WHERE bl.user_id = u.id AND bl.paid_at IS NULL) AS bills_due,
            (SELECT COUNT(*) FROM bills bl WHERE bl.user_id = u.id AND bl.paid_at IS NULL AND bl.due_at < ?) AS bills_late
     FROM users u LEFT JOIN classes c ON c.id = u.class_id
     LEFT JOIN bank_accounts b ON b.user_id = u.id
     LEFT JOIN accounts a ON a.user_id = u.id
     WHERE u.role = 'student' ${where}
     ORDER BY u.name`,
    [nowIso(), ...params],
  );
  res.json({ students: rows });
});

app.post("/api/teacher/income/preview", requireCurrentTeacher, async (req, res) => {
  try {
    const assigned = req.body?.mode === "assigned";
    const dollars = Number(req.body?.dollars);
    if (!assigned && (!Number.isFinite(dollars) || dollars <= 0 || dollars > 100000)) {
      res.status(400).json({ error: "Enter a positive dollar amount (max $100,000)." });
      return;
    }
    const label = String(req.body?.label || "").trim();
    if (label.length < 2) { res.status(400).json({ error: "Give the deposit a short label." }); return; }
    const students = await batchStudents(String(req.body?.classId || ""), req.body?.studentIds);
    const cents = assigned ? null : Math.round(dollars * 100);
    const missing = assigned ? students.filter((s) => !(Number(s.job_pay_cents) > 0)) : [];
    if (missing.length) { res.status(400).json({ error: `Assigned pay is missing for: ${missing.map((s) => s.name).join(", ")}.` }); return; }
    const items = students.map((s) => ({ ...s, amountCents: assigned ? Number(s.job_pay_cents) : cents! }));
    res.json({ students: items, mode: assigned ? "assigned" : "flat", perStudentCents: cents, totalCents: items.reduce((sum, s) => sum + s.amountCents, 0), count: students.length });
  } catch (err) { bankError(res, err); }
});

app.post("/api/teacher/income/issue", requireCurrentTeacher, async (req, res) => {
  const teacher = readSession(req)!;
  try {
    const assigned = req.body?.mode === "assigned";
    const dollars = Number(req.body?.dollars);
    if (!assigned && (!Number.isFinite(dollars) || dollars <= 0 || dollars > 100000)) {
      res.status(400).json({ error: "Enter a positive dollar amount (max $100,000)." });
      return;
    }
    const label = String(req.body?.label || "").trim();
    if (label.length < 2) { res.status(400).json({ error: "Give the deposit a short label." }); return; }
    const students = await batchStudents(String(req.body?.classId || ""), req.body?.studentIds);
    const missing = assigned ? students.filter((s) => !(Number(s.job_pay_cents) > 0)) : [];
    if (missing.length) { res.status(400).json({ error: `Assigned pay is missing for: ${missing.map((s) => s.name).join(", ")}.` }); return; }
    const batchId = String(req.body?.batchId || "");
    if (!batchId) { res.status(400).json({ error: "Batch id is required (prevents double-posting)." }); return; }
    const cents = assigned ? 0 : Math.round(dollars * 100);
    const items = students.map((s) => ({ userId: s.id, label, amountCents: assigned ? Number(s.job_pay_cents) : cents }));
    const r = await issueIncomeBatch({
      actorId: teacher.userId, batchId,
      items,
    });
    res.json({ ok: true, posted: r.posted, batchId: r.batchId, count: students.length, totalCents: items.reduce((sum, item) => sum + item.amountCents, 0) });
  } catch (err) { bankError(res, err); }
});

app.get("/api/teacher/bills/templates", requireCurrentTeacher, async (_req, res) => {
  res.json({ templates: await q(`SELECT * FROM bill_templates ORDER BY created_at DESC`) });
});

app.post("/api/teacher/bills/templates", requireCurrentTeacher, async (req, res) => {
  const teacher = readSession(req)!;
  try {
    const dollars = Number(req.body?.dollars);
    if (!Number.isFinite(dollars) || dollars <= 0 || dollars > 100000) {
      res.status(400).json({ error: "Enter a positive dollar amount (max $100,000)." });
      return;
    }
    const feeDollars = req.body?.lateFeeDollars === undefined || req.body?.lateFeeDollars === "" ? 0 : Number(req.body.lateFeeDollars);
    if (!Number.isFinite(feeDollars) || feeDollars < 0 || feeDollars > 10000) {
      res.status(400).json({ error: "Late fee must be $0–$10,000." });
      return;
    }
    const r = await createBillTemplate({
      teacherId: teacher.userId,
      title: String(req.body?.title || ""),
      amountCents: Math.round(dollars * 100),
      lateFeeCents: Math.round(feeDollars * 100),
      description: String(req.body?.description || ""),
      sender: String(req.body?.sender || ""),
      documentTitle: String(req.body?.documentTitle || ""),
      documentBody: String(req.body?.documentBody || req.body?.description || ""),
    });
    res.json({ ok: true, id: r.id });
  } catch (err) { bankError(res, err); }
});

function draftInput(body: any) {
  const dollars = Number(body?.dollars);
  const feeDollars = body?.lateFeeDollars === undefined || body?.lateFeeDollars === "" ? 0 : Number(body.lateFeeDollars);
  return {
    studentId: String(body?.studentId || ""), classId: String(body?.classId || ""),
    title: String(body?.title || ""), amountCents: Math.round(dollars * 100),
    lateFeeCents: Math.round(feeDollars * 100), dueAt: String(body?.dueAt || ""),
    sender: String(body?.sender || ""), documentTitle: String(body?.documentTitle || ""),
    documentBody: String(body?.documentBody || ""),
  };
}

app.get("/api/teacher/bill-drafts", requireCurrentTeacher, async (req, res) => {
  res.json({ drafts: await listBillDrafts(String(req.query["classId"] || "")) });
});

app.post("/api/teacher/bill-drafts", requireCurrentTeacher, async (req, res) => {
  const teacher = readSession(req)!;
  try { res.json(await createBillDraft({ ...draftInput(req.body), createdBy: teacher.userId })); }
  catch (err) { bankError(res, err); }
});

app.put("/api/teacher/bill-drafts/:id", requireCurrentTeacher, async (req, res) => {
  const teacher = readSession(req)!;
  try { res.json(await updateBillDraft(String(req.params.id || ""), { ...draftInput(req.body), actorId: teacher.userId })); }
  catch (err) { bankError(res, err); }
});

app.post("/api/teacher/bill-drafts/:id/send", requireCurrentTeacher, async (req, res) => {
  const teacher = readSession(req)!;
  try { res.json(await sendBillDraft(String(req.params.id || ""), teacher.userId)); }
  catch (err) { bankError(res, err); }
});

function parseBillForm(body: any) {
  const mode = String(body?.mode || "flat");
  const assignedRent = mode === "assigned_rent" || mode === "rent";
  const assignedCar = mode === "assigned_car" || mode === "car" || mode === "assigned";
  const assigned = assignedRent || assignedCar;
  const dollars = Number(body?.dollars);
  if (!assigned && (!Number.isFinite(dollars) || dollars <= 0 || dollars > 100000)) {
    throw new BankError("INVALID_INPUT", "Enter a positive dollar amount (max $100,000).");
  }
  const feeDollars = body?.lateFeeDollars === undefined || body?.lateFeeDollars === "" ? 0 : Number(body.lateFeeDollars);
  if (!Number.isFinite(feeDollars) || feeDollars < 0 || feeDollars > 10000) {
    throw new BankError("INVALID_INPUT", "Late fee must be $0–$10,000.");
  }
  const title = String(body?.title || "").trim();
  if (title.length < 2) throw new BankError("INVALID_INPUT", "Give the bill a short title.");
  const dueAt = String(body?.dueAt || "");
  if (!dueAt || isNaN(new Date(dueAt).getTime())) throw new BankError("INVALID_INPUT", "Pick a valid due date.");
  return {
    title, cents: assigned ? 0 : Math.round(dollars * 100), feeCents: Math.round(feeDollars * 100), dueAt,
    mode: assignedRent ? "assigned_rent" : assignedCar ? "assigned_car" : "flat",
    sender: String(body?.sender || "").trim().slice(0, 120),
    documentTitle: String(body?.documentTitle || "").trim().slice(0, 160),
    documentBody: String(body?.documentBody || body?.description || "").trim().slice(0, 8000),
  };
}

app.post("/api/teacher/bills/preview", requireCurrentTeacher, async (req, res) => {
  try {
    const form = parseBillForm(req.body);
    const students = await batchStudents(String(req.body?.classId || ""), req.body?.studentIds);
    if (form.mode !== "flat") {
      const key = form.mode === "assigned_rent" ? "rent_cents" : "car_payment_cents";
      const label = form.mode === "assigned_rent" ? "rent" : "car payment";
      const missing = students.filter((s) => !(Number((s as any)[key]) > 0));
      if (missing.length) { res.status(400).json({ error: `Assigned ${label} is missing for: ${missing.map((s) => s.name).join(", ")}.` }); return; }
      const items = students.map((s) => ({ ...s, amountCents: Number((s as any)[key]) }));
      res.json({
        students: items, mode: form.mode, perStudentCents: null,
        totalCents: items.reduce((sum, s) => sum + s.amountCents, 0),
        count: students.length, title: form.title, dueAt: form.dueAt, lateFeeCents: form.feeCents,
        sender: form.sender, documentTitle: form.documentTitle, documentBody: form.documentBody,
      });
      return;
    }
    res.json({
      students, mode: "flat", perStudentCents: form.cents, totalCents: form.cents * students.length,
      count: students.length, title: form.title, dueAt: form.dueAt, lateFeeCents: form.feeCents,
      sender: form.sender, documentTitle: form.documentTitle, documentBody: form.documentBody,
    });
  } catch (err) { bankError(res, err); }
});

app.post("/api/teacher/bills/issue", requireCurrentTeacher, async (req, res) => {
  const teacher = readSession(req)!;
  try {
    const form = parseBillForm(req.body);
    const students = await batchStudents(String(req.body?.classId || ""), req.body?.studentIds);
    const batchId = String(req.body?.batchId || "");
    if (!batchId) { res.status(400).json({ error: "Batch id is required (prevents double-issuing)." }); return; }
    const templateId = req.body?.templateId ? String(req.body.templateId) : null;
    if (form.mode !== "flat") {
      const key = form.mode === "assigned_rent" ? "rent_cents" : "car_payment_cents";
      const label = form.mode === "assigned_rent" ? "rent" : "car payment";
      const missing = students.filter((s) => !(Number((s as any)[key]) > 0));
      if (missing.length) { res.status(400).json({ error: `Assigned ${label} is missing for: ${missing.map((s) => s.name).join(", ")}.` }); return; }
      const r = await issueBillBatch({
        issuedBy: teacher.userId, batchId,
        items: students.map((s) => ({
          userId: s.id, title: form.title, amountCents: Number((s as any)[key]),
          lateFeeCents: form.feeCents, dueAt: form.dueAt, templateId,
          sender: form.sender, documentTitle: form.documentTitle, documentBody: form.documentBody,
        })),
      });
      const total = students.reduce((sum, s) => sum + Number((s as any)[key]), 0);
      res.json({ ok: true, issued: r.issued, batchId: r.batchId, mode: form.mode, totalCents: total });
      return;
    }
    const r = await issueBillBatch({
      issuedBy: teacher.userId, batchId,
      items: students.map((s) => ({
        userId: s.id, title: form.title, amountCents: form.cents,
        lateFeeCents: form.feeCents, dueAt: form.dueAt, templateId,
        sender: form.sender, documentTitle: form.documentTitle, documentBody: form.documentBody,
      })),
    });
    res.json({ ok: true, issued: r.issued, batchId: r.batchId, totalCents: form.cents * r.issued });
  } catch (err) { bankError(res, err); }
});

// ---------- static (prod) ----------

const dist = path.join(ROOT, "dist");
if (fs.existsSync(path.join(dist, "index.html"))) {
  app.use(express.static(dist));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

// ---------- boot ----------

// Safety net: Express 4 does not catch async route rejections, and Node 24
// crashes the process on unhandled rejections by default. A transient DB blip
// must cost one failed request, not the whole classroom server.
process.on("unhandledRejection", (err) => {
  console.error("[simlife] unhandled rejection (server stays up):", err);
});

async function boot() {  validateProductionEnv();
  await initSchema();
  await ensureColumn("users", "last_active_at", "TEXT");
  await ensureColumn("users", "job_title", "TEXT");
  await ensureColumn("users", "job_pay_cents", "INTEGER");
  await ensureColumn("users", "job_updated_at", "TEXT");
  await ensureColumn("users", "car_payment_cents", "INTEGER");
  await ensureColumn("users", "rent_cents", "INTEGER");
  await ensureColumn("roster_profiles", "rent_cents", "INTEGER");
  await ensureColumn("bank_accounts", "interest_residual_micros", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn("bank_accounts", "interest_accrued_at", "TEXT");
  await ensureColumn("bill_templates", "sender", "TEXT");
  await ensureColumn("bill_templates", "document_title", "TEXT");
  await ensureColumn("bill_templates", "document_body", "TEXT");
  await ensureColumn("bills", "paid_cents", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn("bills", "sender", "TEXT");
  await ensureColumn("bills", "document_title", "TEXT");
  await ensureColumn("bills", "document_body", "TEXT");
  await ensureColumn("bill_disputes", "resolved_by", "TEXT");
  await ensureColumn("bill_disputes", "resolve_key", "TEXT");
  if (demoEnabled()) await ensureDemoUsers();
  app.listen(PORT, HOST, () => {
    console.log(`[simlife] api on http://${HOST}:${PORT} (quotes: ${quotes.providerName})`);
  });
}

// Friendlier audit SELECT: the LEFT JOIN alias above selects a.* name via subquery fallback.
app.use(((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[simlife] error:", err);
  res.status(500).json({ error: "Something went wrong. Try again." });
}) as express.ErrorRequestHandler);

boot().catch((err) => {
  console.error("[simlife] boot failed:", err);
  process.exit(1);
});
