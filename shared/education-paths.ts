/** Published career benchmarks + explicitly fictional classroom financing. */
export const EDUCATION_POST_ID = "cpost_education_decision_v1";
export type EducationResponse = { version: 4; routeId: string; reason: string };
export const emptyEducationResponse = (): EducationResponse => ({ version: 4, routeId: "", reason: "" });
export const EDUCATION_APR_BPS = 600; // Classroom assumption, not a current federal offer.
export const EDUCATION_MONTHS = 120;
export const weeklyGamePay = (annualDollars: number) => Math.round(annualDollars * .8 / 52) * 100;
export const monthlyFromWeekly = (weeklyCents: number) => Math.round(weeklyCents * 52 / 12);
const bls = "https://www.bls.gov/ooh/";
const job = (key: string, title: string, annual: number, path: string, note = "") => ({ key, title, annual, source: bls + path, sourceYear: 2025, weeklyCents: weeklyGamePay(annual), note });
export const EDUCATION_PATHS = [
  { id: "work", title: "Keep working", school: "No additional schooling", years: "Start now", costCents: 0, supportCents: 0, principalCents: 0, source: "", risk: "No new school debt. Your current job and pay stay the same.", jobs: [] },
  { id: "fourYear", title: "Four-year college", school: "Valdosta State University", years: "4 years", costCents: 4800000, supportCents: 2400000, principalCents: 2400000, source: "https://www.valdosta.edu/admissions/financial-aid/cost-of-attendance/cost-of-attendance.php", risk: "Higher earning potential, but your loan payment is due even with a lower-paying outcome.", jobs: [
    job("social", "Child & family social worker", 59550, "community-and-social-service/social-workers.htm", "Nonclinical role; clinical social work needs additional education."),
    job("teacher", "Elementary teacher", 63970, "education-training-and-library/kindergarten-and-elementary-school-teachers.htm", "Includes required teacher certification in this scenario."),
    job("accountant", "Accountant", 83680, "business-and-financial/accountants-and-auditors.htm"),
    job("developer", "Software developer", 135980, "computer-and-information-technology/software-developers.htm"),
  ] },
  { id: "community", title: "Two-year college", school: "Georgia State — Perimeter College", years: "About 2 years; some programs take longer", costCents: 2400000, supportCents: 1200000, principalCents: 1200000, source: "https://sfs.gsu.edu/resources/coa/", risk: "Less borrowing, with a wide range of career pay. Some careers need selective programs and licensing.", jobs: [
    job("assistant", "Teacher assistant", 36780, "education-training-and-library/teacher-assistants.htm"),
    job("support", "Computer user support specialist", 61860, "computer-and-information-technology/computer-support-specialists.htm"),
    job("nurse", "Registered nurse", 97550, "healthcare/registered-nurses.htm", "Assumes an approved nursing program and a nursing license."),
    job("hygienist", "Dental hygienist", 98100, "healthcare/dental-hygienists.htm", "Often about 3 years including prerequisites; assumes licensing."),
  ] },
  { id: "art", title: "Art & design school", school: "SCAD", years: "4 years", costCents: 18000000, supportCents: 14400000, principalCents: 3600000, source: "https://www.scad.edu/content/cost-attendance", risk: "A bigger payment follows you into both lower- and higher-paying creative careers. Portfolio and steady work matter.", jobs: [
    job("photo", "Photographer", 44658, "media-and-communication/photographers.htm", "$21.47/hour × 2,080 hours; full-time classroom estimate, not guaranteed freelance income."),
    job("graphic", "Graphic designer", 62960, "arts-and-design/graphic-designers.htm"),
    job("interior", "Interior designer", 67190, "arts-and-design/interior-designers.htm"),
    job("animator", "Animator / special effects artist", 102030, "arts-and-design/multimedia-artists-and-animators.htm"),
  ] },
  { id: "technical", title: "Trade & technical school", school: "Southern Regional Technical College — Thomasville", years: "Varies by credential", costCents: 1200000, supportCents: 400000, principalCents: 800000, source: "https://southernregional.edu/consumer-information", risk: "Smaller loan and practical training. Pay varies by trade, experience, licensing, and demand.", jobs: [
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
