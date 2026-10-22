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
Explain the choice in one answer, then make one official decision. No post-spin
reflection. Drafts autosave; Submit work accepts partial answers without taking
out a loan or changing a job. Making the official decision is the separate,
clearly labeled action that requires a chosen route and an explanation.

Keep-working preserves the job and adds no debt. A school-route spin assigns a
job and future weekly pay, captures the explanation and terms, and creates the
first loan bill in one transaction. One official decision per student across
refreshes, devices and class transfers. Client-supplied pay/draw indices are not
accepted. Later job changes never change the loan's saved monthly payment.

## Financing assumptions

School budgets and support are **fictional classroom scenarios**, not published
prices, aid offers, eligibility estimates or claims about these institutions.
School cost links allow comparison with real prices researched in module 2.
No borrowed funds are added to checking; the scenario fast-forwards through
training and licenses. Existing living expenses are reused, not reassigned.

| Route | Classroom school budget | SimLife scholarship/support | Borrowed | Monthly payment |
|---|---:|---:|---:|---:|
| Keep working | $0 | $0 | $0 | $0 |
| Four-year | $48,000 | $24,000 | $24,000 | $266.45 |
| Two-year | $24,000 | $12,000 | $12,000 | $133.23 |
| Art | $180,000 | $144,000 | $36,000 | $399.68 |
| Trade | $12,000 | $4,000 | $8,000 | $88.82 |

Loan calculations use 6% APR over 120 monthly installments, amortized with
monthly interest rounded to cents. The regular payment rounds up to a cent and
the final installment adjusts to pay off exactly. This classroom rate and term
are not presented as current federal repayment eligibility or an actual offer.
Reference: https://studentaid.gov/articles/repayment-calculator/

The first bill arrives immediately, due one calendar month after the choice.
Another statement arrives every calendar month; a one-minute server timer,
startup catch-up, and Banking reads make issuance resilient to downtime. The
original date anchors month-end arithmetic. Each installment has a unique key.
The final payment ends issuance; existing unpaid bills remain payable. No extra
late fees or late interest in this simplified model.

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
pay, divides by 52 and rounds to whole dollars to assign weekly game pay. This
is a take-home approximation, not individualized tax advice or a tax engine.
Monthly views use weekly pay × 52 ÷ 12. Budget estimates reuse monthly rent/car
and other unpaid non-loan bills due within 30 days; the latter are not falsely
labeled as permanent recurring costs. Lower and higher outcomes share one loan.

## Data and rollout

Additive tables: `black_monday_events`, `education_class_settings`,
`education_decisions`, `education_installments`. Existing journals/bills remain
the payment source of truth. Job decisions and loans are explicit student
choices after teacher release; nobody is fired or charged on deployment. New
history is counted by empty-account deletion protections.

The module seeds once without resetting title, visibility or prior student
work. Default decision permission is closed for every period. No production
student balances or jobs were modified during implementation.
