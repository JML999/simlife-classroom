/**
 * Demo classroom seed: one teacher, one class, four fictional students.
 * Runs at boot when demo auth is on, and via `npm run seed`.
 *
 * All names are fictional. All money is simulated.
 */
import "./env.js";
import { initSchema, one, run, newId, nowIso } from "./db.js";
import { adjustCash } from "./ledger.js";

export const DEMO_IDS = ["demo-teacher", "demo-stu-1", "demo-stu-2", "demo-stu-3", "demo-stu-4"] as const;
export const DEMO_CLASS_ID = "demo-class-1";

const STUDENTS = [
  { id: "demo-stu-1", name: "Ava Rivera" },
  { id: "demo-stu-2", name: "Ben Carter" },
  { id: "demo-stu-3", name: "Chloe Kim" },
  { id: "demo-stu-4", name: "David Okafor" },
];

export async function ensureDemoUsers(): Promise<void> {
  const now = nowIso();
  if (!(await one(`SELECT id FROM classes WHERE id = ?`, [DEMO_CLASS_ID]))) {
    await run(`INSERT INTO classes (id, name, join_code, trading_frozen, created_at) VALUES (?, ?, ?, 0, ?)`,
      [DEMO_CLASS_ID, "Period 1 — Personal Finance", "DEMO1", now]);
  }
  if (!(await one(`SELECT id FROM users WHERE id = ?`, ["demo-teacher"]))) {
    await run(`INSERT INTO users (id, email, name, role, created_at) VALUES (?, ?, ?, ?, ?)`,
      ["demo-teacher", "teacher@example.school", "Ms. Rivera (demo teacher)", "teacher", now]);
  }
  for (const s of STUDENTS) {
    if (!(await one(`SELECT id FROM users WHERE id = ?`, [s.id]))) {
      await run(`INSERT INTO users (id, email, name, role, class_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [s.id, `${s.id}@example.school`, `${s.name} (demo)`, "student", DEMO_CLASS_ID, now]);
    }
  }
}

async function seedMoney(): Promise<void> {
  // Give each demo student $1,000 simulated cash once (idempotent via keys).
  for (const s of STUDENTS) {
    try {
      await adjustCash({
        userId: s.id, actorId: "demo-teacher", amountCents: 100000,
        reason: "Starting simulated brokerage balance for the class demo.",
        idempotencyKey: `seed-cash-${s.id}`,
      });
    } catch (err: any) {
      if (!/INSUFFICIENT/i.test(String(err?.message))) throw err;
    }
  }
}

if (process.argv[1]?.endsWith("seed.ts")) {
  await initSchema();
  await ensureDemoUsers();
  await seedMoney();
  console.log("[simlife] demo classroom seeded (DEMO1).");
  process.exit(0);
}
