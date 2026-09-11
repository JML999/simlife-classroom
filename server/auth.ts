/**
 * Auth helpers: join codes, Google verification (google-auth-library),
 * teacher allowlist, demo-mode gate.
 */
import crypto from "node:crypto";
import { OAuth2Client } from "google-auth-library";

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ2346789"; // no look-alikes
export function generateJoinCode(): string {
  const bytes = crypto.randomBytes(6);
  let s = "";
  for (const b of bytes) s += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return s;
}
export function normalizeJoinCode(raw: unknown): string {
  return typeof raw === "string" ? raw.replace(/[\s-]/g, "").toUpperCase() : "";
}
export function validateJoinCode(code: string): boolean {
  return /^[A-Z0-9]{4,12}$/.test(code);
}

export function googleClientId(): string {
  return process.env["SIMLIFE_GOOGLE_CLIENT_ID"] || "";
}
export function allowedDomain(): string {
  const raw = (process.env["SIMLIFE_ALLOWED_GOOGLE_DOMAIN"] || "").trim().toLowerCase();
  // Literal "open" means deliberately unrestricted (any Google account may
  // sign in as a student; teacher role stays email-gated). Anything else is
  // the required Workspace domain.
  return raw === "open" ? "" : raw;
}
const teacherEmails = (): Set<string> =>
  new Set(
    (process.env["SIMLIFE_TEACHER_EMAILS"] || "")
      .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean),
  );
export function isTeacherEmail(email: string): boolean {
  return teacherEmails().has(email.trim().toLowerCase());
}

/** Demo login is possible only with the flag ON and never in production. */
export function demoEnabled(): boolean {
  return process.env["SIMLIFE_DEMO_AUTH"] === "true" && process.env["NODE_ENV"] !== "production";
}

export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string;
}

/**
 * Server-side verification with the supported google-auth-library
 * (signature + aud + exp + iss). NOT the tokeninfo-endpoint approach.
 */
export async function verifyGoogleToken(credential: string): Promise<GoogleIdentity | null> {
  const clientId = googleClientId();
  if (!clientId || typeof credential !== "string" || !credential) return null;
  try {
    const client = new OAuth2Client(clientId);
    const ticket = await client.verifyIdToken({ idToken: credential, audience: clientId });
    const p = ticket.getPayload();
    if (!p || !p.sub || !p.email || p.email_verified !== true) return null;
    const domain = (p.hd || p.email.split("@")[1] || "").toLowerCase();
    const allowed = allowedDomain();
    if (allowed && domain !== allowed) return null;
    return { sub: p.sub, email: p.email.toLowerCase(), name: p.name || p.email.split("@")[0] || "Student" };
  } catch {
    return null;
  }
}
