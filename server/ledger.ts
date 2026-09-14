/**
 * Immutable-ledger accounting. Every balance change happens inside a DB
 * transaction that writes the ledger row AND updates accounts.cash_cents.
 *
 * Invariant: accounts.cash_cents == SUM(ledger.amount_cents) per account.
 */
import { one, q, withTx, newId, nowIso, type Tx } from "./db.js";

export const MICRO = 1_000_000; // micro-shares per whole share

export class LedgerError extends Error {
  code:
    | "INSUFFICIENT_CASH" | "INSUFFICIENT_SHARES" | "INVALID_REASON"
    | "ALREADY_REVERSED" | "NOT_FOUND" | "TRADING_FROZEN"
    | "INVALID_AMOUNT" | "CANNOT_REVERSE_KIND" | "IDEMPOTENCY_CONFLICT";
  constructor(code: LedgerError["code"], msg: string) {
    super(msg);
    this.code = code;
  }
}

export interface LedgerEntry {
  id: string;
  account_id: string;
  kind: "cash_adjust" | "cash_reversal" | "buy" | "sell" | "transfer_in" | "transfer_out";
  amount_cents: number;
  ticker: string | null;
  qty_micro: number | null;
  price_cents: number | null;
  reason: string | null;
  actor_id: string | null;
  idempotency_key: string | null;
  reverses_id: string | null;
  quote_ts: string | null;
  quote_source: string | null;
  created_at: string;
}

export interface Holding {
  ticker: string;
  qtyMicro: number;
  shares: number;
  avgCostCents: number;   // average cost per whole share, cents
  costBasisCents: number; // remaining basis
  marketCents: number;
  gainLossCents: number;
}

function requireReason(reason: unknown): string {
  const r = typeof reason === "string" ? reason.trim() : "";
  if (r.length < 3) throw new LedgerError("INVALID_REASON", "A written reason (at least 3 characters) is required.");
  if (r.length > 500) throw new LedgerError("INVALID_REASON", "Reason must be 500 characters or fewer.");
  return r;
}

async function getOrCreateAccount(t: Tx, userId: string): Promise<{ id: string; cash_cents: number }> {
  const fu = t.dialect === "pg" ? " FOR UPDATE" : "";
  let acct = await t.one<{ id: string; cash_cents: number }>(
    `SELECT id, cash_cents FROM accounts WHERE user_id = ?${fu}`, [userId],
  );
  if (!acct) {
    const id = newId("acct");
    await t.run(`INSERT INTO accounts (id, user_id, cash_cents, created_at) VALUES (?, ?, 0, ?)`, [id, userId, nowIso()]);
    acct = { id, cash_cents: 0 };
  }
  return acct;
}

async function findByIdempotency(t: Tx, key: string): Promise<LedgerEntry | undefined> {
  return t.one<LedgerEntry>(`SELECT * FROM ledger WHERE idempotency_key = ?`, [key]);
}

function matchingIdempotentEntry(
  entry: LedgerEntry,
  expected: Partial<LedgerEntry>,
): LedgerEntry {
  for (const [key, value] of Object.entries(expected)) {
    if ((entry as any)[key] !== value) {
      throw new LedgerError(
        "IDEMPOTENCY_CONFLICT",
        "This request key was already used for a different transaction. Refresh and try again.",
      );
    }
  }
  return entry;
}

/** Teacher adds or removes brokerage cash. Never liquidates investments. */
export async function adjustCash(opts: {
  userId: string; actorId: string; amountCents: number; reason: string; idempotencyKey: string;
}): Promise<{ entry: LedgerEntry; deduped: boolean }> {
  const reason = requireReason(opts.reason);
  if (!Number.isInteger(opts.amountCents) || opts.amountCents === 0) {
    throw new LedgerError("INVALID_AMOUNT", "Amount must be a non-zero whole number of cents.");
  }
  if (!opts.idempotencyKey) throw new LedgerError("INVALID_AMOUNT", "Idempotency key is required.");
  return withTx(async (t) => {
    const acct = await getOrCreateAccount(t, opts.userId);
    const existing = await findByIdempotency(t, opts.idempotencyKey);
    if (existing) return { entry: matchingIdempotentEntry(existing, {
      account_id: acct.id, kind: "cash_adjust", amount_cents: opts.amountCents,
      reason, actor_id: opts.actorId,
    }), deduped: true };
    const next = acct.cash_cents + opts.amountCents;
    if (next < 0) {
      throw new LedgerError(
        "INSUFFICIENT_CASH",
        `Only ${formatCents(acct.cash_cents)} in brokerage cash. The student must sell investments before ${formatCents(-opts.amountCents)} can be removed — cash removal never sells shares automatically.`,
      );
    }
    const entry: LedgerEntry = {
      id: newId("le"), account_id: acct.id, kind: "cash_adjust",
      amount_cents: opts.amountCents, ticker: null, qty_micro: null, price_cents: null,
      reason, actor_id: opts.actorId, idempotency_key: opts.idempotencyKey,
      reverses_id: null, quote_ts: null, quote_source: null, created_at: nowIso(),
    };
    try {
      await t.run(
        `INSERT INTO ledger (id, account_id, kind, amount_cents, ticker, qty_micro, price_cents, reason, actor_id, idempotency_key, reverses_id, quote_ts, quote_source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [entry.id, entry.account_id, entry.kind, entry.amount_cents, entry.ticker, entry.qty_micro, entry.price_cents, entry.reason, entry.actor_id, entry.idempotency_key, entry.reverses_id, entry.quote_ts, entry.quote_source, entry.created_at],
      );
    } catch (err: any) {
      if (isUniqueViolation(err)) return { entry: matchingIdempotentEntry(
        (await findByIdempotency(t, opts.idempotencyKey))!,
        { account_id: acct.id, kind: "cash_adjust", amount_cents: opts.amountCents, reason, actor_id: opts.actorId },
      ), deduped: true };
      throw err;
    }
    await t.run(`UPDATE accounts SET cash_cents = ? WHERE id = ?`, [next, acct.id]);
    return { entry, deduped: false };
  });
}

/** Safe reversal: compensating entry, never a delete. */
export async function reverseCash(opts: {
  entryId: string; actorId: string; reason: string; idempotencyKey: string;
}): Promise<{ entry: LedgerEntry; deduped: boolean }> {
  const reason = requireReason(opts.reason);
  if (!opts.idempotencyKey) throw new LedgerError("INVALID_AMOUNT", "Idempotency key is required.");
  return withTx(async (t) => {
    const orig = await t.one<LedgerEntry>(`SELECT * FROM ledger WHERE id = ?`, [opts.entryId]);
    if (!orig) throw new LedgerError("NOT_FOUND", "Original entry not found.");
    const existing = await findByIdempotency(t, opts.idempotencyKey);
    if (existing) return { entry: matchingIdempotentEntry(existing, {
      account_id: orig.account_id, kind: "cash_reversal", amount_cents: -orig.amount_cents,
      reverses_id: orig.id, reason, actor_id: opts.actorId,
    }), deduped: true };
    if (orig.kind !== "cash_adjust") {
      throw new LedgerError("CANNOT_REVERSE_KIND", "Only teacher cash adjustments can be reversed. Trades stand as executed (a teacher can add offsetting cash if needed).");
    }
    const already = await t.one<{ id: string }>(`SELECT id FROM ledger WHERE reverses_id = ?`, [orig.id]);
    if (already) throw new LedgerError("ALREADY_REVERSED", "This adjustment was already reversed.");
    const fu = t.dialect === "pg" ? " FOR UPDATE" : "";
    const acct = (await t.one<{ id: string; cash_cents: number }>(
      `SELECT id, cash_cents FROM accounts WHERE id = ?${fu}`, [orig.account_id],
    ))!;
    const next = acct.cash_cents - orig.amount_cents;
    if (next < 0) {
      throw new LedgerError("INSUFFICIENT_CASH", "Reversing this now would drive brokerage cash negative. The student must sell investments first.");
    }
    const entry: LedgerEntry = {
      id: newId("le"), account_id: acct.id, kind: "cash_reversal",
      amount_cents: -orig.amount_cents, ticker: null, qty_micro: null, price_cents: null,
      reason, actor_id: opts.actorId, idempotency_key: opts.idempotencyKey,
      reverses_id: orig.id, quote_ts: null, quote_source: null, created_at: nowIso(),
    };
    try {
      await t.run(
        `INSERT INTO ledger (id, account_id, kind, amount_cents, ticker, qty_micro, price_cents, reason, actor_id, idempotency_key, reverses_id, quote_ts, quote_source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [entry.id, entry.account_id, entry.kind, entry.amount_cents, entry.ticker, entry.qty_micro, entry.price_cents, entry.reason, entry.actor_id, entry.idempotency_key, entry.reverses_id, entry.quote_ts, entry.quote_source, entry.created_at],
      );
    } catch (err: any) {
      if (isUniqueViolation(err)) return { entry: matchingIdempotentEntry(
        (await findByIdempotency(t, opts.idempotencyKey))!,
        { account_id: acct.id, kind: "cash_reversal", amount_cents: -orig.amount_cents, reverses_id: orig.id, reason, actor_id: opts.actorId },
      ), deduped: true };
      throw err;
    }
    await t.run(`UPDATE accounts SET cash_cents = ? WHERE id = ?`, [next, acct.id]);
    return { entry, deduped: false };
  });
}

export function costFor(qtyMicro: number, priceCents: number): number {
  return Math.round((qtyMicro * priceCents) / MICRO);
}

/** Fractional-share purchase. dollarsCents XOR qtyMicro. */
export async function buy(opts: {
  userId: string; ticker: string; qtyMicro?: number; dollarsCents?: number;
  priceCents: number; quoteTs: string; quoteSource: string;
  idempotencyKey: string; tradingFrozen: boolean;
}): Promise<{ entry: LedgerEntry; deduped: boolean; qtyMicro: number; costCents: number }> {
  if (opts.tradingFrozen) throw new LedgerError("TRADING_FROZEN", "Trading is frozen by your teacher. Buying is paused.");
  if (!opts.idempotencyKey) throw new LedgerError("INVALID_AMOUNT", "Idempotency key is required.");
  let qtyMicro: number | undefined = opts.qtyMicro;
  if (opts.dollarsCents !== undefined) {
    if (!Number.isInteger(opts.dollarsCents) || opts.dollarsCents < 100) {
      throw new LedgerError("INVALID_AMOUNT", "Minimum purchase is $1.00.");
    }
    qtyMicro = Math.floor((opts.dollarsCents * MICRO) / opts.priceCents);
  }
  if (!qtyMicro || !Number.isInteger(qtyMicro) || qtyMicro <= 0) {
    throw new LedgerError("INVALID_AMOUNT", "Enter a positive share quantity.");
  }
  const cost = costFor(qtyMicro, opts.priceCents);
  if (cost < 1) throw new LedgerError("INVALID_AMOUNT", "That quantity is too small to execute (under 1¢).");
  const qty = qtyMicro;
  return withTx(async (t) => {
    const acct = await getOrCreateAccount(t, opts.userId);
    const existing = await findByIdempotency(t, opts.idempotencyKey);
    if (existing) {
      const entry = matchingIdempotentEntry(existing, {
        account_id: acct.id, kind: "buy", ticker: opts.ticker,
        ...(opts.qtyMicro !== undefined ? { qty_micro: qty } : {}),
      });
      return { entry, deduped: true, qtyMicro: entry.qty_micro ?? 0, costCents: -entry.amount_cents };
    }
    // Re-read cash inside the tx (stale browser balances can never authorize).
    if (acct.cash_cents < cost) {
      throw new LedgerError("INSUFFICIENT_CASH", `This purchase costs ${formatCents(cost)} but only ${formatCents(acct.cash_cents)} is available.`);
    }
    const entry: LedgerEntry = {
      id: newId("le"), account_id: acct.id, kind: "buy",
      amount_cents: -cost, ticker: opts.ticker, qty_micro: qty, price_cents: opts.priceCents,
      reason: null, actor_id: null, idempotency_key: opts.idempotencyKey,
      reverses_id: null, quote_ts: opts.quoteTs, quote_source: opts.quoteSource, created_at: nowIso(),
    };
    try {
      await t.run(
        `INSERT INTO ledger (id, account_id, kind, amount_cents, ticker, qty_micro, price_cents, reason, actor_id, idempotency_key, reverses_id, quote_ts, quote_source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [entry.id, entry.account_id, entry.kind, entry.amount_cents, entry.ticker, entry.qty_micro, entry.price_cents, entry.reason, entry.actor_id, entry.idempotency_key, entry.reverses_id, entry.quote_ts, entry.quote_source, entry.created_at],
      );
    } catch (err: any) {
      if (isUniqueViolation(err)) {
        const dup = matchingIdempotentEntry((await findByIdempotency(t, opts.idempotencyKey))!, {
          account_id: acct.id, kind: "buy", ticker: opts.ticker,
          ...(opts.qtyMicro !== undefined ? { qty_micro: qty } : {}),
        });
        return { entry: dup, deduped: true, qtyMicro: dup.qty_micro ?? 0, costCents: -dup.amount_cents };
      }
      throw err;
    }
    await t.run(`UPDATE accounts SET cash_cents = ? WHERE id = ?`, [acct.cash_cents - cost, acct.id]);
    return { entry, deduped: false, qtyMicro: qty, costCents: cost };
  });
}

/** Sell some or all owned shares. */
export async function sell(opts: {
  userId: string; ticker: string; qtyMicro?: number; sellAll?: boolean;
  priceCents: number; quoteTs: string; quoteSource: string;
  idempotencyKey: string; tradingFrozen: boolean;
}): Promise<{ entry: LedgerEntry; deduped: boolean; qtyMicro: number; proceedsCents: number }> {
  if (opts.tradingFrozen) throw new LedgerError("TRADING_FROZEN", "Trading is frozen by your teacher. Selling is paused.");
  if (!opts.idempotencyKey) throw new LedgerError("INVALID_AMOUNT", "Idempotency key is required.");
  return withTx(async (t) => {
    const acct = await getOrCreateAccount(t, opts.userId);
    const existing = await findByIdempotency(t, opts.idempotencyKey);
    if (existing) {
      const entry = matchingIdempotentEntry(existing, {
        account_id: acct.id, kind: "sell", ticker: opts.ticker,
        ...(opts.qtyMicro !== undefined ? { qty_micro: -opts.qtyMicro } : {}),
      });
      return { entry, deduped: true, qtyMicro: -(entry.qty_micro ?? 0), proceedsCents: entry.amount_cents };
    }
    const owned = await t.one<{ qty: number }>(
      `SELECT COALESCE(SUM(qty_micro), 0) AS qty FROM ledger WHERE account_id = ? AND ticker = ?`,
      [acct.id, opts.ticker],
    );
    const ownedQty = owned?.qty ?? 0;
    let qty = opts.qtyMicro ?? 0;
    if (opts.sellAll) qty = ownedQty;
    if (!Number.isInteger(qty) || qty <= 0) {
      throw new LedgerError("INVALID_AMOUNT", "Enter a positive share quantity (or sell all).");
    }
    if (qty > ownedQty) {
      throw new LedgerError("INSUFFICIENT_SHARES", `You own ${(ownedQty / MICRO).toFixed(4)} shares of ${opts.ticker} — cannot sell ${(qty / MICRO).toFixed(4)}.`);
    }
    const proceeds = costFor(qty, opts.priceCents);
    if (proceeds < 1) throw new LedgerError("INVALID_AMOUNT", "That quantity is too small to execute (under 1¢).");
    const entry: LedgerEntry = {
      id: newId("le"), account_id: acct.id, kind: "sell",
      amount_cents: proceeds, ticker: opts.ticker, qty_micro: -qty, price_cents: opts.priceCents,
      reason: null, actor_id: null, idempotency_key: opts.idempotencyKey,
      reverses_id: null, quote_ts: opts.quoteTs, quote_source: opts.quoteSource, created_at: nowIso(),
    };
    try {
      await t.run(
        `INSERT INTO ledger (id, account_id, kind, amount_cents, ticker, qty_micro, price_cents, reason, actor_id, idempotency_key, reverses_id, quote_ts, quote_source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [entry.id, entry.account_id, entry.kind, entry.amount_cents, entry.ticker, entry.qty_micro, entry.price_cents, entry.reason, entry.actor_id, entry.idempotency_key, entry.reverses_id, entry.quote_ts, entry.quote_source, entry.created_at],
      );
    } catch (err: any) {
      if (isUniqueViolation(err)) {
        const dup = matchingIdempotentEntry((await findByIdempotency(t, opts.idempotencyKey))!, {
          account_id: acct.id, kind: "sell", ticker: opts.ticker, qty_micro: -qty, amount_cents: proceeds,
        });
        return { entry: dup, deduped: true, qtyMicro: -(dup.qty_micro ?? 0), proceedsCents: dup.amount_cents };
      }
      throw err;
    }
    await t.run(`UPDATE accounts SET cash_cents = ? WHERE id = ?`, [acct.cash_cents + proceeds, acct.id]);
    return { entry, deduped: false, qtyMicro: qty, proceedsCents: proceeds };
  });
}

/** Holdings with average-cost basis. priceOf returns current price cents or null. */
export async function holdingsFor(
  userId: string, priceOf: (ticker: string) => number | null,
): Promise<{ cashCents: number; holdings: Holding[] }> {
  const acct = await one<{ id: string; cash_cents: number }>(
    `SELECT id, cash_cents FROM accounts WHERE user_id = ?`, [userId],
  );
  if (!acct) return { cashCents: 0, holdings: [] };
  const rows = await q<{
    ticker: string; buy_qty: number; buy_cost: number; sell_qty: number; sell_proceeds: number;
  }>(
    `SELECT ticker,
       COALESCE(SUM(CASE WHEN kind = 'buy' THEN qty_micro ELSE 0 END), 0) AS buy_qty,
       COALESCE(SUM(CASE WHEN kind = 'buy' THEN -amount_cents ELSE 0 END), 0) AS buy_cost,
       COALESCE(SUM(CASE WHEN kind = 'sell' THEN -qty_micro ELSE 0 END), 0) AS sell_qty,
       COALESCE(SUM(CASE WHEN kind = 'sell' THEN amount_cents ELSE 0 END), 0) AS sell_proceeds
     FROM ledger WHERE account_id = ? AND ticker IS NOT NULL GROUP BY ticker`,
    [acct.id],
  );
  const holdings: Holding[] = [];
  for (const r of rows) {
    const remaining = r.buy_qty - r.sell_qty;
    if (remaining <= 0) continue;
    const avgPerMicro = r.buy_qty > 0 ? r.buy_cost / r.buy_qty : 0;
    const costBasis = Math.round(avgPerMicro * remaining);
    const price = priceOf(r.ticker);
    const market = price == null ? costBasis : costFor(remaining, price);
    holdings.push({
      ticker: r.ticker, qtyMicro: remaining, shares: remaining / MICRO,
      avgCostCents: avgPerMicro * MICRO, costBasisCents: costBasis,
      marketCents: market, gainLossCents: market - costBasis,
    });
  }
  holdings.sort((a, b) => b.marketCents - a.marketCents);
  return { cashCents: acct.cash_cents, holdings };
}

export async function historyFor(userId: string, limit = 200): Promise<LedgerEntry[]> {
  const acct = await one<{ id: string }>(`SELECT id FROM accounts WHERE user_id = ?`, [userId]);
  if (!acct) return [];
  return q<LedgerEntry>(`SELECT * FROM ledger WHERE account_id = ? ORDER BY created_at DESC LIMIT ?`, [acct.id, limit]);
}

/** Verify the core invariant (used by tests + a debug endpoint). */
export async function checkInvariant(userId: string): Promise<{ cash: number; sum: number; ok: boolean }> {
  const acct = await one<{ id: string; cash_cents: number }>(`SELECT id, cash_cents FROM accounts WHERE user_id = ?`, [userId]);
  if (!acct) return { cash: 0, sum: 0, ok: true };
  const row = await one<{ sum: number }>(`SELECT COALESCE(SUM(amount_cents), 0) AS sum FROM ledger WHERE account_id = ?`, [acct.id]);
  const sum = row?.sum ?? 0;
  return { cash: acct.cash_cents, sum, ok: acct.cash_cents === sum };
}

export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  return `${sign}$${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
}

function isUniqueViolation(err: any): boolean {
  const msg = String(err?.message || err?.code || "");
  return /unique|UNIQUE|duplicate|23505|SQLITE_CONSTRAINT_UNIQUE/i.test(msg);
}
