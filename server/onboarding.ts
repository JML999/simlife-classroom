import { newId, nowIso, withTx, type Tx } from "./db.js";
import crypto from "node:crypto";

export type ImportedProfileValues = {
  fullName: string;
  externalRef?: string | null;
  jobTitle?: string | null;
  jobPayCents?: number | null;
  checkingCents?: number | null;
  savingsCents?: number | null;
  brokerageCents?: number | null;
  carPaymentCents?: number | null;
  rentCents?: number | null;
};

export class OnboardingError extends Error {
  constructor(public code: "INVALID_INPUT" | "NOT_FOUND" | "CONFLICT" | "FORBIDDEN", message: string) { super(message); }
}

export function normalizeStudentName(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function nullableText(raw: unknown, max: number): string | null {
  if (raw == null || String(raw).trim() === "") return null;
  return String(raw).trim().slice(0, max);
}

function nullableCents(raw: unknown, label: string): number | null {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 100_000_00) throw new OnboardingError("INVALID_INPUT", `${label} must be blank or between $0 and $100,000.`);
  return n;
}

function cleanValues(raw: any): ImportedProfileValues {
  const fullName = String(raw?.fullName || raw?.name || "").trim();
  if (fullName.length < 2 || fullName.length > 100) throw new OnboardingError("INVALID_INPUT", "Every imported row needs a student name (2–100 characters).");
  return {
    fullName,
    externalRef: nullableText(raw?.externalRef, 120),
    jobTitle: nullableText(raw?.jobTitle, 80),
    jobPayCents: nullableCents(raw?.jobPayCents, "Job pay"),
    checkingCents: nullableCents(raw?.checkingCents, "Checking"),
    savingsCents: nullableCents(raw?.savingsCents, "Savings"),
    brokerageCents: nullableCents(raw?.brokerageCents, "Brokerage cash"),
    carPaymentCents: nullableCents(raw?.carPaymentCents, "Car payment"),
    rentCents: nullableCents((raw as any)?.rentCents, "Rent"),
  };
}

export async function importRosterProfiles(opts: { classId: string; actorId: string; sourceLabel: string; importKey: string; rows: any[] }) {
  const source = String(opts.sourceLabel || "Class roster import").trim().slice(0, 160);
  if (!opts.classId || !opts.importKey || source.length < 2) throw new OnboardingError("INVALID_INPUT", "Class, source label, and import key are required.");
  if (!Array.isArray(opts.rows) || !opts.rows.length || opts.rows.length > 200) throw new OnboardingError("INVALID_INPUT", "Import between 1 and 200 students at a time.");
  const rows = opts.rows.map(cleanValues);
  // The client key protects an in-flight click; this server-derived key also
  // makes re-pasting the identical class file safe after a reload/new session.
  const stableImportKey = `content:${crypto.createHash("sha256").update(JSON.stringify({ classId: opts.classId, source, rows })).digest("hex")}`;
  return withTx(async (t) => {
    if (!(await t.one(`SELECT id FROM classes WHERE id = ?`, [opts.classId]))) throw new OnboardingError("NOT_FOUND", "Class not found.");
    const existing = await t.one<{ id: string }>(`SELECT id FROM roster_imports WHERE import_key = ?`, [stableImportKey]);
    if (existing) {
      const count = await t.one<{ n: number }>(`SELECT COUNT(*) AS n FROM roster_profiles WHERE import_id = ?`, [existing.id]);
      return { importId: existing.id, count: Number(count?.n || 0), deduped: true };
    }
    const importId = newId("rimp");
    const now = nowIso();
    await t.run(`INSERT INTO roster_imports (id, class_id, created_by, source_label, import_key, created_at) VALUES (?, ?, ?, ?, ?, ?)`, [importId, opts.classId, opts.actorId, source, stableImportKey, now]);
    for (const row of rows) {
      await t.run(`INSERT INTO roster_profiles
        (id, import_id, class_id, external_ref, full_name, normalized_name, job_title, job_pay_cents, checking_cents, savings_cents, brokerage_cents, car_payment_cents, rent_cents, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unclaimed', ?)`,
        [newId("rp"), importId, opts.classId, row.externalRef ?? null, row.fullName, normalizeStudentName(row.fullName), row.jobTitle ?? null, row.jobPayCents ?? null, row.checkingCents ?? null, row.savingsCents ?? null, row.brokerageCents ?? null, row.carPaymentCents ?? null, row.rentCents ?? null, now]);
    }
    return { importId, count: rows.length, deduped: false };
  });
}

const publicColumns = `id, class_id, full_name, job_title, job_pay_cents, checking_cents, savings_cents, brokerage_cents, car_payment_cents, rent_cents, status, claimed_by, proposed_json, claimed_at, reviewed_at`;

export async function onboardingStatus(userId: string) {
  return withTx(async (t) => {
    const user = await t.one<{ id: string; name: string; class_id: string | null }>(`SELECT id, name, class_id FROM users WHERE id = ?`, [userId]);
    if (!user?.class_id) return { state: "no_class", candidates: [] };
    const claimed = await t.one<any>(`SELECT ${publicColumns} FROM roster_profiles WHERE claimed_by = ? AND class_id = ?`, [userId, user.class_id]);
    if (claimed) return { state: claimed.status, profile: claimed, candidates: [] };
    const matches = await t.q<any>(`SELECT ${publicColumns} FROM roster_profiles WHERE class_id = ? AND normalized_name = ? AND status = 'unclaimed' ORDER BY created_at DESC`, [user.class_id, normalizeStudentName(user.name)]);
    if (matches.length > 1) return { state: "ambiguous", candidates: [] };
    return { state: matches.length === 1 ? "match" : "no_match", candidates: matches };
  });
}

function valuesFromProfile(profile: any, override?: any): ImportedProfileValues {
  const base = {
    fullName: profile.full_name,
    jobTitle: profile.job_title,
    jobPayCents: profile.job_pay_cents == null ? null : Number(profile.job_pay_cents),
    checkingCents: profile.checking_cents == null ? null : Number(profile.checking_cents),
    savingsCents: profile.savings_cents == null ? null : Number(profile.savings_cents),
    brokerageCents: profile.brokerage_cents == null ? null : Number(profile.brokerage_cents),
    carPaymentCents: profile.car_payment_cents == null ? null : Number(profile.car_payment_cents),
    rentCents: (profile as any).rent_cents == null ? null : Number((profile as any).rent_cents),
  };
  return override ? cleanValues({ ...base, ...override }) : base;
}

async function applyProfile(t: Tx, profile: any, userId: string, actorId: string, values: ImportedProfileValues) {
  const fu = t.dialect === "pg" ? " FOR UPDATE" : "";
  const user = await t.one<any>(`SELECT id, car_payment_cents, rent_cents FROM users WHERE id = ? AND role = 'student'${fu}`, [userId]);
  if (!user) throw new OnboardingError("NOT_FOUND", "Student account not found.");
  const now = nowIso();
  // Never wipe teacher-set expenses with a blank import cell: keep existing when the profile is blank.
  const car = values.carPaymentCents ?? (user.car_payment_cents == null ? null : Number(user.car_payment_cents));
  const rent = values.rentCents ?? ((user as any).rent_cents == null ? null : Number((user as any).rent_cents));
  await t.run(`UPDATE users SET job_title = ?, job_pay_cents = ?, car_payment_cents = ?, rent_cents = ?, job_updated_at = ? WHERE id = ?`, [values.jobTitle ?? null, values.jobPayCents ?? null, car, rent, now, userId]);

  const checking = values.checkingCents ?? 0;
  const savings = values.savingsCents ?? 0;
  if (checking || savings) {
    let bank = await t.one<any>(`SELECT id, checking_cents, savings_cents FROM bank_accounts WHERE user_id = ?${fu}`, [userId]);
    if (!bank) {
      const id = newId("bac");
      await t.run(`INSERT INTO bank_accounts (id, user_id, checking_cents, savings_cents, interest_residual_micros, interest_accrued_at, created_at) VALUES (?, ?, 0, 0, 0, ?, ?)`, [id, userId, now, now]);
      bank = { id, checking_cents: 0, savings_cents: 0 };
    }
    await t.run(`INSERT INTO bank_journal (id, bank_account_id, kind, checking_leg, savings_leg, memo, actor_id, idempotency_key, related_id, created_at) VALUES (?, ?, 'opening_balance', ?, ?, ?, ?, ?, ?, ?)`,
      [newId("bj"), bank.id, checking, savings, "Confirmed preloaded SimLife opening balances", actorId, `onboard:${profile.id}:bank`, profile.id, now]);
    await t.run(`UPDATE bank_accounts SET checking_cents = ?, savings_cents = ? WHERE id = ?`, [Number(bank.checking_cents) + checking, Number(bank.savings_cents) + savings, bank.id]);
  }

  const brokerage = values.brokerageCents ?? 0;
  if (brokerage) {
    let acct = await t.one<any>(`SELECT id, cash_cents FROM accounts WHERE user_id = ?${fu}`, [userId]);
    if (!acct) {
      const id = newId("acct");
      await t.run(`INSERT INTO accounts (id, user_id, cash_cents, created_at) VALUES (?, ?, 0, ?)`, [id, userId, now]);
      acct = { id, cash_cents: 0 };
    }
    await t.run(`INSERT INTO ledger (id, account_id, kind, amount_cents, reason, actor_id, idempotency_key, created_at) VALUES (?, ?, 'cash_adjust', ?, ?, ?, ?, ?)`,
      [newId("le"), acct.id, brokerage, "Confirmed preloaded SimLife opening brokerage balance", actorId, `onboard:${profile.id}:brokerage`, now]);
    await t.run(`UPDATE accounts SET cash_cents = ? WHERE id = ?`, [Number(acct.cash_cents) + brokerage, acct.id]);
  }
  await t.run(`UPDATE roster_profiles SET status = 'claimed', claimed_by = ?, claimed_at = ?, reviewed_by = ?, reviewed_at = ?, proposed_json = NULL WHERE id = ?`, [userId, now, actorId, now, profile.id]);
}

async function markMatched(t: Tx, profileId: string, userId: string, actorId: string) {
  const now = nowIso();
  await t.run(`UPDATE roster_profiles SET status = 'matched', claimed_by = ?, claimed_at = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?`, [userId, now, actorId, now, profileId]);
}

export async function claimRosterProfile(opts: { userId: string; profileId: string; proposed?: any }) {
  return withTx(async (t) => {
    const fu = t.dialect === "pg" ? " FOR UPDATE" : "";
    const user = await t.one<any>(`SELECT id, name, class_id FROM users WHERE id = ? AND role = 'student'${fu}`, [opts.userId]);
    const profile = await t.one<any>(`SELECT * FROM roster_profiles WHERE id = ?${fu}`, [opts.profileId]);
    if (!user || !profile) throw new OnboardingError("NOT_FOUND", "Preloaded profile not found.");
    if (profile.class_id !== user.class_id || normalizeStudentName(user.name) !== profile.normalized_name) throw new OnboardingError("FORBIDDEN", "That profile does not match your signed-in name and class.");
    if (profile.claimed_by && profile.claimed_by !== user.id) throw new OnboardingError("CONFLICT", "That profile has already been claimed.");
    if (profile.status === "matched" || profile.status === "claimed") return { state: profile.status, deduped: true };
    const base = valuesFromProfile(profile);
    if (opts.proposed) {
      const proposed = valuesFromProfile(profile, opts.proposed);
      await t.run(`UPDATE roster_profiles SET status = 'pending', claimed_by = ?, proposed_json = ?, claimed_at = ? WHERE id = ?`, [user.id, JSON.stringify(proposed), nowIso(), profile.id]);
      return { state: "pending", deduped: false };
    }
    await markMatched(t, profile.id, user.id, user.id);
    return { state: "matched", deduped: false };
  });
}

export async function listRosterProfiles(classId?: string) {
  return withTx((t) => t.q<any>(`SELECT p.*, i.source_label FROM roster_profiles p JOIN roster_imports i ON i.id = p.import_id ${classId ? "WHERE p.class_id = ?" : ""} ORDER BY CASE p.status WHEN 'pending' THEN 0 WHEN 'unclaimed' THEN 1 ELSE 2 END, p.full_name`, classId ? [classId] : []));
}

export async function approveRosterProfile(opts: { profileId: string; actorId: string }) {
  return withTx(async (t) => {
    const fu = t.dialect === "pg" ? " FOR UPDATE" : "";
    const profile = await t.one<any>(`SELECT * FROM roster_profiles WHERE id = ?${fu}`, [opts.profileId]);
    if (!profile) throw new OnboardingError("NOT_FOUND", "Preloaded profile not found.");
    if (!profile.claimed_by || profile.status !== "pending") throw new OnboardingError("CONFLICT", "This profile is not awaiting review.");
    const proposed = profile.proposed_json ? valuesFromProfile(profile, JSON.parse(profile.proposed_json)) : valuesFromProfile(profile);
    await t.run(`UPDATE roster_profiles SET full_name = ?, normalized_name = ?, job_title = ?, job_pay_cents = ?, checking_cents = ?, savings_cents = ?, brokerage_cents = ?, car_payment_cents = ?, rent_cents = ?, proposed_json = NULL WHERE id = ?`,
      [proposed.fullName, normalizeStudentName(proposed.fullName), proposed.jobTitle ?? null, proposed.jobPayCents ?? null, proposed.checkingCents ?? null, proposed.savingsCents ?? null, proposed.brokerageCents ?? null, proposed.carPaymentCents ?? null, proposed.rentCents ?? null, profile.id]);
    await markMatched(t, profile.id, profile.claimed_by, opts.actorId);
    return { state: "matched" };
  });
}

export async function assignRosterProfile(opts: { profileId: string; userId: string; actorId: string }) {
  return withTx(async (t) => {
    const fu = t.dialect === "pg" ? " FOR UPDATE" : "";
    const profile = await t.one<any>(`SELECT * FROM roster_profiles WHERE id = ?${fu}`, [opts.profileId]);
    const user = await t.one<any>(`SELECT id, class_id FROM users WHERE id = ? AND role = 'student'${fu}`, [opts.userId]);
    if (!profile || !user) throw new OnboardingError("NOT_FOUND", "Profile or student account not found.");
    if (profile.class_id !== user.class_id) throw new OnboardingError("FORBIDDEN", "The profile and signed-in student must be in the same class.");
    if (profile.status !== "unclaimed" || profile.claimed_by) throw new OnboardingError("CONFLICT", "That profile is no longer unclaimed.");
    await markMatched(t, profile.id, user.id, opts.actorId);
    return { state: "matched" };
  });
}

export async function applyRosterProfile(opts: { profileId: string; actorId: string }) {
  return withTx(async (t) => {
    const fu = t.dialect === "pg" ? " FOR UPDATE" : "";
    const profile = await t.one<any>(`SELECT * FROM roster_profiles WHERE id = ?${fu}`, [opts.profileId]);
    if (!profile) throw new OnboardingError("NOT_FOUND", "Preloaded profile not found.");
    if (!profile.claimed_by || profile.status !== "matched") throw new OnboardingError("CONFLICT", "Match this profile to a student before posting data.");
    await applyProfile(t, profile, profile.claimed_by, opts.actorId, valuesFromProfile(profile));
    return { state: "claimed" };
  });
}
