# Black Monday and the education decision

## Teacher flow

Teacher → Banking → choose a period. The existing presentation wheel now has a
**Black Monday · jobs only** mode (selected by default) and the original Life
Events mode. Black Monday has five equally likely outcomes: Arby's cashier
($400 weekly), grocery cashier ($450), warehouse associate ($550), customer
service representative ($600), or keep the current job/pay. These are fixed
game paychecks, not salary percentages or employer wage claims. One saved Black
Monday outcome per student per New York calendar day. Replaying never reapplies
an old job over a later promotion. The original wheel retains its earlier rules.

After spinning, use **Open career decisions for this period** below the wheel.
It is closed initially; opening it makes no account changes. Students find
College Module 3, **Choose Your Path: Education & Debt**, on the existing Class
page. Existing period visibility checkboxes can hide this module as usual.

## Student flow

Compare keep-working, four-year/VSU, two-year/GSU Perimeter, art/SCAD, and
trade/SRTC routes. Each school route has four equal-probability job outcomes.
Explore four school tabs (or Keep working), explain the choice in one answer,
and sign with the account name before making one official decision. No post-spin
reflection. Drafts autosave; Submit work accepts partial answers without taking
out a loan or changing a job. Making the official decision is the separate,
clearly labeled action that requires a chosen route, explanation and matching typed signature.
Changing paths clears the signature; partial submissions still need no signature.

Keep-working preserves the job and adds no debt. A school-route spin assigns a
job and future weekly pay, captures the explanation and terms, and creates the
first loan bill in one transaction. One official decision per student across
refreshes, devices and class transfers. Client-supplied pay/draw indices are not
accepted. Later job changes never change the loan's saved monthly payment.

## Financing assumptions

Costs now use published school-price baselines, checked **October 22, 2026**,
with **no invented scholarship/support**. Full modeled school cost is borrowed.
Housing, food and transportation are excluded because existing game bills cover
those categories. These are estimates before actual financial aid, not an
individual bill or a promise that the whole amount can be borrowed federally.
Current rates are held flat across the credential; no tuition inflation,
in-school interest, origination fees or program-specific extra charges are added.

| Route | Full school cost / borrowed | Monthly payment, 25 years |
|---|---:|---:|
| Keep working | $0 | $0 |
| VSU, four-year | $34,024 | $219.22 |
| GSU Perimeter, two-year | $12,092 | $77.91 |
| SCAD, four-year | $180,636 | $1,163.85 |
| SRTC, trade example | $7,314 | $47.13 |

Cost calculations and sources:
- VSU 2026–27 Georgia resident, 15 credits/semester: $3,653 tuition/mandatory
  fees + $600 estimated books per semester, times eight semesters.
  https://www.valdosta.edu/administration/finance-admin/financial-services/students/services/fee-schedule-for-undergraduates-effective-fall-2026.pdf
- GSU Perimeter 2026–27 Georgia resident: $1,650 tuition + $340 fees + $1,033
  estimated books/supplies per semester, times four semesters (30 credits/year).
  Longer/selective programs and prerequisites can cost more.
  https://admissions.gsu.edu/admissions/educators-guide/
- SCAD 2026–27: $42,975 annual tuition + $2,034 estimated books/supplies, times
  four years, plus $100 application + $500 enrollment one time.
  https://www.scad.edu/content/cost-attendance
  https://www.scad.edu/admission/tuition-and-fees/undergraduate
- SRTC publishes credential-specific totals: the fixed trade-route baseline is
  Air Conditioning Technology diploma, 54 credits/4 terms, $5,778 tuition +
  $1,536 institutional fees = $7,314. The source lists no books/misc. allowance
  for that diploma; actual supplies can add cost. Other examples are automotive
  diploma $8,126, welding diploma $8,101 and master cosmetology TCC $6,982.05.
  Those are disclosed in the tab; they are not claimed to cost exactly $7,314.
  https://southernregional.edu/program-cost

New loan calculations use **6% fixed classroom APR over 300 monthly installments
(25 years)**. Each tab also compares a 10-year payoff: smaller monthly payments
come with greater total interest. The agreement spells out principal, payment,
number of years/installments, interest and total repayment; payment remains due
if later employment changes. The recorded signature and timestamp are saved in
immutable decision terms and the submission. This is a simulated agreement, not
a real loan contract or a statement of federal repayment eligibility.

Monthly interest rounds to cents. Regular payments round up to a cent and the
final installment adjusts to pay off exactly. **Existing accepted decisions
retain their original saved costs, payments, term and statements**; no migration
rewrites previously accepted debt. Older decisions may have no signature.

## Monthly statement schedule

Student loans are now due on the **27th of each month**, at the end of the New
York calendar day. The first statement appears as soon as a signed school
choice creates the loan, due on the next 27th (including today). Later statements
appear seven calendar days before their due date. Startup, the one-minute server
timer, Banking reads and the teacher Refresh student statements button catch up
safely after downtime. One bill per loan installment, with stable IDs and keys.

Existing loan contracts keep their principal, rate, term, payment and career.
Open loan bills align to the 27th, including partially paid statements, without
resetting payments. Fully paid bills retain their original historical dates and
count as completed installments. The schedule records its first due date in
`education_billing_schedules`, independently of immutable signed financial terms.
No blanket flat amount: each actual loan uses its own saved installment amount.
Unfinished assignments/drafts/ordinary partial submissions create no debt. The
Keep working decision creates no loan. Later signed choices enroll automatically.

Teacher Banking has **Monthly statements** controls per period. Housing/car
billing is opt-in and uses `rent_cents` and `car_payment_cents` respectively.
Housing is due on the **1st**, cars on the **10th**. The first eligible cycle is
the next due date at activation or when a student first has a positive assigned
amount. No charges for earlier months without a schedule. Missing/$0 amounts
are skipped. A nearby existing housing/car bill (within seven days of the target
due date) counts for that cycle, even if already paid, to avoid double billing.
Its original amount, due date and payment history remain intact. Newly issued
cycles use the student's current assigned amount and have no added late fee.

Housing/car bills appear seven days ahead, with unique student/kind/month keys.
Pausing stops new housing/car statements; resuming catches up missed scheduled
cycles. This does not pause student loan contracts. The loan panel shows remaining
principal separately from remaining scheduled repayment including planned
interest, the next unpaid payment/date, amount due/overdue, repaid amount and
completed-installment count. Housing/car dates also appear in the student view.
Statements do not withdraw money automatically.

Teacher payroll also offers **assigned monthly pay**, computed as weekly pay ×
52 ÷ 12, through the existing preview/issue flow and wage-claim handling. This
adds no automatic payroll and does not modify assigned weekly wages. Avoid issuing
weekly and monthly pay for the same intended pay period.

Students pay through existing checking/bill-payment tools, including partial
payments. Remaining scheduled repayment = all contracted principal and interest
minus actual paid installments. This is clearly labeled; it is not presented as
remaining principal or an early-payoff quote. The game does not support early
principal-only payoff or income-driven repayment. Existing garnishment claims
are shown and reduce first-month budget projections; loan bills do not garnish
wages automatically.

## Career benchmarks

`shared/education-paths.ts` records each outcome's official BLS source URL,
benchmark year (May 2025), wage figure and qualifications note. The careers are
representative outcomes for a route, not school-specific placement statistics
or claims that every program is offered at every named campus. National medians
are not starting-salary guarantees. Photography and cosmetology annualize the
published hourly median at 2,080 hours. The game takes 80% of annual benchmark
pay, divides by 52 and rounds to whole dollars to assign weekly game pay. The social-worker outcome is explicitly overridden to $600/week by the teacher
(as of October 23, 2026), while its actual national wage benchmark stays visible. This
is a take-home approximation, not individualized tax advice or a tax engine.
Monthly views use weekly pay × 52 ÷ 12. Budget estimates reuse monthly rent/car
and other unpaid non-loan bills due within 30 days; the latter are not falsely
labeled as permanent recurring costs. Lower and higher outcomes share one loan.

## Data and rollout

Additive tables: `black_monday_events`, `education_class_settings`,
`education_decisions`, `education_installments`, `education_billing_schedules`,
`monthly_billing_classes`, `monthly_bill_schedules`, `monthly_bill_cycles`. Existing journals/bills remain
the payment source of truth. Job decisions and loans are explicit student
choices after teacher release; nobody is fired or charged on deployment. New
history is counted by empty-account deletion protections.

The module seeds once without resetting title, visibility or prior student
work. Default decision permission is closed for every period. No production
student balances or jobs were modified during implementation.
