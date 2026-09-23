/**
 * Class feed: teacher announcements and portfolio-linked missions.
 *
 * Portfolio missions never trust a student-authored claim about holdings. The
 * server derives the original basket from the first three distinct stock buys
 * and the current basket from the ledger, then freezes that evidence alongside
 * an append-only submission.
 */
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./env.js";
import { holdingsFor } from "./ledger.js";
import { newId, nowIso, one, q, run } from "./db.js";

export type ClassPostKind = "announcement" | "portfolio_mission";

export class ClassPostError extends Error {
  code: "NOT_FOUND" | "INVALID_INPUT" | "NOT_READY";
  constructor(code: ClassPostError["code"], message: string) { super(message); this.code = code; }
}

export interface ClassPost {
  id: string;
  kind: ClassPostKind;
  classId: string | null;
  title: string;
  summary: string;
  body: string;
  spec: Record<string, any>;
  heroUrl: string | null;
  status: "draft" | "published" | "archived";
  createdAt: string;
}

const DEFAULT_MISSION_SPEC = {
  minCompanies: 6,
  minSectors: 5,
  pickThesisMinWords: 12,
  reflectionMinWords: 40,
};

let directory: Record<string, any> | null = null;
function tickerMeta(ticker: string): any | null {
  if (!directory) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(ROOT, "server", "ticker-directory.json"), "utf8"));
      directory = raw?.meta ?? {};
    } catch { directory = {}; }
  }
  return directory![String(ticker || "").toUpperCase()] ?? null;
}

function rowToPost(row: any): ClassPost {
  return {
    id: row.id, kind: row.kind, classId: row.class_id,
    title: row.title, summary: row.summary, body: row.body,
    spec: JSON.parse(row.spec || "{}"), heroUrl: row.hero_url,
    status: row.status, createdAt: row.created_at,
  };
}

function cleanMissionSpec(input: any): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, fallback] of Object.entries(DEFAULT_MISSION_SPEC)) {
    const n = Number(input?.[key] ?? fallback);
    if (!Number.isInteger(n) || n < 1 || n > 100) {
      throw new ClassPostError("INVALID_INPUT", `${key} must be a whole number from 1 to 100.`);
    }
    out[key] = n;
  }
  if (out.minSectors! > out.minCompanies!) {
    throw new ClassPostError("INVALID_INPUT", "Sector target cannot exceed the company target.");
  }
  return out;
}

export async function createClassPost(opts: {
  kind: string; classId?: string | null; title: string; summary?: string; body?: string;
  spec?: unknown; heroUrl?: string | null; createdBy?: string | null;
}): Promise<ClassPost> {
  if (opts.kind !== "announcement" && opts.kind !== "portfolio_mission") {
    throw new ClassPostError("INVALID_INPUT", "Choose announcement or portfolio mission.");
  }
  const title = String(opts.title || "").trim();
  const summary = String(opts.summary || "").trim();
  const body = String(opts.body || "").trim();
  if (title.length < 2 || title.length > 120) throw new ClassPostError("INVALID_INPUT", "Give the post a 2–120 character title.");
  if (opts.kind === "announcement" && body.length < 2) throw new ClassPostError("INVALID_INPUT", "Write the announcement first.");
  if (opts.classId && !(await one(`SELECT id FROM classes WHERE id = ?`, [opts.classId]))) {
    throw new ClassPostError("INVALID_INPUT", "Choose a class that still exists.");
  }
  const spec = opts.kind === "portfolio_mission" ? cleanMissionSpec(opts.spec) : {};
  const id = newId("cpost");
  await run(
    `INSERT INTO class_posts (id, kind, class_id, title, summary, body, spec, hero_url, status, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
    [id, opts.kind, opts.classId ?? null, title, summary, body, JSON.stringify(spec),
     opts.heroUrl || null, opts.createdBy ?? null, nowIso()],
  );
  return (await getClassPost(id))!;
}

export async function getClassPost(id: string): Promise<ClassPost | null> {
  const row = await one<any>(`SELECT * FROM class_posts WHERE id = ?`, [id]);
  return row ? rowToPost(row) : null;
}

export async function listClassPosts(opts: { classId?: string | null; publishedOnly?: boolean } = {}): Promise<ClassPost[]> {
  const status = opts.publishedOnly ? " AND status = 'published'" : "";
  const rows = opts.classId
    ? await q<any>(`SELECT * FROM class_posts WHERE (class_id = ? OR class_id IS NULL)${status} ORDER BY created_at DESC`, [opts.classId])
    : opts.classId === null
      ? await q<any>(`SELECT * FROM class_posts WHERE class_id IS NULL${status} ORDER BY created_at DESC`)
      : await q<any>(`SELECT * FROM class_posts${opts.publishedOnly ? " WHERE status = 'published'" : ""} ORDER BY created_at DESC`);
  return rows.map(rowToPost);
}

export async function setClassPostStatus(id: string, status: "draft" | "published" | "archived"): Promise<void> {
  if (!(await getClassPost(id))) throw new ClassPostError("NOT_FOUND", "Class post not found.");
  await run(`UPDATE class_posts SET status = ? WHERE id = ?`, [status, id]);
}

async function originalStockTickers(userId: string): Promise<string[]> {
  const buys = await q<{ ticker: string }>(
    `SELECT l.ticker FROM ledger l JOIN accounts a ON a.id = l.account_id
      WHERE a.user_id = ? AND l.kind = 'buy' AND l.ticker IS NOT NULL
      ORDER BY l.created_at, l.id`, [userId],
  );
  const distinct: string[] = [];
  for (const row of buys) {
    const ticker = String(row.ticker).toUpperCase();
    if (tickerMeta(ticker)?.kind === "STOCK" && !distinct.includes(ticker)) distinct.push(ticker);
    if (distinct.length === 3) break;
  }
  return distinct;
}

export async function portfolioMissionState(post: ClassPost, userId: string): Promise<any> {
  if (post.kind !== "portfolio_mission") throw new ClassPostError("INVALID_INPUT", "This post is not a portfolio mission.");
  const baselineTickers = await originalStockTickers(userId);
  const baselineSectors = [...new Set(baselineTickers.map((ticker) => tickerMeta(ticker)?.sector).filter(Boolean))] as string[];
  const { holdings } = await holdingsFor(userId, () => null);
  const companies = holdings
    .map((holding) => ({ ...holding, meta: tickerMeta(holding.ticker) }))
    .filter((holding) => holding.meta?.kind === "STOCK")
    .map((holding) => ({
      ticker: holding.ticker,
      shares: holding.shares,
      sector: holding.meta.sector || "Unknown",
      subIndustry: holding.meta.subIndustry || "",
      isOriginal: baselineTickers.includes(holding.ticker),
    }));
  const sectors = [...new Set(companies.map((holding) => holding.sector).filter((sector) => sector !== "Unknown"))];
  const baselineCompanies = baselineTickers.map((ticker) => ({
    ticker, sector: tickerMeta(ticker)?.sector || "Unknown",
    held: companies.some((holding) => holding.ticker === ticker),
  }));
  const missingBaselineTickers = baselineCompanies.filter((holding) => !holding.held).map((holding) => holding.ticker);
  const newCompanies = companies.filter((holding) => !holding.isOriginal);
  const newSectorCompanies = newCompanies.filter((holding) => !baselineSectors.includes(holding.sector));
  const spec = { ...DEFAULT_MISSION_SPEC, ...post.spec };
  const checks = {
    baselineReady: baselineTickers.length >= 3,
    companies: companies.length >= spec.minCompanies,
    sectors: sectors.length >= spec.minSectors,
  };
  return {
    baselineTickers, baselineCompanies, missingBaselineTickers, baselineSectors, companies, sectors, newCompanies: newCompanies.map((holding) => holding.ticker),
    newSectorCompanies: newSectorCompanies.map((holding) => holding.ticker),
    counts: { companies: companies.length, sectors: sectors.length, newCompanies: newCompanies.length, newSectorCompanies: newSectorCompanies.length },
    targets: spec, checks, met: Object.values(checks).every(Boolean),
  };
}

const wordCount = (value: unknown): number => String(value || "").trim().split(/\s+/).filter(Boolean).length;

export async function latestClassPostSubmission(postId: string, userId: string): Promise<any | null> {
  const row = await one<any>(
    `SELECT id, response, evidence, created_at FROM class_post_submissions
      WHERE post_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 1`, [postId, userId],
  );
  return row ? { id: row.id, response: JSON.parse(row.response), evidence: JSON.parse(row.evidence), createdAt: row.created_at } : null;
}

export async function submitPortfolioMission(opts: {
  post: ClassPost; userId: string; response: any; idempotencyKey?: string;
}): Promise<any> {
  if (opts.post.kind !== "portfolio_mission" || opts.post.status !== "published") {
    throw new ClassPostError("NOT_FOUND", "Mission not found.");
  }
  if (opts.idempotencyKey) {
    const existing = await one<any>(`SELECT response, evidence, created_at FROM class_post_submissions WHERE idempotency_key = ?`, [opts.idempotencyKey]);
    if (existing) return { submittedAt: existing.created_at, deduped: true };
  }
  const state = await portfolioMissionState(opts.post, opts.userId);
  if (!state.met) throw new ClassPostError("NOT_READY", "Your live portfolio has not met every mission target yet.");
  const picks = Array.isArray(opts.response?.picks) ? opts.response.picks : [];
  if (picks.length !== 3) throw new ClassPostError("INVALID_INPUT", "Explain exactly three new company picks.");
  const cleanPicks = picks.map((pick: any) => ({ ticker: String(pick?.ticker || "").trim().toUpperCase(), thesis: String(pick?.thesis || "").trim() }));
  if (new Set(cleanPicks.map((pick: any) => pick.ticker)).size !== 3) throw new ClassPostError("INVALID_INPUT", "Choose three different tickers.");
  for (const pick of cleanPicks) {
    if (!state.newCompanies.includes(pick.ticker)) throw new ClassPostError("INVALID_INPUT", `${pick.ticker || "Each pick"} must be a current company holding you added after your first three.`);
    if (wordCount(pick.thesis) < state.targets.pickThesisMinWords) throw new ClassPostError("INVALID_INPUT", `Explain ${pick.ticker} in at least ${state.targets.pickThesisMinWords} words.`);
  }
  const reflection = String(opts.response?.reflection || "").trim();
  if (wordCount(reflection) < state.targets.reflectionMinWords) {
    throw new ClassPostError("INVALID_INPUT", `Your final reflection needs at least ${state.targets.reflectionMinWords} words.`);
  }
  const submittedAt = nowIso();
  await run(
    `INSERT INTO class_post_submissions (id, post_id, user_id, response, evidence, idempotency_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [newId("csub"), opts.post.id, opts.userId, JSON.stringify({ picks: cleanPicks, reflection }),
     JSON.stringify(state), opts.idempotencyKey ?? null, submittedAt],
  );
  return { submittedAt, deduped: false };
}
