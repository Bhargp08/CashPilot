import type { BusinessState, Currency, Decision, IsoDate } from "@/contracts/types";

export const BUSINESS_NAME = "Northwind Roasters";
export const AS_OF: IsoDate = "2026-11-02"; // Day 1

/** "Day N" is the as-of date plus N-1 days. */
export function dayDate(n: number): IsoDate {
  const d = new Date(`${AS_OF}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n - 1);
  return d.toISOString().slice(0, 10);
}
export function dayNumber(date: IsoDate): number {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${AS_OF}T00:00:00Z`)) / 86_400_000) + 1;
}

// Demo scenario: a coffee importer whose USD payroll lands before a customer pays, with spare cash sitting in EUR.
// Amounts are minor units. Tuned so that paying everything on schedule empties the USD account on Day 4
// while converting EUR keeps it above the $5,000 reserve.
export const crunchScenario: BusinessState = {
  asOf: AS_OF,
  baseCurrency: "USD",
  balances: [
    { accountId: "acc_usd", currency: "USD", available: 1_240_000 },
    { accountId: "acc_eur", currency: "EUR", available: 1_400_000 },
  ],
  fxRates: [
    { from: "EUR", to: "USD", rate: 1.08 },
    { from: "USD", to: "EUR", rate: 1 / 1.08 },
  ],
  obligations: [
    { id: "ob_payroll", payee: "Payroll", category: "payroll", amount: 1_500_000, currency: "USD", dueDate: dayDate(4), priority: 5, latePenaltyNote: "Protected: missing payroll is a legal and trust failure" },
    { id: "ob_saas", payee: "SaaS Stack", category: "software", amount: 84_000, currency: "USD", dueDate: dayDate(5), priority: 1, deferrableUntil: dayDate(19), latePenaltyNote: "Low penalty for a late payment" },
    { id: "ob_supplier", payee: "EU Supplier (beans)", category: "supplier", amount: 650_000, currency: "EUR", dueDate: dayDate(6), priority: 4, deferrableUntil: dayDate(12), needsReview: true, latePenaltyNote: "Large, and the customer payment that covers it may slip" },
    { id: "ob_rent", payee: "Office Rent", category: "rent", amount: 420_000, currency: "USD", dueDate: dayDate(7), priority: 4, deferrableUntil: dayDate(21) },
    { id: "ob_lease", payee: "Equipment Lease", category: "supplier", amount: 115_000, currency: "USD", dueDate: dayDate(9), priority: 3, deferrableUntil: dayDate(23) },
    { id: "ob_tax", payee: "Quarterly Tax", category: "tax", amount: 360_000, currency: "USD", dueDate: dayDate(12), priority: 4, latePenaltyNote: "Penalties accrue daily" },
  ],
  inflows: [
    { id: "in_wholesale", payer: "Wholesale Customer Payment", amount: 950_000, currency: "USD", expectedDate: dayDate(6), confidence: 0.6 },
    { id: "in_store", payer: "Online Store Payout", amount: 230_000, currency: "USD", expectedDate: dayDate(10), confidence: 0.9 },
  ],
  otherAssets: [
    { id: "as_sav", name: "High-yield savings", kind: "savings", value: 2_500_000, currency: "USD", daysToCash: 1, costBps: 0, costNote: "No fee. Lands next business day." },
    { id: "as_tbill", name: "Treasury bills", kind: "treasuries", value: 1_500_000, currency: "USD", daysToCash: 2, costBps: 5, costNote: "About 0.05% selling spread." },
    { id: "as_brk", name: "Brokerage (index funds)", kind: "brokerage", value: 4_230_000, currency: "USD", daysToCash: 2, costBps: 320, costNote: "Estimated 3.2% tax on gains, taken from proceeds." },
    { id: "as_roth", name: "Roth IRA (personal)", kind: "roth_ira", value: 1_860_000, currency: "USD", daysToCash: 5, costBps: 3400, freeAmount: 1_100_000, restricted: true, costNote: "Contributions up to $11,000 come out free. Beyond that, about 34% in penalty and tax." },
  ],
  policy: {
    reserveFloor: { amount: 500_000, currency: "USD" },
    neverAutoDefer: ["payroll", "tax"],
    escalateAbove: { amount: 2_000_000, currency: "USD" },
    maxFxSpreadBps: 80,
  },
};

export interface CompletedSeed {
  id: string;
  payee: string;
  amount: number;
  currency: Currency;
  executedDay: number; // 0 = yesterday
}

export const completedSeed: CompletedSeed[] = [
  { id: "done_packaging", payee: "Packaging Supplier", amount: 148_000, currency: "USD", executedDay: 0 },
];

export interface SeedDecision {
  id: string;
  decision: Decision;
  status: "PENDING" | "APPROVED";
}

// The agent's opening plan. Low-risk items inside policy are pre-approved; the conversion and the supplier wait for a human.
export const seedDecisions: SeedDecision[] = [
  { id: "d_convert", status: "PENDING", decision: { action: "convert", from: "EUR", to: "USD", sellAmount: 710_000, executeOn: dayDate(3), reason: "Covers the Day 4 payroll gap. Without it the USD account cannot pay payroll, and with it USD stays above your reserve." } },
  { id: "d_fund_payroll", status: "APPROVED", decision: { action: "fund", obligationId: "ob_payroll", reason: "Protected by your rules, so it is paid first and never deferred." } },
  { id: "d_defer_saas", status: "APPROVED", decision: { action: "defer", obligationId: "ob_saas", newDate: dayDate(12), reason: "Low priority with a low late penalty. Pushing it 7 days frees cash during the tightest days." } },
  { id: "d_fund_rent", status: "APPROVED", decision: { action: "fund", obligationId: "ob_rent", reason: "High priority and the customer payment lands the day before." } },
  { id: "d_fund_tax", status: "APPROVED", decision: { action: "fund", obligationId: "ob_tax", reason: "Penalties accrue daily and your rules do not allow deferring tax." } },
  { id: "d_escalate_supplier", status: "PENDING", decision: { action: "escalate", obligationId: "ob_supplier", question: "Pay the EU supplier on Day 6?", reason: "Large payment, and the customer payment that covers it has only a 60% chance of arriving on time." } },
];
