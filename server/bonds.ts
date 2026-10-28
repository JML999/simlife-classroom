import { BOND_POST_ID, BOND_QUESTIONS, type BondResponse } from "../shared/bonds.js";
import { type ClassPost, ClassPostError } from "./class-posts.js";
import { classModuleKey, hiddenClassModuleKeys } from "./class-modules.js";
import { holdingsFor } from "./ledger.js";
import { loadDirectory } from "./quotes.js";
import { one, run, withTx, newId, nowIso } from "./db.js";

export async function ensureBondAssignment() {
  await run(`INSERT INTO class_posts (id,kind,class_id,title,summary,body,spec,hero_url,status,created_at)
    VALUES (?,'bond_mission',NULL,?,?,?,'{}','/module-art/bonds.svg','published',?) ON CONFLICT(id) DO NOTHING`,
    [BOND_POST_ID, "Interest Rates and Bonds", "Check the basics. Add a bond ETF to your portfolio and explain your choice.",
      "Answer five quick questions. Hold at least one bond ETF in SimLife, choose it below, and explain why it fits your portfolio and one risk you accept. A bond ETF you already hold counts. You can save or submit unfinished work at any time.", nowIso()]);
}
export function cleanBondResponse(value: any): BondResponse {
  const text = (v: unknown) => { if (v != null && typeof v !== "string") throw new ClassPostError("INVALID_INPUT", "Answers must be text."); return String(v ?? "").trim(); };
  const answers = Object.fromEntries(BOND_QUESTIONS.map(q => {
    const answer = text(value?.answers?.[q.id]);
    if (answer && !q.options.some((_, i) => String(i) === answer)) throw new ClassPostError("INVALID_INPUT", "Choose one of the listed answers.");
    return [q.id, answer];
  }));
  const ticker = text(value?.ticker).toUpperCase(), explanation = text(value?.explanation);
  if (ticker.length > 12 || explanation.length > 6000) throw new ClassPostError("INVALID_INPUT", "This answer is too long to save.");
  return { answers, ticker, explanation };
}
export async function bondAccess(post: ClassPost, userId: string) {
  const user = await one<any>(`SELECT role,class_id FROM users WHERE id=?`, [userId]);
  if (!user || user.role !== "student" || post.kind !== "bond_mission" || post.status !== "published" ||
    (post.classId && post.classId !== user.class_id) || (await hiddenClassModuleKeys(user.class_id)).has(classModuleKey("post", post.id))) throw new ClassPostError("NOT_FOUND", "Assignment not found.");
}
/** Recognize all catalog bond funds, not just the four lesson examples. No quote dependency. */
export async function bondMissionState(_post: ClassPost, userId: string) {
  const directory = new Map(loadDirectory().filter(f => f.kind === "ETF" && f.assetClass === "BOND").map(f => [f.ticker, f]));
  const { holdings } = await holdingsFor(userId, () => null);
  const bonds = holdings.filter(h => directory.has(h.ticker) && h.qtyMicro > 0).map(h => ({ ticker: h.ticker, name: directory.get(h.ticker)!.name, shares: h.shares }));
  return { bonds, met: bonds.length > 0, checkedAt: nowIso() };
}
export function bondAnswerEvidence(response: BondResponse, state: Awaited<ReturnType<typeof bondMissionState>>) {
  const answered = BOND_QUESTIONS.filter(q => !!response.answers[q.id]).length;
  const correct = BOND_QUESTIONS.filter(q => response.answers[q.id] === String(q.answer)).length;
  return { ...state, answered, correct, questionTotal: BOND_QUESTIONS.length, selectedHeld: state.bonds.some(b => b.ticker === response.ticker), explained: !!response.explanation.trim() };
}
export async function saveBondDraft(post: ClassPost, userId: string, value: any) {
  await bondAccess(post, userId);
  const response = cleanBondResponse(value), updatedAt = nowIso();
  await run(`INSERT INTO class_post_drafts (post_id,user_id,response,updated_at) VALUES (?,?,?,?) ON CONFLICT(post_id,user_id) DO UPDATE SET response=excluded.response,updated_at=excluded.updated_at`, [post.id,userId,JSON.stringify(response),updatedAt]);
  return { response, updatedAt };
}
export async function submitBondMission(opts: { post: ClassPost; userId: string; response: any; idempotencyKey?: string }) {
  await bondAccess(opts.post, opts.userId);
  const response = cleanBondResponse(opts.response);
  return withTx(async t => {
    await t.one(`SELECT id FROM users WHERE id=?${t.dialect === "pg" ? " FOR UPDATE" : ""}`, [opts.userId]);
    if (opts.idempotencyKey) {
      const previous = await t.one<any>(`SELECT post_id,user_id,response,created_at FROM class_post_submissions WHERE idempotency_key=?`, [opts.idempotencyKey]);
      if (previous) {
        if (previous.post_id !== opts.post.id || previous.user_id !== opts.userId || previous.response !== JSON.stringify(response)) throw new ClassPostError("INVALID_INPUT", "This submission confirmation was already used for different answers.");
        return { submittedAt: previous.created_at, deduped: true };
      }
    }
    const evidence = bondAnswerEvidence(response, await bondMissionState(opts.post,opts.userId)), submittedAt = nowIso();
    await t.run(`INSERT INTO class_post_submissions (id,post_id,user_id,response,evidence,idempotency_key,created_at) VALUES (?,?,?,?,?,?,?)`, [newId("csub"),opts.post.id,opts.userId,JSON.stringify(response),JSON.stringify(evidence),opts.idempotencyKey??null,submittedAt]);
    await t.run(`DELETE FROM class_post_drafts WHERE post_id=? AND user_id=?`, [opts.post.id,opts.userId]);
    return { submittedAt, deduped: false };
  });
}
