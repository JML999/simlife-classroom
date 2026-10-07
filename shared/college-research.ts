/** Shared worksheet structure keeps student and server validation in agreement. */
export const COLLEGE_ROUTES = [
  { id: "fourYear", title: "Four-year college", institution: "Valdosta State University", url: "https://www.valdosta.edu/", hint: "Research bachelor’s majors and the careers they can lead to." },
  { id: "community", title: "Community college", institution: "Georgia State University — Perimeter College", url: "https://perimeter.gsu.edu/", hint: "Distinguish careers available with an associate degree from pathways requiring transfer and a bachelor’s degree." },
  { id: "art", title: "Art & design school", institution: "SCAD", url: "https://www.scad.edu/", hint: "Compare creative programs and the occupations their graduates might pursue." },
  { id: "technical", title: "Trade & technical training", institution: "Southern Regional Technical College — Thomasville", url: "https://southernregional.edu/", hint: "Check the credential and whether your program is offered at the Thomasville location." },
] as const;
export const COLLEGE_RESEARCH_TOPICS = [
  { id: "highPay", title: "Higher typical pay", hint: "Find a higher-paying major, program, or career within this route." },
  { id: "lowPay", title: "Lower typical pay", hint: "Find a lower-paying major, program, or career within this route." },
  { id: "strongEmployment", title: "Stronger employment prospects", hint: "Use unemployment, program placement, or projected job growth. Name the measure." },
  { id: "weakEmployment", title: "Weaker employment prospects", hint: "Compare the same measure and similar populations when possible. Explain if comparable data is unavailable." },
] as const;
export const COLLEGE_PROGRAM_FIELDS = [
  ["program", "Program offered", "Name an actual major, degree, diploma, or certificate offered at this school."],
  ["career", "Associated career", "Name a realistic occupation. Note any additional education or licensing needed."],
  ["earnings", "Typical annual earnings", "Include the dollar figure, data year, and whether it is starting, early-career, or overall median pay."],
  ["duration", "Time to qualify", "Years or months. For transfer, distinguish the associate degree from the full bachelor’s route."],
  ["tuition", "Estimated total tuition & required fees", "Published tuition and required fees over the expected program length, before aid; exclude living expenses. Show your estimate’s scope or calculation."],
  ["sources", "School & earnings sources", "Link the school’s program/cost pages and the independent earnings source."],
  ["explanation", "Explain the financial trade-off", "Use earnings, employment prospects, time, and tuition to explain why this option looks promising or challenging."],
] as const;
export type ProgramAnswer = Record<typeof COLLEGE_PROGRAM_FIELDS[number][0], string>;
export type ResearchAnswer = { program: string; figure: string; source: string };
export type RouteAnswer = { institution: string; otherInstitution: string; research: Record<typeof COLLEGE_RESEARCH_TOPICS[number]["id"], ResearchAnswer>; programs: ProgramAnswer[] };
export type CollegeResearchResponse = { version: 2; routes: RouteAnswer[]; reflection: string; previousWork?: unknown };
export function emptyCollegeResearch(): CollegeResearchResponse {
  return { version: 2, routes: COLLEGE_ROUTES.map(() => ({ institution: "default", otherInstitution: "", research: Object.fromEntries(COLLEGE_RESEARCH_TOPICS.map(t => [t.id, { program: "", figure: "", source: "" }])) as RouteAnswer["research"], programs: [0, 1].map(() => Object.fromEntries(COLLEGE_PROGRAM_FIELDS.map(([key]) => [key, ""])) as ProgramAnswer) })), reflection: "" };
}
export function collegeRouteDone(route: RouteAnswer | undefined): boolean {
  const filled = (v: unknown) => typeof v === "string" && !!v.trim();
  return !!route && ["default", "other"].includes(route.institution)
    && (route.institution !== "other" || filled(route.otherInstitution))
    && COLLEGE_RESEARCH_TOPICS.every(t => ["program", "figure", "source"].every(k => filled((route.research?.[t.id] as any)?.[k])));
}
export function collegeResearchDone(value: CollegeResearchResponse): number {
  return COLLEGE_ROUTES.filter((_, i) => collegeRouteDone(value.routes?.[i])).length + (value.reflection?.trim() ? 1 : 0);
}
export const collegeInstitution = (route: RouteAnswer, index: number) => route.institution === "other" ? route.otherInstitution : COLLEGE_ROUTES[index].institution;
