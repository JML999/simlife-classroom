/**
 * Sector sort activity: students file a basket of tickers into sector buckets.
 *
 * THE ANSWER KEY IS NEVER STORED. Each ticker's correct bucket is read from
 * server/ticker-directory.json at grading time, so an activity cannot drift out
 * of sync with the directory and no one hand-types a sector wrong. The cost is
 * that a ticker missing from the directory has no correct answer - handled
 * explicitly below rather than silently marked wrong.
 *
 * Submissions are append-only, one row per attempt. Retries are expected: this
 * is practice. The attempt history shows a student converging on an answer,
 * which a single overwritten response would hide.
 */
import fs from "node:fs";
import path from "node:path";
import { q, one, run, newId, nowIso } from "./db.js";
import { ROOT } from "./env.js";

export class SortError extends Error {
  code: "NOT_FOUND" | "INVALID_INPUT" | "FORBIDDEN";
  constructor(code: SortError["code"], msg: string) { super(msg); this.code = code; }
}

export interface SortToken { ticker: string; label?: string }
export interface SortActivity {
  id: string; classId: string | null; title: string; prompt: string;
  buckets: string[]; tokens: SortToken[]; status: string; createdAt: string;
}

// --- ticker sectors ---------------------------------------------------------

let sectorCache: Map<string, string> | null = null;

function sectors(): Map<string, string> {
  if (sectorCache) return sectorCache;
  const m = new Map<string, string>();
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, "server", "ticker-directory.json"), "utf8"));
    for (const [ticker, v] of Object.entries((raw?.meta ?? {}) as Record<string, any>)) {
      if (v?.sector) m.set(ticker.toUpperCase(), String(v.sector));
    }
  } catch { /* directory missing: every ticker is unknown, reported as such */ }
  sectorCache = m;
  return m;
}

/** Test seam. */
export function resetSectorCache(): void { sectorCache = null; }

export function sectorOf(ticker: string): string | null {
  return sectors().get(String(ticker || "").toUpperCase()) ?? null;
}

// --- grading ----------------------------------------------------------------

export interface TokenResult {
  ticker: string;
  placed: string | null;
  correct: boolean;
  /** true when the directory has no sector for this ticker. */
  unknown: boolean;
}

export interface GradeResult {
  results: TokenResult[];
  correctCount: number;
  totalCount: number;
  /** Tickers with no sector in the directory. Excluded from totalCount. */
  unknownTickers: string[];
}

/**
 * Grade placements against the directory.
 *
 * A ticker the directory cannot classify is EXCLUDED from the score rather than
 * counted wrong. An unclassified ticker is a gap in our data, not a student
 * error, and marking it wrong would punish a student for being right.
 */
export function grade(tokens: SortToken[], placements: Record<string, string>): GradeResult {
  const results: TokenResult[] = [];
  const unknownTickers: string[] = [];
  let correctCount = 0;
  let totalCount = 0;

  for (const t of tokens) {
    const ticker = String(t.ticker || "").toUpperCase();
    const truth = sectorOf(ticker);
    const placed = placements[ticker] ?? null;
    if (!truth) {
      unknownTickers.push(ticker);
      results.push({ ticker, placed, correct: false, unknown: true });
      continue;
    }
    totalCount++;
    const correct = placed === truth;
    if (correct) correctCount++;
    results.push({ ticker, placed, correct, unknown: false });
  }
  return { results, correctCount, totalCount, unknownTickers };
}

// --- activities -------------------------------------------------------------

function rowToActivity(r: any): SortActivity {
  return {
    id: r.id, classId: r.class_id, title: r.title, prompt: r.prompt,
    buckets: JSON.parse(r.buckets), tokens: JSON.parse(r.tokens),
    status: r.status, createdAt: r.created_at,
  };
}

export async function createActivity(opts: {
  classId?: string | null; title: string; prompt: string;
  buckets: string[]; tokens: SortToken[]; status?: string; createdBy?: string | null;
}): Promise<SortActivity> {
  const title = String(opts.title || "").trim();
  if (title.length < 2) throw new SortError("INVALID_INPUT", "Give the activity a title.");
  if (!Array.isArray(opts.buckets) || opts.buckets.length < 2) {
    throw new SortError("INVALID_INPUT", "An activity needs at least two buckets.");
  }
  if (!Array.isArray(opts.tokens) || opts.tokens.length < 2) {
    throw new SortError("INVALID_INPUT", "An activity needs at least two tickers.");
  }
  const id = newId("sact");
  await run(
    `INSERT INTO sort_activities (id, class_id, title, prompt, buckets, tokens, status, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, opts.classId ?? null, title, String(opts.prompt || ""),
     JSON.stringify(opts.buckets), JSON.stringify(opts.tokens),
     opts.status || "draft", opts.createdBy ?? null, nowIso()],
  );
  return (await getActivity(id))!;
}

export async function getActivity(id: string): Promise<SortActivity | null> {
  const r = await one<any>(`SELECT * FROM sort_activities WHERE id = ?`, [id]);
  return r ? rowToActivity(r) : null;
}

export async function listActivities(opts: { classId?: string | null; publishedOnly?: boolean } = {}): Promise<SortActivity[]> {
  // A NULL class_id means the activity is offered to every class.
  const rows = opts.classId
    ? await q<any>(
        `SELECT * FROM sort_activities WHERE (class_id = ? OR class_id IS NULL)${opts.publishedOnly ? " AND status = 'published'" : ""} ORDER BY created_at DESC`,
        [opts.classId])
    : await q<any>(
        `SELECT * FROM sort_activities${opts.publishedOnly ? " WHERE status = 'published'" : ""} ORDER BY created_at DESC`);
  return rows.map(rowToActivity);
}

export async function setStatus(id: string, status: "draft" | "published" | "archived"): Promise<void> {
  const act = await getActivity(id);
  if (!act) throw new SortError("NOT_FOUND", "Activity not found.");
  await run(`UPDATE sort_activities SET status = ? WHERE id = ?`, [status, id]);
}

// --- submissions ------------------------------------------------------------

export interface SubmitResult {
  attemptNo: number; correctCount: number; totalCount: number;
  results: TokenResult[]; unknownTickers: string[]; deduped: boolean;
}

/** Keep only real tickers filed into buckets this activity defines. */
function cleanPlacements(act: SortActivity, placements: unknown): Record<string, string> {
  const input = placements && typeof placements === "object" ? placements : {};
  const allowed = new Set(act.buckets);
  const clean: Record<string, string> = {};
  for (const t of act.tokens) {
    const ticker = String(t.ticker).toUpperCase();
    const v = (input as any)[ticker];
    if (typeof v === "string" && allowed.has(v)) clean[ticker] = v;
  }
  return clean;
}

export async function submit(opts: {
  activityId: string; userId: string;
  placements: Record<string, string>; idempotencyKey?: string;
}): Promise<SubmitResult> {
  const act = await getActivity(opts.activityId);
  if (!act) throw new SortError("NOT_FOUND", "Activity not found.");
  if (act.status !== "published") throw new SortError("NOT_FOUND", "Activity not found.");

  const clean = cleanPlacements(act, opts.placements);

  if (opts.idempotencyKey) {
    const dup = await one<any>(`SELECT * FROM sort_submissions WHERE idempotency_key = ?`, [opts.idempotencyKey]);
    if (dup) {
      const g = grade(act.tokens, JSON.parse(dup.placements));
      return { attemptNo: dup.attempt_no, correctCount: dup.correct_count, totalCount: dup.total_count,
               results: g.results, unknownTickers: g.unknownTickers, deduped: true };
    }
  }

  const g = grade(act.tokens, clean);
  const prev = await one<{ n: number }>(
    `SELECT COALESCE(MAX(attempt_no), 0) AS n FROM sort_submissions WHERE activity_id = ? AND user_id = ?`,
    [opts.activityId, opts.userId],
  );
  const attemptNo = Number(prev?.n ?? 0) + 1;

  await run(
    `INSERT INTO sort_submissions (id, activity_id, user_id, attempt_no, placements, correct_count, total_count, idempotency_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [newId("ssub"), opts.activityId, opts.userId, attemptNo, JSON.stringify(clean),
     g.correctCount, g.totalCount, opts.idempotencyKey ?? null, nowIso()],
  );
  // A submit supersedes any saved draft.
  await clearDraft(opts.activityId, opts.userId);

  return { attemptNo, correctCount: g.correctCount, totalCount: g.totalCount,
           results: g.results, unknownTickers: g.unknownTickers, deduped: false };
}

export async function attemptsFor(activityId: string, userId: string): Promise<any[]> {
  return q<any>(
    `SELECT id, attempt_no, correct_count, total_count, placements, created_at
       FROM sort_submissions WHERE activity_id = ? AND user_id = ? ORDER BY attempt_no DESC`,
    [activityId, userId],
  );
}

// --- drafts -----------------------------------------------------------------
//
// One row per student per activity, upserted on every Save. Partial progress
// is fine here — unlike Submit, a draft needs no completeness check and is
// never graded.

export interface SortDraft {
  placements: Record<string, string>;
  updatedAt: string;
}

export async function saveDraft(opts: {
  activityId: string; userId: string; placements: Record<string, string>;
}): Promise<SortDraft> {
  const act = await getActivity(opts.activityId);
  if (!act) throw new SortError("NOT_FOUND", "Activity not found.");
  if (act.status !== "published") throw new SortError("NOT_FOUND", "Activity not found.");
  const clean = cleanPlacements(act, opts.placements);
  const updatedAt = nowIso();
  // Both SQLite and Postgres understand this upsert shape.
  await run(
    `INSERT INTO sort_drafts (activity_id, user_id, placements, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (activity_id, user_id) DO UPDATE SET placements = excluded.placements, updated_at = excluded.updated_at`,
    [opts.activityId, opts.userId, JSON.stringify(clean), updatedAt],
  );
  return { placements: clean, updatedAt };
}

export async function draftFor(activityId: string, userId: string): Promise<SortDraft | null> {
  const r = await one<any>(
    `SELECT placements, updated_at FROM sort_drafts WHERE activity_id = ? AND user_id = ?`,
    [activityId, userId],
  );
  if (!r) return null;
  return { placements: JSON.parse(r.placements), updatedAt: r.updated_at };
}

export async function clearDraft(activityId: string, userId: string): Promise<void> {
  await run(`DELETE FROM sort_drafts WHERE activity_id = ? AND user_id = ?`, [activityId, userId]);
}

/**
 * Teacher view: every student in the class with their best attempt, including
 * that attempt's placements so the dashboard can draw a per-ticker grid.
 *
 * Students with no submission are included with nulls. A roster view that
 * silently omitted them would hide exactly the students who most need chasing.
 */
export async function progressFor(activityId: string, classId?: string | null): Promise<any[]> {
  const students = classId
    ? await q<any>(`SELECT id, name FROM users WHERE role = 'student' AND class_id = ? ORDER BY name`, [classId])
    : await q<any>(`SELECT id, name FROM users WHERE role = 'student' ORDER BY name`);
  const out = [];
  for (const s of students) {
    const rows = await q<any>(
      `SELECT attempt_no, correct_count, total_count, placements, created_at FROM sort_submissions
        WHERE activity_id = ? AND user_id = ? ORDER BY attempt_no`,
      [activityId, s.id],
    );
    // Best, not latest: a student who got it right then experimented should not
    // be recorded as having done worse.
    const best = rows.reduce((b: any, r: any) => (!b || r.correct_count > b.correct_count ? r : b), null);
    out.push({
      userId: s.id, name: s.name,
      attempts: rows.length,
      bestCorrect: best ? best.correct_count : null,
      total: best ? best.total_count : null,
      bestPlacements: best ? JSON.parse(best.placements) : null,
      firstCorrect: rows.length ? rows[0]!.correct_count : null,
      lastAt: rows.length ? rows[rows.length - 1]!.created_at : null,
    });
  }
  return out;
}

/** The correct bucket per ticker. Teacher-only: never sent to a student. */
export function answerKeyFor(act: SortActivity): Record<string, string | null> {
  const key: Record<string, string | null> = {};
  for (const t of act.tokens) key[String(t.ticker).toUpperCase()] = sectorOf(t.ticker);
  return key;
}

/** Which tickers the class as a whole misfiled — the reteach list. */
export async function missesFor(activityId: string, classId?: string | null): Promise<{ ticker: string; wrong: number; attempts: number; commonWrongBucket: string | null }[]> {
  const act = await getActivity(activityId);
  if (!act) throw new SortError("NOT_FOUND", "Activity not found.");
  const rows = classId
    ? await q<any>(
        `SELECT s.placements FROM sort_submissions s JOIN users u ON u.id = s.user_id
          WHERE s.activity_id = ? AND u.class_id = ?`, [activityId, classId])
    : await q<any>(`SELECT placements FROM sort_submissions WHERE activity_id = ?`, [activityId]);

  const tally = new Map<string, { wrong: number; attempts: number; buckets: Map<string, number> }>();
  for (const t of act.tokens) tally.set(String(t.ticker).toUpperCase(), { wrong: 0, attempts: 0, buckets: new Map() });
  for (const r of rows) {
    const placements = JSON.parse(r.placements);
    for (const t of act.tokens) {
      const ticker = String(t.ticker).toUpperCase();
      const truth = sectorOf(ticker);
      if (!truth) continue;
      const placed = placements[ticker];
      const rec = tally.get(ticker)!;
      if (placed == null) continue;
      rec.attempts++;
      if (placed !== truth) {
        rec.wrong++;
        rec.buckets.set(placed, (rec.buckets.get(placed) ?? 0) + 1);
      }
    }
  }
  return [...tally.entries()]
    .map(([ticker, r]) => {
      let commonWrongBucket: string | null = null; let top = 0;
      for (const [b, n] of r.buckets) if (n > top) { top = n; commonWrongBucket = b; }
      return { ticker, wrong: r.wrong, attempts: r.attempts, commonWrongBucket };
    })
    .sort((a, b) => b.wrong - a.wrong);
}
