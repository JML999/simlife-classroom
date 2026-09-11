/**
 * Dependency-free .env loader. MUST be the first import in server/index.ts
 * and server/seed.ts so process.env is populated before anything reads it.
 *
 * Only loads simlife-investing/.env (never touches ../codeworld/.env).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const envFile = path.join(root, ".env");

try {
  const text = fs.readFileSync(envFile, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (key && !(key in process.env)) process.env[key] = val;
  }
} catch {
  // No .env file — environment variables alone are fine.
}

export const ROOT = root;

/** Refuse a production boot that would weaken the classroom boundary. */
export function validateProductionEnv(): void {
  if (process.env["NODE_ENV"] !== "production") return;
  const missing: string[] = [];
  const secret = process.env["SIMLIFE_SESSION_SECRET"] || "";
  if (secret.length < 32) missing.push("SIMLIFE_SESSION_SECRET (at least 32 characters)");
  if (!(process.env["SIMLIFE_DATABASE_URL"] || "").trim()) missing.push("SIMLIFE_DATABASE_URL");
  // The domain may be a real domain (locked) or the literal "open"
  // (deliberately unrestricted). Empty/missing is always a misconfiguration.
  const domain = (process.env["SIMLIFE_ALLOWED_GOOGLE_DOMAIN"] || "").trim();
  if (!domain) missing.push('SIMLIFE_ALLOWED_GOOGLE_DOMAIN (a domain, or "open")');
  if (!(process.env["SIMLIFE_TEACHER_EMAILS"] || "").trim()) missing.push("SIMLIFE_TEACHER_EMAILS");
  if (missing.length) {
    throw new Error(`Unsafe production configuration. Set: ${missing.join(", ")}.`);
  }
}
