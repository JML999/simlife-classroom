# SimLife — "Class" tab: modules, assignments, and progress

Draft plan for review. No code written yet. Follows the existing safety
boundary in `ARCHITECTURE.md`: additive schema only, integer cents, teacher
role from the server-side allowlist, `../codeworld/` untouched.

---

## 1. What this is for

Today SimLife can *do* money but can't *ask about* money. Assignments live in
Google Classroom as worksheets, which means:

- the student answers questions about a portfolio the worksheet can't see;
- you grade by reading a doc and cross-referencing the teacher roster by hand;
- nothing a student does in SimLife counts as evidence of anything.

The Class tab closes that loop. The point is not "worksheets, but in SimLife."
The point is that **an assignment item can read the student's actual ledger
and portfolio.** "Buy $50 of an ETF and explain why" becomes: the purchase is
verified automatically from the ledger, and the only thing you read is the
reasoning. That is a capability Google Classroom structurally cannot have.

Everything else below exists to support that.

---

## 2. Placement and naming

**Student nav** (`src/App.tsx` ~line 246, `.student-nav`). Today:

```
⌂  Dashboard
▣  Banking
↗  Investing
```

Add a fourth entry, but **bottom-anchored and visually separated** — the
ChatGPT-profile position Justin described. The three existing entries are
"places your money lives"; Class is a different kind of thing and shouldn't
read as a fourth account.

```
⌂  Dashboard
▣  Banking
↗  Investing
      (flex spacer + hairline divider)
◆  Class          ← badge with count of items due
```

CSS: `.student-nav { min-height: … }`, the Class button wrapped in a
`.student-nav-foot` with `margin-top: auto` and `border-top: 1px solid
var(--line)`. On the mobile breakpoint (≤900px) the rail is already
horizontal — there the divider becomes a left border and the spacer collapses,
so Class simply sits last in the row.

**Name: "Class."** "Research" describes one kind of item, not the tab.
"Assignments" sounds like homework; "Class" covers modules, practice, and
anything posted later without renaming.

**Teacher side:** a third workspace tab beside Brokerage / Banking
(`workspaceTabs`, ~line 1014) called **Modules**.

---

## 3. The one real fork: who authors a module?

CodeWorld authors lessons **in code** — `server/lessons/*.ts`, `published:
true`, rich markdown with embedded starter code. That's right for CodeWorld:
lessons carry executable checks and change rarely.

Justin's ask was "allow me to post assignments," which implies **authoring in
the UI**. These pull in opposite directions, so the proposal is both, with a
clear split:

- **Modules and items live in the database**, authored in the teacher UI.
  You can post an assignment Tuesday night without a deploy.
- **A seed file** (`server/seed-modules.ts`) ships a starter set of investing
  modules as data, inserted idempotently the same way the roster seeds work.
  So the investing sequence you already have in mind exists on day one and is
  then editable in the UI like anything else.
- **Auto-check logic lives in code**, keyed by name. A portfolio-linked item
  stores `{ "check": "owns_sector_count", "params": { "min": 3 } }`; the
  server maps that string to a function. Teachers pick checks from a dropdown;
  they never write logic, and no user input is ever evaluated.

That last rule is what keeps UI authoring safe. Content is data; verification
is code.

---

## 4. Schema (additive; SQLite + Postgres dialect subset)

Appended to `initSchema()` in `server/db.ts`. TEXT PKs, no booleans (0/1),
ISO-8601 TEXT timestamps — matching §5 of `ARCHITECTURE.md`.

```
modules(
  id PK, class_id FK NULL,          -- NULL = available to all classes
  title, summary, order_index INT,
  status TEXT,                      -- 'draft' | 'published' | 'archived'
  opens_at TEXT NULL, due_at TEXT NULL,
  created_by FK, created_at
)

module_items(
  id PK, module_id FK, order_index INT,
  kind TEXT,                        -- 'written' | 'choice' | 'sort' | 'task' | 'reading'
  prompt TEXT,                      -- markdown
  body TEXT NULL,                   -- longer stimulus / reading passage
  spec TEXT,                        -- JSON, shape depends on kind (§5)
  points INT NULL,                  -- NULL until grading is turned on (§6)
  required INT DEFAULT 1,
  created_at
)

submissions(                        -- one row per attempt, append-only
  id PK, item_id FK, user_id FK, module_id FK,
  attempt_no INT,
  response TEXT,                    -- JSON, shape depends on kind
  auto_status TEXT,                 -- 'correct' | 'incorrect' | 'unscored'
  auto_detail TEXT NULL,            -- JSON: which buckets were wrong, what the ledger showed
  evidence TEXT NULL,               -- JSON snapshot for 'task' items (see §5)
  idempotency_key TEXT UNIQUE,
  created_at
)

item_reviews(                       -- teacher's read of a written item
  id PK, submission_id FK UNIQUE, teacher_id FK,
  mark TEXT,                        -- 'seen' | 'revise' | 'complete'
  score INT NULL,                   -- reserved; unused until grading turns on
  comment TEXT NULL, created_at
)

module_progress(                    -- derived cache, rebuildable from the above
  user_id, module_id, status TEXT, items_done INT, items_total INT,
  attempts INT, last_activity_at,
  PRIMARY KEY (user_id, module_id)
)
```

`submissions` is append-only like the ledger: a retry is a new row with
`attempt_no + 1`, never an UPDATE. That is what makes "see progress /
attempts" possible — you can watch a student converge on an answer, which a
single overwritten response would hide. `module_progress` is a cache and can
be dropped and rebuilt from `submissions` at any time.

The `idempotency_key` mirrors the trade endpoints so a double-click or a flaky
phone connection can't create a phantom second attempt.

---

## 5. Item types

One generic engine, five `kind` values. Adding a sixth later means a new
`spec` shape and one renderer — no schema change.

| kind | spec | response | scored |
|---|---|---|---|
| `written` | `{ minWords?, placeholder? }` | `{ text }` | teacher |
| `choice` | `{ options[], correct[], multi }` | `{ selected[] }` | auto |
| `sort` | `{ buckets[], tokens[{label, bucket}] }` | `{ placements{} }` | auto |
| `task` | `{ check, params }` | `{ note? }` | live meter, from ledger |
| `reading` | `{}` | `{ acknowledged: true }` | completion |

**`sort` is the one that will feel like a game rather than a worksheet.**
Drag ticker chips into buckets — sectors, stock vs ETF vs bond, risk tier.
Tokens can be seeded from `server/ticker-directory.json`, which already exists.
Partial credit reports per-token, so `auto_detail` can tell you "14 of 16
placed, both misses were REITs" — which is a teaching signal, not a score.

### `task` — the core type

A check does **not** return a boolean. It returns a reading:

```ts
interface CheckResult {
  met: boolean;
  current: number;          // 0
  target: number;           // 3
  unit: string;             // "ETFs"
  label: string;            // "0 of 3 ETFs in your portfolio"
  detail?: unknown;         // which holdings counted, and why
}
```

That single change is what makes the item feel alive. The student sees
**"0 of 3 ETFs in your portfolio"** sitting under the question *while they are
reading it*, and it ticks to 1 of 3, 2 of 3 as they actually trade. The
assignment stops being a thing you answer and becomes a thing you complete.
No worksheet can do that, and neither can a pass/fail check — a bare ✕ tells a
student they're wrong without telling them how far along they are.

Rendered as a quiet progress line in the item, not a scoreboard: the count, a
thin bar, and `detail` available behind a disclosure ("AAA and BBB counted;
CCC is a single stock"). The `detail` payload is the teaching content — it
says *why* the number is what it is.

**Initial check set.** Each is a small pure function over the ledger and bank
journal, each returning a `CheckResult`, each unit-tested:

| check | params | reads as |
|---|---|---|
| `made_first_trade` | — | "1 of 1 trades placed" |
| `owns_min_positions` | `{ min }` | "2 of 4 positions held" |
| `owns_sector_count` | `{ min, excludeEtfs? }` | "3 of 5 sectors represented" |
| `owns_sector` | `{ sector }` | "0 of 1 — no Utilities holding yet" |
| `owns_broad_fund` | `{ min }` | "0 of 1 broad ETF owned" |
| `owns_asset_class_count` | `{ min }` | "1 of 2 asset classes (stocks, bonds)" |
| `owns_region` | `{ region }` | "0 of 1 international holdings" |
| `owns_cap_tier` | `{ tier }` | "0 of 1 small-cap holdings" |
| `invested_at_least` | `{ cents }` | "$34 of $50 invested" |
| `sector_max_weight` | `{ maxPct }` | "68% in Consumer Discretionary — target under 50%" |
| `sold_a_position` | — | "0 of 1 sales made" |
| `paid_bill_on_time` | — | "1 of 1 bills paid before the due date" |
| `savings_balance_at_least` | `{ cents }` | "$120 of $200 saved" |

Every one of these reads `ticker-directory.json`'s `meta` object, which the
rebuilt `scripts/build-ticker-directory.mjs` produces: `sector`,
`subIndustry`, `assetClass`, `region`, `breadth` and `capTier` per ticker.
That one data file is what unlocks the whole check set — without it only
`made_first_trade`, `owns_min_positions` and the cash checks are buildable.

`sector_max_weight` is the most interesting of these and the only one needing
live prices, which `/api/portfolio` already computes. It inverts the usual
framing: instead of "own three sectors" it asks "is any one sector more than
half of you?" That is a better question for a student who owns eleven
consumer stocks and technically passes a sector count. Worth building once the
simpler checks are working, not before.

A ticker with no classification reports as `UNKNOWN` in `detail` rather than
counting as a miss — an unclassified ticker is a data gap, not a student
error, and the student shouldn't eat it.

**Live status must not create an attempt.** Reading the meter is a GET;
submitting is a POST. A student can sit on the page all period watching the
number without generating a single row in `submissions`. This is why the
status route in §7 is separate.

**Computed in one pass.** `GET /api/class/modules/:id` loads the student's
portfolio and ledger once and evaluates every `task` item in that module
against it — not one query per item. The student page can poll that single
endpoint after a trade to refresh every meter at once.

**Evidence snapshot at submit.** A `task` submission stores the `CheckResult`
plus the ledger entry ids that satisfied it. This matters: a student who buys
three sectors Tuesday and sells one Thursday should still show Tuesday's item
as done. Re-deriving the check at review time would silently un-complete their
work.

**A met check is not automatically a submission.** The student still presses
submit. Auto-completing the moment the meter fills would mean a student who
happened to already own three ETFs gets the item marked done without ever
reading the question. The meter tells them where they stand; the submission is
still an act.

Most real modules will pair a `task` with a `written`: *do the thing, then
explain why.* The `task` half grades itself; the `written` half is the part
worth your attention.

---

## 6. Progress and grading

Mirrors CodeWorld's vocabulary so the two apps read alike
(`server/progress.ts` uses `not_started | in_progress | needs_review |
mastered`). SimLife's equivalent, per module:

- **not_started** — no submissions
- **in_progress** — some required items answered
- **needs_review** — all required items answered, ≥1 written item unreviewed
- **complete** — all required items answered and reviewed

Per item the student sees: attempts, their latest response, auto-result where
applicable, and your comment. Auto-graded items can be set to allow retries
(`in_progress` again) — practice, not a one-shot test.

**Grading stays off at launch, but the columns exist.** `module_items.points`
and `item_reviews.score` ship nullable and unused. Turning grading on later is
a UI change plus a per-module `grading_enabled` flag — not a migration, not a
reshaping of submissions. This is the cheap version of "maybe we add more
grading later": the door is built, just not opened.

---

## 7. Routes

Following the existing naming in §4 of `ARCHITECTURE.md`.

```
Student (auth):
  GET  /api/class/modules                 published modules for their class + own progress
  GET  /api/class/modules/:id             items + latest submission + live task meters
  GET  /api/class/modules/:id/status      meters only; cheap, pollable after a trade
  POST /api/class/items/:id/submit        { response, idempotencyKey } -> auto result

Teacher (auth + role):
  GET    /api/teacher/modules?classId=
  POST   /api/teacher/modules             create
  PATCH  /api/teacher/modules/:id         edit / publish / archive
  POST   /api/teacher/modules/:id/items   add item
  PATCH  /api/teacher/items/:id           edit item
  DELETE /api/teacher/items/:id           only while the module is a draft
  GET    /api/teacher/modules/:id/progress   grid: students × items
  GET    /api/teacher/submissions?itemId=|userId=
  POST   /api/teacher/submissions/:id/review { mark, comment }
```

Same authorization rule as the money routes: the student's identity comes from
the session, never from a client-supplied id. A student requesting another
student's submission gets 403. A student requesting a `draft` module gets 404,
not 403 — an unpublished assignment shouldn't even be known to exist.

New server files: `server/modules.ts` (CRUD + progress), `server/checks.ts`
(the `task` check registry), `server/modules.test.ts`, `server/checks.test.ts`.
`server/index.ts` gains one `registerModuleRoutes(app)` call.

---

## 8. UI

**Student — Class tab.** A list of module cards: title, summary, a progress
bar, due date, status chip. Open one and items render in order in a single
scrolling column with a sticky "N of M done" header. Each item saves on
submit, shows its result inline, and stays editable if retries are allowed.
Nothing auto-submits on blur — students should be able to think in a textarea
without it being recorded as an attempt.

Design language per §10 of `ARCHITECTURE.md`: warm paper, serif headings, the
existing olive/rose accents. No confetti, no streaks, no leaderboard. A
correct answer gets a quiet check, not a celebration.

**Teacher — Modules tab.**

1. *Module list* — draft/published/archived, per class, with a live count of
   items awaiting review.
2. *Builder* — add items, pick a kind, fill the prompt, configure the spec.
   `sort` gets a bucket/token editor; `task` gets a check dropdown with a
   plain-English preview ("Student owns positions in at least 3 sectors").
   Drafts are freely editable; publishing locks destructive edits so you can't
   delete an item students have already answered.
3. *Progress grid* — students down, items across, one glyph per cell
   (`·` not started, `◐` in progress, `✓` auto-correct, `✕` auto-incorrect,
   `!` needs your review). Click a cell to open that student's attempts in the
   existing drawer component and leave a comment. Click a column header to
   read every response to one item in sequence — which is the actual grading
   workflow, and the thing worksheets make painful.

Reuses the existing `classId` filter pills, `.drawer`, `.pills`, and table
styles. Estimated new CSS is small; most of this is existing components.

---

## 9. Build order

Each phase ends green (`npm test`, `npm run typecheck`) and is independently
useful.

1. **Schema + read-only skeleton.** Tables, `server/modules.ts` with GET
   routes, student Class tab rendering an empty state, teacher Modules tab
   listing nothing. Nothing can break; nothing is exposed.
2. **`written` + `reading` end to end.** Submit, attempt history, teacher
   review with comments, progress grid. The submission plumbing everything
   else rides on.
3. **`task` — the core.** The check registry returning `CheckResult`, the live
   meter, the status route, evidence snapshots, a test per check. Paired with
   phase 2 this is the whole thesis working: do the thing, watch the meter,
   explain why, teacher reads only the reasoning.
4. **`choice`.** Auto-grading, retries. Small, once phase 2 exists.
5. **`sort`.** The drag interaction and partial credit — the largest single
   piece of front-end work, and the most skippable if time is short.
6. **Seed modules.** The starter investing sequence as data.
7. **Grading flag** — only if and when you want it.

Phases 1–3 are the meaningful milestone: at that point you can post an
assignment whose portfolio requirement tracks itself, and read only the
reasoning. Phases 4–5 add variety; they don't add the capability.

---

## 10. Open questions for Justin

1. **Late work.** Should `due_at` block submission, or just flag it late? My
   recommendation: flag only. A hard lock creates a support request for you
   every single time, and the timestamp already tells the truth.
2. **Visibility of others' work.** Any interest in a "see two classmates'
   answers after you submit" mode? Strong for the "explain your reasoning"
   items, but it's a real moderation surface. Default is off.
3. **Module scope.** Should a module belong to one class, or be a library item
   you assign to several? The schema above allows both (`class_id` nullable);
   the question is which one the UI leads with. Library-first is more work now
   and saves real time once you're teaching multiple sections.
4. **Retries.** Per-item, or one global "practice mode" setting per module?
5. **Existing content.** Is the investing module sequence written down
   anywhere yet — slides, a doc, `course-materials/personal-finance/`? If it
   exists in any form, phase 5 becomes transcription rather than invention.
