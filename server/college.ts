/** College planning responses are student work, independent of portfolio holdings. */
import { COLLEGE_ROUTES, COLLEGE_RESEARCH_TOPICS, COLLEGE_PROGRAM_FIELDS, emptyCollegeResearch, collegeResearchDone, type CollegeResearchResponse } from "../shared/college-research.js";
import { one, run, withTx, newId, nowIso } from "./db.js";
import { ClassPostError, type ClassPost } from "./class-posts.js";
import { classModuleKey, hiddenClassModuleKeys } from "./class-modules.js";

export const COLLEGE_FIELDS = ["name", "goal", "training", "advantages", "drawbacks", "questions"] as const;
export type CollegePath = Record<typeof COLLEGE_FIELDS[number], string>;
export type CollegeResponse = { paths: CollegePath[]; leaning: string; reason: string; nextStep: string };
export function cleanCollegeResponse(value: any, complete = false): CollegeResponse | CollegeResearchResponse {
  const clean = (v: unknown) => {
    if (v != null && typeof v !== "string") throw new ClassPostError("INVALID_INPUT", "Answers must be text.");
    const text = String(v ?? "").trim();
    if (text.length > 6000) throw new ClassPostError("INVALID_INPUT", "An answer is too long. Keep each response under 6,000 characters.");
    return text;
  };
  if (value?.version === 2) {
    const response = emptyCollegeResearch();
    response.routes = COLLEGE_ROUTES.map((_, i) => {
      const route = value.routes?.[i];
      const institution = clean(route?.institution) || "default";
      if (!["default", "other"].includes(institution)) throw new ClassPostError("INVALID_INPUT", "Choose the listed institution or Other.");
      return { institution, otherInstitution: clean(route?.otherInstitution),
        research: Object.fromEntries(COLLEGE_RESEARCH_TOPICS.map(t => [t.id, Object.fromEntries(["program", "figure", "source"].map(k => [k, clean(route?.research?.[t.id]?.[k])]))])) as CollegeResearchResponse["routes"][number]["research"],
        programs: [0, 1].map(j => Object.fromEntries(COLLEGE_PROGRAM_FIELDS.map(([k]) => [k, clean(route?.programs?.[j]?.[k])])) as CollegeResearchResponse["routes"][number]["programs"][number]) };
    });
    response.reflection = clean(value.reflection);
    if (value.previousWork?.paths && value.previousWork.version !== 2) response.previousWork = cleanCollegeResponse(value.previousWork);
    if (complete && collegeResearchDone(response) !== 5) throw new ClassPostError("INVALID_INPUT", "Finish the research and both program comparisons for all four routes, then your reflection.");
    return response;
  }
  const paths = [0, 1].map(i => Object.fromEntries(COLLEGE_FIELDS.map(k => [k, clean(value?.paths?.[i]?.[k])])) as CollegePath);
  const response = { paths, leaning: clean(value?.leaning), reason: clean(value?.reason), nextStep: clean(value?.nextStep) };
  if (response.leaning && !["A", "B", "undecided"].includes(response.leaning)) throw new ClassPostError("INVALID_INPUT", "Choose path A, path B, or still exploring.");
  if (complete && collegePartsDone(response) !== 15) throw new ClassPostError("INVALID_INPUT", "Compare both paths, explain your choice, and add one next step before submitting.");
  return response;
}
export function collegePartsTotal(response: any): number { return response?.version === 2 ? 5 : 15; }
export function collegePartsDone(response: any): number {
  if (response?.version === 2) return collegeResearchDone(response);
  return [0, 1].reduce((n, i) => n + COLLEGE_FIELDS.filter(k => String(response?.paths?.[i]?.[k] || "").trim()).length, 0)
    + ["leaning", "reason", "nextStep"].filter(k => String(response?.[k] || "").trim()).length;
}
export async function collegeDraftFor(postId: string, userId: string) {
  const row = await one<{ response: string; updated_at: string }>(`SELECT response, updated_at FROM class_post_drafts WHERE post_id = ? AND user_id = ?`, [postId, userId]);
  return row ? { response: JSON.parse(row.response), updatedAt: row.updated_at } : null;
}
async function access(post: ClassPost, userId: string) {
  const user = await one<{ role: string; class_id: string | null }>(`SELECT role, class_id FROM users WHERE id = ?`, [userId]);
  if (!user || user.role !== "student" || post.kind !== "college_pathways" || post.status !== "published" ||
      (post.classId && post.classId !== user.class_id) || (await hiddenClassModuleKeys(user.class_id)).has(classModuleKey("post", post.id))) {
    throw new ClassPostError("NOT_FOUND", "College assignment not found.");
  }
}
export async function saveCollegeDraft(post: ClassPost, userId: string, value: any) {
  await access(post, userId);
  const response = cleanCollegeResponse(value);
  const updatedAt = nowIso();
  await run(`INSERT INTO class_post_drafts (post_id, user_id, response, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(post_id, user_id) DO UPDATE SET response = excluded.response, updated_at = excluded.updated_at`,
    [post.id, userId, JSON.stringify(response), updatedAt]);
  return { response, updatedAt };
}
export async function submitCollegePaths(opts: { post: ClassPost; userId: string; response: any; idempotencyKey?: string }) {
  await access(opts.post, opts.userId);
  if (opts.response?.version !== 2) throw new ClassPostError("INVALID_INPUT", "This assignment has been revised. Complete the four-route research worksheet before submitting.");
  const response = cleanCollegeResponse(opts.response, true);
  return withTx(async tx => {
    // Per-student lock also serializes simultaneous submission retries on Postgres.
    await tx.one(`SELECT id FROM users WHERE id = ?${tx.dialect === "pg" ? " FOR UPDATE" : ""}`, [opts.userId]);
    if (opts.idempotencyKey) {
      const previous = await tx.one<{ post_id: string; user_id: string; response: string; created_at: string }>(`SELECT * FROM class_post_submissions WHERE idempotency_key = ?`, [opts.idempotencyKey]);
      if (previous) {
        if (previous.post_id !== opts.post.id || previous.user_id !== opts.userId || previous.response !== JSON.stringify(response)) throw new ClassPostError("INVALID_INPUT", "This submission confirmation was already used for different answers.");
        return { submittedAt: previous.created_at, deduped: true };
      }
    }
    const submittedAt = nowIso();
    await tx.run(`INSERT INTO class_post_submissions (id, post_id, user_id, response, evidence, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [newId("csub"), opts.post.id, opts.userId, JSON.stringify(response), JSON.stringify({ kind: "college_pathways", partsDone: collegePartsDone(response), responseVersion: 2 }), opts.idempotencyKey ?? null, submittedAt]);
    await tx.run(`DELETE FROM class_post_drafts WHERE post_id = ? AND user_id = ?`, [opts.post.id, opts.userId]);
    return { submittedAt, deduped: false };
  });
}
/** Revise the shared brief once; keep visibility, identity and saved student work. */
export async function ensureCollegeAssignment() {
  const id = "cpost_college_paths_v1";
  const title = "Explore four paths after high school";
  const summary = "Research pay and employment, investigate four schools, and compare two paths that fit you.";
  const body = "For each of four education routes, research higher and lower pay and stronger and weaker employment prospects using independent sources. Then review the selected school’s offerings and identify one financially promising and one financially challenging program. Record the program, career, typical annual earnings, training duration, a rough total tuition-and-fees estimate before aid (excluding living expenses), sources, and the financial trade-off. Finish by explaining two specific paths that make financial and academic sense for you. Research first; the comparison explorer unlocks after you submit.";
  await run(`INSERT INTO class_posts (id, kind, class_id, title, summary, body, spec, hero_url, status, created_at)
    VALUES (?, 'college_pathways', NULL, ?, ?, ?, '{"responseVersion":2}', '/module-art/college-paths.svg', 'published', ?)
    ON CONFLICT(id) DO NOTHING`, [id, title, summary, body, nowIso()]);
  const existing = await one<{ spec: string; title: string }>(`SELECT spec, title FROM class_posts WHERE id = ?`, [id]);
  if (existing && JSON.parse(existing.spec || "{}").responseVersion !== 2) {
    const spec = { ...JSON.parse(existing.spec || "{}"), responseVersion: 2 };
    await run(`UPDATE class_posts SET title = ?, summary = ?, body = ?, spec = ? WHERE id = ? AND spec = ?`,
      [existing.title === "My next step after high school" ? title : existing.title, summary, body, JSON.stringify(spec), id, existing.spec]);
  }
}
