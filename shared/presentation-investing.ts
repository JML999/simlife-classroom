export const PRESENTATION_POST_ID = "cpost_presentation_investing_v1";
export const PRESENTATION_BUDGET_CENTS = 50000;
export type PresentationPick = { ticker: string; cents: number };
export type PresentationResponse = { allocations: PresentationPick[] };
export type PresentationCompany = { ticker: string; studentId: string; name: string; presenter: string };
