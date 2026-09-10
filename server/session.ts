import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";

const COOKIE_NAME = "sl_session";
function secret(): string {
  return process.env["SIMLIFE_SESSION_SECRET"] || "dev-only-not-secret-simlife";
}

export interface SessionPayload {
  userId: string;
  role: "student" | "teacher";
  issuedAt?: number;
}

const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

function sign(value: string): string {
  return crypto.createHmac("sha256", secret()).update(value).digest("base64url");
}

export function encodeSession(p: SessionPayload): string {
  const body = Buffer.from(JSON.stringify({ ...p, issuedAt: p.issuedAt ?? Date.now() }), "utf8").toString("base64url");
  return `${body}.${sign(body)}`;
}

export function decodeSession(cookie: string | undefined): SessionPayload | null {
  if (!cookie) return null;
  const [body, sig] = cookie.split(".");
  if (!body || !sig) return null;
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(body));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionPayload;
    if (typeof parsed.userId !== "string") return null;
    if (parsed.role !== "student" && parsed.role !== "teacher") return null;
    if (typeof parsed.issuedAt !== "number" || Date.now() - parsed.issuedAt > SESSION_MAX_AGE_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function setSessionCookie(res: Response, p: SessionPayload): void {
  res.cookie(COOKIE_NAME, encodeSession(p), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env["NODE_ENV"] === "production",
    maxAge: SESSION_MAX_AGE_MS,
    path: "/",
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME, { path: "/" });
}

export function readSession(req: Request): SessionPayload | null {
  const cookie = (req as any).cookies?.[COOKIE_NAME];
  return decodeSession(cookie);
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const s = readSession(req);
  if (!s) { res.status(401).json({ error: "Sign in required." }); return; }
  (req as any).session = s;
  next();
}

export function requireTeacher(req: Request, res: Response, next: NextFunction): void {
  const s = readSession(req);
  if (!s) { res.status(401).json({ error: "Sign in required." }); return; }
  if (s.role !== "teacher") { res.status(403).json({ error: "Teacher access only." }); return; }
  (req as any).session = s;
  next();
}
