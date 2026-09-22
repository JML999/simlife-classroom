# Class module — status, verified / not verified

> UPDATE 2026-09-22: partly stale. Suite is 91/91 (not 81). Module 2 IS built
> ("Build a five-sector portfolio", `npm run seed:mission`, published live
> 2026-09-22) and per-class hide checkboxes exist (`server/class-modules.ts`).
> Student model is now Save-draft → Submit-for-teacher-check (`137469b`,
> `726f01f`). See `SESSION_HANDOFF.md` (2026-09-22 section) for current state.
> The "NOT verified" list below is still unverified against production.

Sector sort is the first Class-tab module. This file is the handoff: what is
built, what was actually tested, and what is still missing. Companion docs:
`CLASS_TAB_PLAN.md` (the wider design), `MODULE_WEEK2_BALANCED_PORTFOLIO.md`
(the portfolio assignment, not built), `LEADERBOARD_PLAN.md` (leaderboard +
competitions, math built, UI not).

Commits: `17b97be`, `92ad5ba`, `726f01f`. All on `origin/main`.

---

## What it does

Students file a basket of tickers into sector categories. Twelve tickers, six
categories, seeded by `npm run seed:sort`. Every ticker is one a student in 3rd
or 4th period actually owns.

**Submit-for-teacher-check, not self-check** (`726f01f`). Students see
"Submitted"; they never see a score or which ones were wrong. Grading runs
server-side and lands in the teacher dashboard. Resubmitting is allowed and
each submission is kept.

**The answer key is never stored.** Correctness is checked against
`server/ticker-directory.json`'s `meta` at grading time, so an activity cannot
drift out of sync with the directory and nobody hand-types a sector wrong. A
ticker the directory cannot classify is EXCLUDED from the score, not counted
wrong — an unclassified ticker is a gap in our data, not a student error.

**Placement is pointer-event drag, plus tap-to-place.** Pointer events fire for
mouse, touch and pen; HTML5 `draggable` does not fire on touch at all, so a
drag-only build would lock out any student on a phone. Tap-a-chip-then-tap-a-
category is the second path and the one keyboard users get.

---

## Files

```
server/db.ts                  sort_activities, sort_submissions (additive)
server/sorting.ts             grading, activities, submissions, progress, misses
server/sorting.test.ts        12 tests
server/index.ts               3 student routes + 4 teacher routes
server/seed-sector-sort.ts    npm run seed:sort
src/App.tsx                   ClassSection, SortActivity, TeacherClass
src/styles.css                .ticker-chip, .bucket-grid, .sort-grid, drag ghost
```

Routes:

```
GET  /api/class/activities                     list + own submission state
GET  /api/class/activities/:id                 buckets, tokens, own attempts (NO grading)
POST /api/class/activities/:id/submit          { placements, idempotencyKey }
GET  /api/teacher/activities
POST /api/teacher/activities                   create
POST /api/teacher/activities/:id/status        draft | published | archived
GET  /api/teacher/activities/:id/progress      grid + answer key + misses
```

---

## Verified, by actually running it

Local stack (SQLite + seeded demo class), driven in a real browser:

- Class tab appears bottom-anchored in the student rail
- 12 chips, 6 category boxes render
- **drag** places a chip (mouse, pointer events, ghost follows cursor)
- **tap-then-tap** places a chip
- **touch tap** places a chip at 390×844 with `isMobile`/`hasTouch`
- submit records the attempt; banner reads "Submitted · <time>"
- **no grading leaks to students**: every `/api/class/*` response was scanned
  for `correctCount`, `correct`, `answerKey` — none present
- teacher dashboard shows 1 of 5 submitted, 4 not submitted, the per-ticker
  grid (11/12 with ✕ under AMZN), and the misfile table naming
  "Information Technology" as where AMZN went
- phone 390px: no horizontal scroll, nav collapses to a row, categories stack
  full width (348px), submit button reachable
- 81/81 tests, client + server typecheck clean

## NOT verified — do these before trusting it with a class

1. **Nothing has been tested against production.** Everything above is local
   SQLite. Sign in on the live site as yourself and as one test student.
2. Drag released over empty space (should return the chip to the tray). The
   code path exists; it was never exercised in a passing run.
3. Reload mid-sort preserving placements. Implemented (resumes from the latest
   submission) but not confirmed in a browser.
4. A student with **no class** opening the Class tab.
5. The teacher **class filter** actually narrowing the grid.
6. Two students submitting at once.

## Known gaps

- **No teacher UI to create, edit, publish or archive an activity.** The routes
  exist (`POST /api/teacher/activities`, `.../status`) but the only way to make
  one is `npm run seed:sort`. This is the biggest missing piece.
- No per-student drill-down: you see best-attempt cells, not the attempt
  history behind them.
- On a phone the six categories stack vertically, so dragging from the tray to
  a category far down the page means dragging across a scroll. Tap-to-place is
  the practical path on mobile; drag is not auto-scrolling.
- `.ticker-chip.right` / `.wrong` in styles.css are dead since `726f01f` moved
  grading teacher-side.
- Only one item type exists (sort). Written response, multiple choice and the
  portfolio-linked "task" meters in `CLASS_TAB_PLAN.md` are not built.

## Commands

```
npm test                     81 tests
npm run typecheck            client + server
npm run seed:sort            create the activity (safe to re-run)
node scripts/who-hasnt-traded.mjs "4th"        who has not bought anything
node scripts/class-portfolio-snapshot.mjs      class holdings by sector
npm run snapshot             daily leaderboard row (cannot be backfilled)
```

Note: `npm run dev` connects to PRODUCTION Supabase, because `.env` sets
`SIMLIFE_DATABASE_URL`. Unset it for a local SQLite sandbox.
