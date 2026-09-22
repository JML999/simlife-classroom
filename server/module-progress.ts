/**
 * Per-student module progress for the teacher dashboard.
 *
 * Two views, CodeWorld-style:
 *   moduleProgress(classId)   — roster columns: how many modules each student
 *                               has started / submitted.
 *   studentModuleDetail(id)   — the profile drawer: one row per module with a
 *                               collapsed summary (submitted? N/M parts) plus
 *                               the granular evidence for the expanded view
 *                               (sort ticker grid, mission goals + write-up).
 *
 * Status meanings:
 *   not_started — nothing recorded (no draft, no submission, no mission signal)
 *   in_progress — sort draft saved, or some mission goal already met
 *   submitted   — at least one sort submission, or a mission submission
 *
 * Drafts count as "started" but never as "submitted" — only an explicit
 * Submit does (same rule the student side follows).
 */

import { q, one } from "./db.js";
import { classModuleCatalog, hiddenClassModuleKeys } from "./class-modules.js";
import { getActivity, attemptsFor, draftFor, answerKeyFor } from "./sorting.js";
import { getClassPost, portfolioMissionState, latestClassPostSubmission } from "./class-posts.js";

export type ModuleStatus = "not_started" | "in_progress" | "submitted";

export interface ModuleSummary {
  key: string;
  kind: "sort" | "post";
  id: string;
  moduleNumber: number;
  title: string;
  status: ModuleStatus;
  partsDone: number;
  partsTotal: number;
  partsLabel: "placed" | "correct" | "goals";
  detail?: Record<string, any>;
}

interface StudentRef { id: string; classId: string | null }

async function studentsIn(classId: string | null): Promise<StudentRef[]> {
  return classId
    ? q<any>(`SELECT id, class_id AS classId FROM users WHERE role = 'student' AND class_id = ? ORDER BY name`, [classId])
    : q<any>(`SELECT id, class_id AS classId FROM users WHERE role = 'student' ORDER BY name`);
}

/** Modules the students of this class actually see (hidden ones excluded). */
async function visibleCatalog(classId: string | null) {
  const [catalog, hidden] = await Promise.all([classModuleCatalog(classId), hiddenClassModuleKeys(classId)]);
  return catalog.filter((m) => !hidden.has(m.key));
}

function missionGoalsMet(checks: Record<string, boolean>): number {
  return Object.values(checks).filter(Boolean).length;
}

/**
 * Roster feed: started / completed counts per student across visible modules.
 * Batched: two grouped queries for sorts, one for missions, and live mission
 * state only for students who have not submitted (the ledger read per student).
 */
async function progressForGroup(classId: string | null, students: StudentRef[]): Promise<{
  modules: { key: string; title: string; moduleNumber: number; kind: string }[];
  students: Record<string, { assigned: number; started: number; completed: number }>;
}> {
  const modules = await visibleCatalog(classId);
  const out: Record<string, { assigned: number; started: number; completed: number }> = {};
  for (const s of students) out[s.id] = { assigned: modules.length, started: 0, completed: 0 };

  const sortIds = modules.filter((m) => m.kind === "sort").map((m) => m.id);
  const postIds = modules.filter((m) => m.kind === "post").map((m) => m.id);

  const submittedSorts: Record<string, Set<string>> = {}; // userId -> activityIds
  const draftedSorts: Record<string, Set<string>> = {};
  const submittedPosts: Record<string, Set<string>> = {};

  if (sortIds.length) {
    const marks = sortIds.map(() => "?").join(",");
    const subs = await q<{ activity_id: string; user_id: string }>(
      `SELECT DISTINCT activity_id, user_id FROM sort_submissions WHERE activity_id IN (${marks})`, sortIds,
    );
    const drafts = await q<{ activity_id: string; user_id: string }>(
      `SELECT DISTINCT activity_id, user_id FROM sort_drafts WHERE activity_id IN (${marks})`, sortIds,
    );
    for (const r of subs) (submittedSorts[r.user_id] ??= new Set()).add(r.activity_id);
    for (const r of drafts) (draftedSorts[r.user_id] ??= new Set()).add(r.activity_id);
  }
  if (postIds.length) {
    const marks = postIds.map(() => "?").join(",");
    const subs = await q<{ post_id: string; user_id: string }>(
      `SELECT DISTINCT post_id, user_id FROM class_post_submissions WHERE post_id IN (${marks})`, postIds,
    );
    for (const r of subs) (submittedPosts[r.user_id] ??= new Set()).add(r.post_id);
  }

  // Mission "started" without a submission: any goal already met in the live
  // portfolio (first three buys = baselineReady flips on the first real work).
  const missionPosts = [];
  for (const id of postIds) missionPosts.push(await getClassPost(id));
  const liveMissionStarted: Record<string, Set<string>> = {};
  for (const post of missionPosts) {
    if (!post) continue;
    for (const s of students) {
      if (submittedPosts[s.id]?.has(post.id)) continue;
      const state = await portfolioMissionState(post, s.id);
      if (missionGoalsMet(state.checks) > 0) (liveMissionStarted[s.id] ??= new Set()).add(post.id);
    }
  }

  const mark = (userId: string, submitted: boolean) => {
    const row = out[userId];
    if (!row) return;
    row.started += 1;
    if (submitted) row.completed += 1;
  };

  for (const s of students) {
    for (const id of sortIds) {
      const sub = submittedSorts[s.id]?.has(id);
      const draft = draftedSorts[s.id]?.has(id);
      if (sub || draft) mark(s.id, !!sub);
    }
    for (const id of postIds) {
      const sub = submittedPosts[s.id]?.has(id);
      const live = liveMissionStarted[s.id]?.has(id);
      if (sub || live) mark(s.id, !!sub);
    }
  }

  return {
    modules: modules.map((m) => ({ key: m.key, title: m.title, moduleNumber: m.moduleNumber, kind: m.kind })),
    students: out,
  };
}

export async function moduleProgress(classId: string | null): Promise<{
  modules: { key: string; title: string; moduleNumber: number; kind: string }[];
  students: Record<string, { assigned: number; started: number; completed: number }>;
}> {
  const students = await studentsIn(classId);
  if (classId) return progressForGroup(classId, students);

  // “All students” still respects each student's own period visibility. A
  // global catalog would over-count modules hidden from one class and miss
  // modules published only to another, so calculate once per class group.
  const groups = new Map<string | null, StudentRef[]>();
  for (const student of students) {
    const group = groups.get(student.classId) ?? [];
    group.push(student); groups.set(student.classId, group);
  }
  const allModules = new Map<string, { key: string; title: string; moduleNumber: number; kind: string }>();
  const progress: Record<string, { assigned: number; started: number; completed: number }> = {};
  for (const [groupClassId, groupStudents] of groups) {
    const group = await progressForGroup(groupClassId, groupStudents);
    for (const module of group.modules) allModules.set(module.key, module);
    Object.assign(progress, group.students);
  }
  return {
    modules: [...allModules.values()].sort((a, b) => a.moduleNumber - b.moduleNumber || a.key.localeCompare(b.key)),
    students: progress,
  };
}

/** Drawer feed: one summary row per module for one student, detail included. */
export async function studentModuleDetail(userId: string): Promise<ModuleSummary[]> {
  const user = await one<{ class_id: string | null }>(`SELECT class_id FROM users WHERE id = ?`, [userId]);
  const modules = await visibleCatalog(user?.class_id ?? null);
  const out: ModuleSummary[] = [];

  for (const mod of modules) {
    if (mod.kind === "sort") {
      const act = await getActivity(mod.id);
      if (!act) continue;
      const attempts = await attemptsFor(act.id, userId);
      const draft = attempts.length ? null : await draftFor(act.id, userId);
      const best = attempts.reduce((b: any, r: any) => (!b || r.correct_count > b.correct_count ? r : b), null);
      const total = act.tokens.length;
      const draftPlaced = draft ? Object.keys(draft.placements).length : 0;
      const status: ModuleStatus = attempts.length ? "submitted" : draft ? "in_progress" : "not_started";
      out.push({
        key: mod.key, kind: "sort", id: mod.id, moduleNumber: mod.moduleNumber, title: mod.title,
        status,
        partsDone: attempts.length && best ? best.correct_count : draftPlaced,
        partsTotal: total,
        partsLabel: attempts.length ? "correct" : "placed",
        detail: {
          attempts: attempts.length,
          lastAt: attempts.length ? attempts[0].created_at : null, // attemptsFor orders DESC
          bestCorrect: best ? best.correct_count : null,
          answerKey: answerKeyFor(act),
          bestPlacements: best ? JSON.parse(best.placements) : null,
          tokens: act.tokens.map((t: any) => String(t.ticker)),
          hasDraft: !!draft,
          draftPlaced,
        },
      });
    } else {
      const post = await getClassPost(mod.id);
      if (!post) continue;
      const submission = await latestClassPostSubmission(post.id, userId);
      const state = await portfolioMissionState(post, userId);
      const evidence = submission ? JSON.parse(submission.evidence) : null;
      const response = submission ? JSON.parse(submission.response) : null;
      const checks = evidence?.checks ?? state.checks;
      const counts = evidence?.counts ?? state.counts;
      const goalsTotal = Object.keys(state.checks).length;
      const goalsDone = missionGoalsMet(checks);
      const status: ModuleStatus = submission ? "submitted" : missionGoalsMet(state.checks) > 0 ? "in_progress" : "not_started";
      out.push({
        key: mod.key, kind: "post", id: mod.id, moduleNumber: mod.moduleNumber, title: mod.title,
        status,
        partsDone: goalsDone, partsTotal: goalsTotal, partsLabel: "goals",
        detail: {
          submittedAt: submission?.createdAt ?? null,
          checks, counts,
          baselineTickers: evidence?.baselineTickers ?? state.baselineTickers,
          baselineSectors: evidence?.baselineSectors ?? state.baselineSectors,
          targets: state.targets,
          liveChecks: state.checks,
          liveCounts: state.counts,
          picks: response?.picks ?? null,
          reflection: response?.reflection ?? null,
        },
      });
    }
  }
  return out;
}
