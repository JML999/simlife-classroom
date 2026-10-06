/** College planning responses are student work, independent of portfolio holdings. */
import { one, run, withTx, newId, nowIso } from "./db.js";
import { ClassPostError, type ClassPost } from "./class-posts.js";
import { classModuleKey, hiddenClassModuleKeys } from "./class-modules.js";

export const COLLEGE_FIELDS = ["name", "goal", "training", "advantages", "drawbacks", "questions"] as const;
export type CollegePath = Record<typeof COLLEGE_FIELDS[number], string>;
export type CollegeResponse = { paths: CollegePath[]; leaning: string; reason: string; nextStep: string };
export function cleanCollegeResponse(value: any, complete = false): CollegeResponse {
  const clean = (v: unknown) => {
    if (v != null && typeof v !== "string") throw new ClassPostError("INVALID_INPUT", "Answers must be text.");
    const text = String(v ?? "").trim();
    if (text.length > 6000) throw new ClassPostError("INVALID_INPUT", "An answer is too long. Keep each response under 6,000 characters.");
    return text;
  };
  const paths = [0, 1].map(i => Object.fromEntries(COLLEGE_FIELDS.map(k => [k, clean(value?.paths?.[i]?.[k])])) as CollegePath);
  const response = { paths, leaning: clean(value?.leaning), reason: clean(value?.reason), nextStep: clean(value?.nextStep) };
  if (response.leaning && !["A", "B", "undecided"].includes(response.leaning)) throw new ClassPostError("INVALID_INPUT", "Choose path A, path B, or still exploring.");
  if (complete && collegePartsDone(response) !== 15) throw new ClassPostError("INVALID_INPUT", "Compare both paths, explain your choice, and add one next step before submitting.");
  return response;
}
export function collegePartsDone(response: any): number {
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
      [newId("csub"), opts.post.id, opts.userId, JSON.stringify(response), JSON.stringify({ kind: "college_pathways", partsDone: 15 }), opts.idempotencyKey ?? null, submittedAt]);
    await tx.run(`DELETE FROM class_post_drafts WHERE post_id = ? AND user_id = ?`, [opts.post.id, opts.userId]);
    return { submittedAt, deduped: false };
  });
}
/** One shared assignment, available on deployment. Never overwrites teacher visibility or edits. */
export async function ensureCollegeAssignment() {
  await run(`INSERT INTO class_posts (id, kind, class_id, title, summary, body, spec, hero_url, status, created_at)
    VALUES (?, 'college_pathways', NULL, ?, ?, ?, '{}', '/module-art/college-paths.svg', 'published', ?)
    ON CONFLICT(id) DO NOTHING`, ["cpost_college_paths_v1", "My next step after high school",
      "Compare two paths toward a career or opportunity you care about. Choose one next step for this week.",
      "Compare two routes that make sense for you: four-year college, community college (including transfer), technical school, an apprenticeship, or working now with a specific plan for future training. You can compare two schools or programs if college is already your plan. Identify the opportunity each route could lead to, the education or training required, two advantages, two costs or drawbacks, and information you still need. Then explain which path you are leaning toward and one specific step you can take this week. Still exploring is a valid choice. A next step could be an application, scholarship search, program inquiry, or apprenticeship search. No student-loan calculation or investment purchase is required.", nowIso()]);
}
