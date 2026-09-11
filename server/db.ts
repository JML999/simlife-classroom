/**
 * Database layer: Postgres (Supabase) when SIMLIFE_DATABASE_URL is set,
 * otherwise a local file-backed SQLite database via node:sqlite.
 *
 * All SQL is written with `?` placeholders; the pg path rewrites them to
 * $1..$n. The DDL avoids dialect-specific types (TEXT ids, INTEGER money,
 * ISO-8601 TEXT timestamps) so both backends behave identically.
 *
 * Env is read lazily (first use) so tests can point at a temp file.
 */
import crypto from "node:crypto";
import path from "node:path";
import { ROOT } from "./env.js";

export type Dialect = "pg" | "sqlite";

export interface Tx {
  dialect: Dialect;
  q: <T = Record<string, any>>(text: string, params?: unknown[]) => Promise<T[]>;
  one: <T = Record<string, any>>(text: string, params?: unknown[]) => Promise<T | undefined>;
  run: (text: string, params?: unknown[]) => Promise<number>;
}

interface Backend {
  dialect: Dialect;
  q: Tx["q"];
  one: Tx["one"];
  run: Tx["run"];
  tx: <T>(fn: (t: Tx) => Promise<T>) => Promise<T>;
  close: () => Promise<void>;
}

let backend: Backend | null = null;

function placeholders(text: string): string {
  let i = 0;
  return text.replace(/\?/g, () => `$${++i}`);
}

async function makePg(url: string): Promise<Backend> {
  const { Pool, types } = await import("pg");
  // NUMERIC (SUM(amount_cents), SUM(qty_micro)) and BIGINT (COUNT(*)) arrive
  // as strings by default. All ledger math is integer cents/micro-shares at
  // classroom scale — parse as numbers, or string values silently break
  // Number.isInteger checks and === comparisons. (SQLite returns numbers,
  // which is why the test suite never caught this.)
  types.setTypeParser(1700, (v: string) => Number(v));
  types.setTypeParser(types.builtins.INT8, (v: string) => Number(v));
  const pool = new Pool({
    connectionString: url,
    ssl: /supabase\.(co|com)/.test(url) ? { rejectUnauthorized: false } : undefined,
    max: 5,
    // Cycle idle clients quickly: Supabase's pooler kills idle connections, and
    // handing a dead client to a classroom request means a failed load.
    idleTimeoutMillis: 15_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    query_timeout: 10_000,
  });
  pool.on("error", (err) => console.error("[simlife pg] idle client error:", err));
  const q: Tx["q"] = async (text, params = []) => {
    const r = await pool.query(placeholders(text), params as any[]);
    return r.rows;
  };
  const one: Tx["one"] = async (text, params = []) => (await q(text, params))[0] as any;
  const run: Tx["run"] = async (text, params = []) => {
    const r = await pool.query(placeholders(text), params as any[]);
    return r.rowCount ?? 0;
  };
  const tx = async <T>(fn: (t: Tx) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const t: Tx = {
        dialect: "pg",
        q: async (text, params = []) => (await client.query(placeholders(text), params as any[])).rows,
        one: async (text, params = []) =>
          (await client.query(placeholders(text), params as any[])).rows[0] as any,
        run: async (text, params = []) =>
          (await client.query(placeholders(text), params as any[])).rowCount ?? 0,
      };
      const out = await fn(t);
      await client.query("COMMIT");
      return out;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  };
  return { dialect: "pg", q, one, run, tx, close: async () => { await pool.end(); } };
}

async function makeSqlite(file: string): Promise<Backend> {
  const { DatabaseSync } = await import("node:sqlite");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  const q: Tx["q"] = async (text, params = []) => {
    const stmt = db.prepare(text);
    return stmt.all(...(params as any[])) as any[];
  };
  const one: Tx["one"] = async (text, params = []) => {
    const rows: any[] = await q(text, params);
    return rows[0] as any;
  };
  const run: Tx["run"] = async (text, params = []) => {
    const stmt = db.prepare(text);
    const res = stmt.run(...(params as any[]));
    return Number(res.changes ?? 0);
  };
  // Single connection: BEGIN IMMEDIATE serializes writers, which gives us
  // the same atomicity the pg path gets from row locks. A JS-side mutex
  // additionally serializes concurrent tx() calls (e.g. a double-clicked
  // submit arriving twice), which one shared connection cannot run in
  // parallel. Postgres handles that natively; this matches its semantics.
  let tail: Promise<unknown> = Promise.resolve();
  const tx = async <T>(fn: (t: Tx) => Promise<T>): Promise<T> => {
    const slot = tail.then(async () => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const t: Tx = { dialect: "sqlite", q, one, run };
        const out = await fn(t);
        db.exec("COMMIT");
        return out;
      } catch (err) {
        try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
        throw err;
      }
    });
    tail = slot.catch(() => {});
    return slot;
  };
  return { dialect: "sqlite", q, one, run, tx, close: async () => { db.close(); } };
}

/** Current backend dialect (for dialect-specific DDL). */
export async function dialect(): Promise<Dialect> {
  return (await db()).dialect;
}

/** Additively ensure a column exists (IF NOT EXISTS on pg; catch-and-ignore on SQLite). */
export async function ensureColumn(table: string, column: string, type: string): Promise<void> {
  const b = await db();
  if (b.dialect === "pg") {
    await b.run(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${type}`);
    return;
  }
  try {
    await b.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  } catch (err: any) {
    if (!/duplicate column/i.test(String(err?.message))) throw err;
  }
}

export async function db(): Promise<Backend> {
  if (!backend) {
    const url = process.env["SIMLIFE_DATABASE_URL"] || "";
    backend =
      url ? await makePg(url)
        : await makeSqlite(process.env["SIMLIFE_DB_PATH"] || path.join(ROOT, "data", "simlife.db"));
  }
  return backend;
}

/** Test/dev helper: drop the cached backend (close first in real use). */
export async function resetDbForTests(): Promise<void> {
  if (backend) { await backend.close().catch(() => {}); backend = null; }
}

export async function q<T = Record<string, any>>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await db()).q<T>(text, params);
}
export async function one<T = Record<string, any>>(text: string, params: unknown[] = []): Promise<T | undefined> {
  return (await db()).one<T>(text, params);
}
export async function run(text: string, params: unknown[] = []): Promise<number> {
  return (await db()).run(text, params);
}
export async function withTx<T>(fn: (t: Tx) => Promise<T>): Promise<T> {
  return (await db()).tx(fn);
}
/** SELECT suffix that locks the row on Postgres; no-op on SQLite (writer lock covers it). */
export async function forUpdate(): Promise<string> {
  return (await db()).dialect === "pg" ? " FOR UPDATE" : "";
}

export async function initSchema(): Promise<void> {
  const b = await db();
  // One statement at a time (SQLite exec handles multiples, pg does not).
  const stmts = [
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'student',
      google_sub TEXT,
      class_id TEXT,
      created_at TEXT NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_sl_users_email ON users(email) WHERE email IS NOT NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_sl_users_google_sub ON users(google_sub) WHERE google_sub IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS classes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      join_code TEXT NOT NULL,
      trading_frozen INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_sl_classes_join_code ON classes(join_code)`,
    `CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      cash_cents INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ledger (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      ticker TEXT,
      qty_micro INTEGER,
      price_cents INTEGER,
      reason TEXT,
      actor_id TEXT,
      idempotency_key TEXT UNIQUE,
      reverses_id TEXT,
      quote_ts TEXT,
      quote_source TEXT,
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_sl_ledger_account ON ledger(account_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_sl_ledger_idem ON ledger(idempotency_key)`,
    `CREATE INDEX IF NOT EXISTS idx_sl_users_class ON users(class_id)`,
    // ---- Banking subsystem (experiment/simlife-banking). Separate from the
    // brokerage accounts/ledger above: bank money and brokerage money never
    // share rows. Transfers touch both sides atomically (see server/bank.ts).
    `CREATE TABLE IF NOT EXISTS bank_accounts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      checking_cents INTEGER NOT NULL DEFAULT 0,
      savings_cents INTEGER NOT NULL DEFAULT 0,
      interest_residual_micros INTEGER NOT NULL DEFAULT 0,
      interest_accrued_at TEXT,
      created_at TEXT NOT NULL
    )`,
    // Append-only bank journal. Each row carries signed checking + savings
    // legs (a checking→savings transfer is one row: -x checking, +x savings).
    // Invariant per user: checking == SUM(checking_leg), savings == SUM(savings_leg).
    `CREATE TABLE IF NOT EXISTS bank_journal (
      id TEXT PRIMARY KEY,
      bank_account_id TEXT NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      checking_leg INTEGER NOT NULL DEFAULT 0,
      savings_leg INTEGER NOT NULL DEFAULT 0,
      memo TEXT,
      actor_id TEXT,
      idempotency_key TEXT UNIQUE,
      related_id TEXT,
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_sl_bank_journal_acct ON bank_journal(bank_account_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_sl_bank_journal_idem ON bank_journal(idempotency_key)`,
    `CREATE TABLE IF NOT EXISTS bill_templates (
      id TEXT PRIMARY KEY,
      teacher_id TEXT NOT NULL,
      title TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      late_fee_cents INTEGER NOT NULL DEFAULT 0,
      description TEXT,
      sender TEXT,
      document_title TEXT,
      document_body TEXT,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS bills (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      template_id TEXT,
      title TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      late_fee_cents INTEGER NOT NULL DEFAULT 0,
      issued_at TEXT NOT NULL,
      due_at TEXT NOT NULL,
      paid_at TEXT,
      payment_journal_id TEXT,
      paid_cents INTEGER NOT NULL DEFAULT 0,
      sender TEXT,
      document_title TEXT,
      document_body TEXT,
      idempotency_key TEXT UNIQUE,
      issued_by TEXT,
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_sl_bills_user ON bills(user_id, due_at)`,
    `CREATE INDEX IF NOT EXISTS idx_sl_bills_idem ON bills(idempotency_key)`,
    `CREATE TABLE IF NOT EXISTS bill_payments (
      id TEXT PRIMARY KEY,
      bill_id TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount_cents INTEGER NOT NULL,
      journal_id TEXT NOT NULL UNIQUE,
      idempotency_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_sl_bill_payments_bill ON bill_payments(bill_id, created_at)`,
    `CREATE TABLE IF NOT EXISTS bill_disputes (
      id TEXT PRIMARY KEY,
      bill_id TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      resolution TEXT,
      resolved_at TEXT,
      resolved_by TEXT,
      resolve_key TEXT,
      idempotency_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_sl_bill_disputes_bill ON bill_disputes(bill_id, created_at)`,
    `CREATE TABLE IF NOT EXISTS income_postings (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      posted_at TEXT NOT NULL,
      posted_by TEXT,
      batch_id TEXT,
      idempotency_key TEXT UNIQUE,
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_sl_income_user ON income_postings(user_id, posted_at)`,
    `CREATE INDEX IF NOT EXISTS idx_sl_income_idem ON income_postings(idempotency_key)`,
  ];
  for (const s of stmts) await b.run(s);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(12).toString("base64url")}`;
}
