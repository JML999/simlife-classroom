import { COLLEGE_ROUTES } from "./college-research.js";

export const COLLEGE_COSTS_POST_ID = "cpost_college_costs_v1";
export const COLLEGE_RESEARCH_POST_ID = "cpost_college_paths_v1";
export const COLLEGE_COST_LINKS = [
  "https://www.valdosta.edu/admissions/financial-aid/cost-of-attendance/cost-of-attendance.php",
  "https://sfs.gsu.edu/resources/coa/",
  "https://www.scad.edu/content/cost-attendance",
  "https://southernregional.edu/consumer-information",
] as const;
export const COLLEGE_COST_FIELDS = [
  ["tuition", "Tuition and fees per year"],
  ["otherExpenses", "Other estimated expenses per year"],
  ["total", "Total estimated cost per year"],
] as const;
export type CostRoute = { institution: string; otherInstitution: string; tuition: string; otherExpenses: string; total: string; source: string };
export type CollegeCostsResponse = { version: 3; routes: CostRoute[]; reflection: string };
/** Accept copied dollar figures, including commas; blank is not zero. */
export function collegeCostCents(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/^\$\s*/, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const cents = Math.round(Number(text) * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}
export function collegeCostSource(value: string): boolean {
  try { return ["https:", "http:"].includes(new URL(value).protocol); } catch { return false; }
}
export function collegeCostRouteDone(route: CostRoute | undefined): boolean {
  return !!route && ["default", "other"].includes(route.institution)
    && (route.institution !== "other" || !!route.otherInstitution.trim())
    && COLLEGE_COST_FIELDS.every(([key]) => collegeCostCents(route[key]) !== null)
    && collegeCostSource(route.source);
}
export function collegeCostsDone(response: CollegeCostsResponse): number {
  return COLLEGE_ROUTES.filter((_, i) => collegeCostRouteDone(response.routes?.[i])).length + (response.reflection?.trim() ? 1 : 0);
}
/** Carry only school choices into the new assignment, never answers or completion. */
export function emptyCollegeCosts(previous?: { routes?: { institution?: string; otherInstitution?: string }[] }): CollegeCostsResponse {
  return { version: 3, routes: COLLEGE_ROUTES.map((_, i) => ({
    institution: previous?.routes?.[i]?.institution === "other" ? "other" : "default",
    otherInstitution: previous?.routes?.[i]?.otherInstitution || "",
    tuition: "", otherExpenses: "", total: "", source: "",
  })), reflection: "" };
}
