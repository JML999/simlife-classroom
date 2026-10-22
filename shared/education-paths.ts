/** Published school-cost baselines and career benchmarks; classroom loan assumptions. */
export const EDUCATION_POST_ID = "cpost_education_decision_v1";
export type EducationResponse = { version: 4; routeId: string; reason: string; signature: string };
export const emptyEducationResponse = (): EducationResponse => ({ version: 4, routeId: "", reason: "", signature: "" });
export const EDUCATION_APR_BPS = 600; // Classroom assumption, not a current federal offer.
export const EDUCATION_MONTHS = 300;
export const weeklyGamePay = (annualDollars: number) => Math.round(annualDollars * .8 / 52) * 100;
export const monthlyFromWeekly = (weeklyCents: number) => Math.round(weeklyCents * 52 / 12);
const bls = "https://www.bls.gov/ooh/";
const job = (key: string, title: string, annual: number, path: string, note = "") => ({ key, title, annual, source: bls + path, sourceYear: 2025, weeklyCents: weeklyGamePay(annual), note });
export const EDUCATION_PATHS = [
  { id: "work", title: "Keep working", school: "No additional schooling", years: "Start now", costCents: 0, principalCents: 0, costBasis: "No tuition or new education loan.", costItems: [] as { label: string; cents: number }[], source: "", risk: "No new school debt. Your current job and pay stay the same.", jobs: [] },
  { id: "fourYear", title: "Four-year college", school: "Valdosta State University", years: "4 years", costCents: 3402400, principalCents: 3402400, costBasis: "2026–27 Georgia-resident rates: 15 credits per semester × 8 semesters. Current rates held flat; program-specific charges may vary.", costItems: [{label: "Tuition & mandatory fees · $3,653 × 8 semesters", cents: 2922400}, {label: "Estimated books · $600 × 8 semesters", cents: 480000}], source: "https://www.valdosta.edu/administration/finance-admin/financial-services/students/services/fee-schedule-for-undergraduates-effective-fall-2026.pdf", risk: "Higher earning potential, but your loan payment is due even with a lower-paying outcome.", jobs: [
    job("social", "Child & family social worker", 59550, "community-and-social-service/social-workers.htm", "Nonclinical role; clinical social work needs additional education."),
    job("teacher", "Elementary teacher", 63970, "education-training-and-library/kindergarten-and-elementary-school-teachers.htm", "Includes required teacher certification in this scenario."),
    job("accountant", "Accountant", 83680, "business-and-financial/accountants-and-auditors.htm"),
    job("developer", "Software developer", 135980, "computer-and-information-technology/software-developers.htm"),
  ] },
  { id: "community", title: "Two-year college", school: "Georgia State — Perimeter College", years: "About 2 years; some programs take longer", costCents: 1209200, principalCents: 1209200, costBasis: "2026–27 Georgia-resident estimate: 30 credits per year × 2 years. Current rates held flat. Nursing, dental hygiene and extra prerequisites can cost more.", costItems: [{label: "Tuition · $1,650 × 4 semesters", cents: 660000}, {label: "Student fees · $340 × 4 semesters", cents: 136000}, {label: "Estimated books & supplies · $1,033 × 4 semesters", cents: 413200}], source: "https://admissions.gsu.edu/admissions/educators-guide/", risk: "Less borrowing, with a wide range of career pay. Some careers need selective programs and licensing.", jobs: [
    job("assistant", "Teacher assistant", 36780, "education-training-and-library/teacher-assistants.htm"),
    job("support", "Computer user support specialist", 61860, "computer-and-information-technology/computer-support-specialists.htm"),
    job("nurse", "Registered nurse", 97550, "healthcare/registered-nurses.htm", "Assumes an approved nursing program and a nursing license."),
    job("hygienist", "Dental hygienist", 98100, "healthcare/dental-hygienists.htm", "Often about 3 years including prerequisites; assumes licensing."),
  ] },
  { id: "art", title: "Art & design school", school: "SCAD", years: "4 years", costCents: 18063600, principalCents: 18063600, costBasis: "2026–27 full-time tuition and estimated books/supplies × 4 years, plus application/enrollment fees. Current rates held flat; actual costs depend on program and aid.", costItems: [{label: "Tuition · $42,975 × 4 years", cents: 17190000}, {label: "Estimated books & supplies · $2,034 × 4 years", cents: 813600}, {label: "Application & enrollment fees · once", cents: 60000}], source: "https://www.scad.edu/content/cost-attendance", risk: "A bigger payment follows you into both lower- and higher-paying creative careers. Portfolio and steady work matter.", jobs: [
    job("photo", "Photographer", 44658, "media-and-communication/photographers.htm", "$21.47/hour × 2,080 hours; full-time classroom estimate, not guaranteed freelance income."),
    job("graphic", "Graphic designer", 62960, "arts-and-design/graphic-designers.htm"),
    job("interior", "Interior designer", 67190, "arts-and-design/interior-designers.htm"),
    job("animator", "Animator / special effects artist", 102030, "arts-and-design/multimedia-artists-and-animators.htm"),
  ] },
  { id: "technical", title: "Trade & technical school", school: "Southern Regional Technical College — Thomasville", years: "Varies by credential", costCents: 731400, principalCents: 731400, costBasis: "SRTC’s published Air Conditioning Technology diploma estimate: 54 credits over 4 terms. The school lists no books/supplies allowance for this diploma; actual supplies can add cost. This is the fixed trade-route example; other credentials have different costs (automotive $8,126; welding $8,101; master cosmetology $6,982.05). Checked October 22, 2026.", costItems: [{label: "Tuition · 54 credits", cents: 577800}, {label: "Institutional fees · 4 terms", cents: 153600}], source: "https://southernregional.edu/program-cost", risk: "Smaller loan and practical training. Pay varies by trade, experience, licensing, and demand.", jobs: [
    job("cosmetology", "Cosmetologist", 35797, "personal-care-and-service/barbers-hairstylists-and-cosmetologists.htm", "$17.21/hour × 2,080 hours; assumes licensing."),
    job("auto", "Automotive technician", 50620, "installation-maintenance-and-repair/automotive-service-technicians-and-mechanics.htm"),
    job("welder", "Welder", 53750, "production/welders-cutters-solderers-and-brazers.htm"),
    job("hvac", "HVAC technician", 61010, "installation-maintenance-and-repair/heating-air-conditioning-and-refrigeration-mechanics-and-installers.htm"),
  ] },
];
export function repaymentSchedule(principalCents: number, aprBps = EDUCATION_APR_BPS, months = EDUCATION_MONTHS) {
  if (!principalCents) return { monthlyCents: 0, totalCents: 0, interestCents: 0, installments: [] as number[] };
  const rate = aprBps / 10000 / 12;
  const monthlyCents = Math.ceil(rate ? principalCents * rate / (1 - (1 + rate) ** -months) : principalCents / months);
  let balance = principalCents;
  const installments: number[] = [];
  for (let i = 0; i < months && balance > 0; i++) {
    const interest = Math.round(balance * rate);
    const payment = Math.min(monthlyCents, balance + interest);
    installments.push(payment); balance = balance + interest - payment;
  }
  const totalCents = installments.reduce((sum, cents) => sum + cents, 0);
  return { monthlyCents, totalCents, interestCents: totalCents - principalCents, installments };
}
export const BLACK_MONDAY_OPTIONS = [
  { key: "arbys", title: "Laid off → Arby’s cashier", shortLabel: "Arby’s", newJobTitle: "Cashier at Arby's", newPayCents: 40000, description: "$400 per weekly paycheck. A fresh start behind the counter." },
  { key: "grocery", title: "Laid off → grocery cashier", shortLabel: "Grocery", newJobTitle: "Grocery Store Cashier", newPayCents: 45000, description: "$450 per weekly paycheck. You found work at the grocery store." },
  { key: "warehouse", title: "Laid off → warehouse associate", shortLabel: "Warehouse", newJobTitle: "Warehouse Associate", newPayCents: 55000, description: "$550 per weekly paycheck. A new role on the warehouse floor." },
  { key: "service", title: "Laid off → customer service", shortLabel: "Customer service", newJobTitle: "Customer Service Representative", newPayCents: 60000, description: "$600 per weekly paycheck. Your next chapter is customer service." },
  { key: "safe", title: "You survived the layoffs", shortLabel: "You’re safe", newJobTitle: null, newPayCents: null, description: "Keep your current job and paycheck. No change this round." },
];
