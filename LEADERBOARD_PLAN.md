# SimLife — Leaderboard and timed competitions

Draft for review. Additive schema only, integer cents, teacher role from the
server-side allowlist, `../codeworld/` untouched — same boundary as
`ARCHITECTURE.md` and `CLASS_TAB_PLAN.md`.

---

## 0. This contradicts ARCHITECTURE.md §10

§10 currently reads, under the design language:

> No confetti, no alarms, no casino language, no rapid-trading prompts, no leaderboards.

That line was written deliberately and this feature breaks it. Decided:
leaderboards ship, ranked on **percent gain** by default, names visible to
students, run as named events with start and end dates, with a period-versus-
period team score alongside the individual board.

§10 should be amended rather than left contradicting the code. Suggested
replacement for the final clause:

> …no casino language, no rapid-trading prompts. Leaderboards rank percent
> return and always display sectors held and largest position beside the
> return, so concentration is visible at a glance. No dollar balances are ever
> shown to students for another student's account.

The rest of §10 stands. Everything below is designed to honor its spirit: the
board is quiet, it reports, and it never congratulates a student for taking a
risk it has not also shown.

---

## 1. The hard part: percent of what?

This is the design decision that makes the board either fair or nonsense, and
it is not obvious.

**The problem.** Teacher cash adjustments post to the ledger at arbitrary
times (`kind: 'cash_adjust'`). A naive `(value − deposits) / deposits` is
distorted by any deposit made mid-competition — a student who receives $500 on
day 9 has their percentage dragged toward zero through no action of their own.
Paydays via `income_postings` do the same thing.

**The fix: time-weighted return (TWR).** Split the competition window into
sub-periods at every cash event, compute each sub-period's return on the
portfolio value alone, and chain them:

```
TWR = Π ( V_end(i) / V_start(i) ) − 1
```

where each sub-period starts immediately after a deposit or withdrawal.
Deposits then affect *how much money* a student has and never *their
percentage*. This is the standard measure for exactly this reason, and the
append-only ledger with timestamps already contains everything needed.

**Also recommended: freeze cash adjustments during a competition.** TWR makes
mid-event deposits harmless, but freezing removes the argument entirely, and
"no new money during the challenge" is a rule students find obviously fair. A
`block_cash_adjustments` flag on the competition; the teacher can override per
student with a reason, which is logged as always.

**Percent of the whole account, not just the invested part.** Portfolio value
= cash + market value of holdings. If only invested money counted, a student
could put $1 into one volatile stock, ignore the other $999, and post a huge
percentage on a rounding error. Whole-account return means idle cash is a real
choice with a real cost, which is the correct lesson.

**Consequence worth planning for:** whole-account return is only comparable if
students start the window with comparable balances. The competition captures a
baseline per student at the start; if those baselines vary widely, the board
is still valid (percentages are percentages) but check the spread before
running an event. A `baseline` column in the teacher view makes it visible.

---

## 2. Snapshots, not live ticks

Quotes are delayed and cached 60s. A board recomputed on every page load would
churn all period and invite refresh-mashing — precisely the "rapid trading
prompt" §10 warns about.

- A `leaderboard_snapshots` row per student per school day, written by a
  once-daily job after market close.
- Rankings are computed from snapshots. The board shows **"as of <date>"**.
- A student's own detail view may show a live provisional figure, clearly
  labeled, because that is their own account.
- Snapshots also give sparklines, "biggest mover this week", and an honest
  final standing that does not depend on what second the event ended.

If a scheduled job is too much for now, the fallback is to write a snapshot
lazily on first request each day. Same table, same shape.

---

## 3. Schema (additive)

```
competitions(
  id PK, name, description,
  starts_at, ends_at,                 -- ISO-8601 TEXT
  status TEXT,                        -- 'draft' | 'running' | 'ended' | 'archived'
  ranking TEXT DEFAULT 'percent_return',
  block_cash_adjustments INT DEFAULT 1,
  requires_qualification INT DEFAULT 0,
  qualify_check TEXT NULL,            -- reuses the Class-tab check registry, e.g. owns_sector_count
  qualify_params TEXT NULL,           -- JSON
  created_by FK, created_at
)

competition_classes(competition_id FK, class_id FK, PRIMARY KEY (competition_id, class_id))

competition_baselines(              -- frozen at start; never updated
  competition_id FK, user_id FK,
  baseline_value_cents INT, captured_at,
  PRIMARY KEY (competition_id, user_id)
)

leaderboard_snapshots(
  id PK, user_id FK, class_id FK, as_of_date TEXT,
  value_cents INT,                   -- cash + holdings market value
  net_contributed_cents INT,         -- running sum of cash in/out, for TWR chaining
  twr_bp INT,                        -- return since account open, basis points
  sectors_held INT, top_position_bp INT,   -- the diversification column
  holdings_count INT,
  created_at,
  UNIQUE (user_id, as_of_date)
)

competition_results(                -- written once when an event ends; immutable
  competition_id FK, user_id FK, rank INT, return_bp INT,
  sectors_held INT, top_position_bp INT, finalized_at,
  PRIMARY KEY (competition_id, user_id)
)
```

`twr_bp` in basis points keeps it integer, consistent with cents and
micro-shares. 1,234 bp = +12.34%.

Like the ledger, `competition_results` is written once and never updated. A
finished competition is a historical record; re-ranking it later because a
price was revised would be worse than a slightly wrong number.

---

## 4. What a row shows

Ranked by percent return, descending. Every row carries the context columns —
they do not change the sort, they just make the sort honest.

| # | Student | Return | Sectors | Largest position | Holdings |
|---|---|---|---|---|---|
| 1 | Jordan P. | **+14.2%** | 1 | 92% in one stock | 1 |
| 2 | Alex R. | **+9.8%** | 5 | 31% | 7 |
| 3 | Sam T. | **+9.1%** | 4 | 28% | 6 |

Jordan is genuinely first and the board says so. It also says, without
editorializing, that Jordan owns one thing. That is the entire mechanism: the
student in first place with 92% in one position is a teaching moment you get
for free, every time the class looks at the board.

**Percent only — never another student's dollar balance.** Students in SimLife
have different jobs and different `job_pay_cents`, so dollar figures would
broadcast who was assigned the good job. Percentages compare fairly and leak
nothing. This is a privacy rule, not a preference: the API must not return
another student's `value_cents` to a student client at all.

---

## 5. Period versus period

Alongside the individual board, one aggregate per class: **median** return,
not mean. A median cannot be carried by one lucky student, which is the whole
point of a team score — it rewards the class where most people did reasonably,
not the class with one outlier.

Shown as a simple head-to-head: `3rd Period +4.1%  ·  4th Period +2.8%`, with
participation beside it (`14 of 21 competing`), because a class where half the
students never traded should not look identical to one where everyone did.

---

## 6. Routes

```
Student (auth):
  GET /api/class/leaderboard?competitionId=    own class's board + own rank
  GET /api/class/competitions                  events their class is in, with status
Teacher (auth + role):
  GET    /api/teacher/competitions
  POST   /api/teacher/competitions             { name, description, startsAt, endsAt, classIds, ... }
  PATCH  /api/teacher/competitions/:id         edit while draft; start / end / archive
  POST   /api/teacher/competitions/:id/start   captures baselines for every eligible student
  POST   /api/teacher/competitions/:id/end     computes and freezes competition_results
  GET    /api/teacher/leaderboard?classId=     all classes, with dollar columns
  POST   /api/teacher/snapshots/run            manual snapshot (also run by the daily job)
```

A student requesting another class's board gets 404. A student requesting a
`draft` competition gets 404 — an unannounced event should not be discoverable.

New files: `server/leaderboard.ts` (snapshots + TWR), `server/competitions.ts`
(CRUD + lifecycle), and tests for both. The TWR chaining is the part that
needs real test coverage: a deposit mid-window must not move the percentage.

---

## 7. UI

**Student — inside the Class tab**, as a second section beside Assignments.
It does not get its own nav entry; the point of putting the Class tab where
the profile sits was that it is one place for class business, and a standing
leaderboard in the main rail would make the app feel like a game.

Active competition: name, a countdown to the end date, the board, and the
student's own row pinned at the bottom so they never have to scroll to find
themselves. Past competitions are a collapsed list of archived standings.

**Teacher — a Competitions section in the Modules tab.** Create, set dates,
pick classes, start, end. A live preview of standings with dollar columns you
can see and students cannot.

Design per §10: no confetti, no rank-change animations, no "🔥 on a streak".
A quiet table in the existing warm-paper style. First place gets a bolder row
and nothing else.

---

## 8. Example — Mr. Vann's Investing Challenge

```jsonc
{
  "name": "Mr. Vann's Investing Challenge",
  "description": "Highest percent gain from September 25 to October 17. Your ledger is the record.",
  "startsAt": "2026-09-25T08:00:00-04:00",
  "endsAt":   "2026-10-17T15:00:00-04:00",
  "classIds": ["<3rd period>", "<4th period>"],
  "ranking": "percent_return",
  "blockCashAdjustments": true,
  "requiresQualification": true,
  "qualifyCheck": "owns_sector_count",
  "qualifyParams": { "min": 3 }
}
```

The qualification line is optional and worth considering: appear on the board
only once you hold three sectors. It ties the competition directly to the
Week 2 lesson and quietly removes the all-in-on-one-stock strategy from
contention without ever banning it. Leave it off and the board still works.

---

## 9. Risks, stated plainly

1. **Three weeks of return is mostly luck.** The winner will believe it was
   skill. Worth saying out loud at the awarding, and worth running two or
   three short competitions across the year rather than one long one — over
   several events the luck averages out and more students get a turn in front.
2. **Concentration still wins some weeks.** The diversification column makes
   it visible but does not prevent it. The qualification rule is the actual
   lever if it becomes a problem.
3. **The student in last place is in last place publicly**, every day, for
   three weeks. The period team score exists partly so they have something to
   belong to. Consider also ending events on a specific class day so the final
   board is discussed once and then archived, rather than sitting there.
4. **Participation gaps skew the team score.** With 6 of 21 and 8 of ~20
   currently holding anything, a median return today would describe a third of
   each room. Fix the participation problem before running the first event.

---

## 10. Build order

1. `leaderboard_snapshots` + the daily snapshot job + TWR, with tests. No UI.
   Nothing is visible; the data starts accumulating, which it must do before
   any board can show history.
2. Always-on class board, students see it, percent + diversification columns.
3. `competitions` with dates, baselines, start/end lifecycle, frozen results.
4. Period-versus-period median.
5. Qualification rules — needs the Class-tab check registry from
   `CLASS_TAB_PLAN.md` §5, so it comes after that.

Step 1 before anything else, and ideally soon: a board can only show a
trend once snapshots exist, and no snapshot can be backfilled from the past.
