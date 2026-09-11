# SimLife Investing

A small classroom brokerage simulator for Personal Finance. **All money and
trades are simulated for class only.** No real brokerage connections, no real
trades, no investment advice.

Sibling of CodeWorld (`../codeworld/`), which is **read-only reference** —
this project shares no database, sessions, ports, keys, or deployment with it.

## Quick start (local, no credentials needed)

```bash
cd simlife-investing
npm install
npm run seed     # optional: demo teacher + class + 4 fictional students
npm run dev      # api :4101 + web :3100
```

Open http://127.0.0.1:3100 → **Demo accounts** → sign in as the demo teacher
or any demo student. Demo login works only when `SIMLIFE_DEMO_AUTH=true` and
never in production.

Classroom QA workflow: teacher adds cash → student buys shares → (change a
mock price or switch provider) → student sells → teacher removes cash.
Join code for the demo class: `DEMO1`.

## Commands

| Command | What |
|---|---|
| `npm run dev` | API (4101) + web (3100) with proxy |
| `npm test` | Ledger + trade tests (isolated temp DBs) |
| `npm run typecheck` | Client + server type checks |
| `npm run build` | Production Vite build into `dist/` |
| `npm start` | Production: one process serves `dist/` + `/api` |
| `npm run seed` | Seed demo classroom (dev only) |

## Configuration

Copy `.env.example` to `.env`. Placeholders only — never paste CodeWorld
secrets here. Key vars:

- `SIMLIFE_DATABASE_URL` — empty = local SQLite (`data/simlife.db`); set = Postgres/Supabase project for deploy
- `SIMLIFE_PORT` (default 4101), web on 3100
- `SIMLIFE_GOOGLE_CLIENT_ID`, `SIMLIFE_ALLOWED_GOOGLE_DOMAIN`, `SIMLIFE_TEACHER_EMAILS`
- `SIMLIFE_SESSION_SECRET`
- `SIMLIFE_DEMO_AUTH=true` (dev only; server refuses demo logins when `NODE_ENV=production`)
- `SIMLIFE_QUOTE_PROVIDER=mock|stooq`
- `SIMLIFE_SAVINGS_APY_BPS` — classroom savings APY in basis points (default
  `340` = 3.40%); update the matching label and as-of date when the benchmark
  changes. The current default follows the
  [Marcus Online Savings published rate](https://www.marcus.com/us/en/savings/high-yield-savings)
  as of September 7, 2026. It is a simulated variable classroom rate, not an
  offer from a bank.

## Docs

- `ARCHITECTURE.md` — safety boundary, data model, routes, ledger rules
- `MARKET_DATA.md` — provider recommendation
- `SESSION_HANDOFF.md` — what works, what's mocked, risks, run commands
