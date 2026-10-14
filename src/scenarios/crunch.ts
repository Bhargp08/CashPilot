import type { BusinessState } from "@/contracts/types";

// Seeded demo scenario: ~$18k across USD/EUR vs ~$32k due in 72 hours. Amounts are minor units.
export const crunchScenario: BusinessState = {
  asOf: "2026-11-02",
  baseCurrency: "USD",
  balances: [
    { accountId: "acc_usd", currency: "USD", available: 600_000 },
    { accountId: "acc_eur", currency: "EUR", available: 1_100_000 },
  ],
  fxRates: [
    { from: "EUR", to: "USD", rate: 1.08 },
    { from: "USD", to: "EUR", rate: 0.925 },
  ],
  obligations: [
    { id: "ob_payroll", payee: "Payroll (12 staff)", category: "payroll", amount: 1_400_000, currency: "USD", dueDate: "2026-11-03", priority: 5, latePenaltyNote: "Missing payroll is a legal and trust failure" },
    { id: "ob_supplier", payee: "Northwind Components", category: "supplier", amount: 900_000, currency: "USD", dueDate: "2026-11-04", priority: 4, latePenaltyNote: "Sole supplier, will pause shipments", deferrableUntil: "2026-11-06" },
    { id: "ob_rent", payee: "Harbor Offices", category: "rent", amount: 450_000, currency: "USD", dueDate: "2026-11-05", priority: 3, deferrableUntil: "2026-11-10" },
    { id: "ob_saas", payee: "CloudSuite SaaS", category: "software", amount: 120_000, currency: "USD", dueDate: "2026-11-04", priority: 1, deferrableUntil: "2026-11-15" },
    { id: "ob_legal", payee: "Kessler & Rowe LLP", category: "other", amount: 330_000, currency: "EUR", dueDate: "2026-11-05", priority: 2, latePenaltyNote: "Large, uncertain invoice under dispute", needsReview: true },
  ],
  inflows: [
    { id: "in_acme", payer: "Acme Corp", amount: 1_500_000, currency: "USD", expectedDate: "2026-11-09", confidence: 0.8 },
    { id: "in_globex", payer: "Globex GmbH", amount: 700_000, currency: "EUR", expectedDate: "2026-11-12", confidence: 0.6 },
  ],
  otherAssets: [
    { id: "as_sav", name: "High-yield savings", kind: "savings", value: 2_500_000, currency: "USD", daysToCash: 1, costBps: 0, costNote: "No fee. Lands next business day." },
    { id: "as_tbill", name: "Treasury bills", kind: "treasuries", value: 1_500_000, currency: "USD", daysToCash: 2, costBps: 5, costNote: "About 0.05% selling spread." },
    { id: "as_brk", name: "Brokerage (index funds)", kind: "brokerage", value: 4_230_000, currency: "USD", daysToCash: 2, costBps: 320, costNote: "Estimated 3.2% tax on gains, taken from proceeds." },
    { id: "as_roth", name: "Roth IRA (personal)", kind: "roth_ira", value: 1_860_000, currency: "USD", daysToCash: 5, costBps: 3400, freeAmount: 1_100_000, restricted: true, costNote: "Contributions up to $11,000 come out free. Beyond that, about 34% in penalty and tax." },
  ],
  policy: {
    reserveFloor: { amount: 200_000, currency: "USD" },
    neverAutoDefer: ["payroll", "tax"],
    escalateAbove: { amount: 2_000_000, currency: "USD" },
    maxFxSpreadBps: 80,
  },
};
