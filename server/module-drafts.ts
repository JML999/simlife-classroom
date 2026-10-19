/** Partial mission write-ups are drafts, never proof of completion or submissions. */
import { type ClassPost, ClassPostError } from "./class-posts.js";
import { one, run, nowIso } from "./db.js";
import { classModuleKey, hiddenClassModuleKeys } from "./class-modules.js";
import { saveCollegeDraft } from "./college.js";
export async function saveModuleDraft(post: ClassPost, userId: string, value: any) {
  if (post.kind === "college_pathways") return saveCollegeDraft(post, userId, value);
  const user = await one<{ role: string; class_id: string | null }>(`SELECT role, class_id FROM users WHERE id = ?`, [userId]);
  if (!user || user.role !== "student" || !["portfolio_mission", "etf_mission"].includes(post.kind) || post.status !== "published"
    || (post.classId && post.classId !== user.class_id) || (await hiddenClassModuleKeys(user.class_id)).has(classModuleKey("post", post.id))) {
    throw new ClassPostError("NOT_FOUND", "Assignment not found.");
  }
  const text = (v: unknown) => {
    if (v != null && typeof v !== "string") throw new ClassPostError("INVALID_INPUT", "Answers must be text.");
    return String(v ?? "");
  };
  const response = post.kind === "portfolio_mission"
    ? { picks: [0, 1, 2].map(i => ({ ticker: text(value?.picks?.[i]?.ticker), thesis: text(value?.picks?.[i]?.thesis) })), reflection: text(value?.reflection) }
    : { gapTicker: text(value?.gapTicker), convictionTicker: text(value?.convictionTicker), gapExplanation: text(value?.gapExplanation), convictionExplanation: text(value?.convictionExplanation) };
  const updatedAt = nowIso();
  await run(`INSERT INTO class_post_drafts (post_id, user_id, response, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(post_id, user_id) DO UPDATE SET response = excluded.response, updated_at = excluded.updated_at`,
    [post.id, userId, JSON.stringify(response), updatedAt]);
  return { response, updatedAt };
}
