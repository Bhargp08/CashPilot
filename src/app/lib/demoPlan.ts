import type { BusinessState, Decision, Plan } from "@/contracts/types";
import { engine } from "@/engine";

// Placeholder plan so the UI has something to show. Replace with createAgent().propose(...) once feat/agent lands.
const decisions: Decision[] = [
  { action: "convert", from: "EUR", to: "USD", sellAmount: 925_926, reason: "Payroll is due in USD on Nov 3 and the USD account is $8,000 short. The EUR account has enough to cover it and keep the $2,000 reserve." },
  { action: "fund", obligationId: "ob_payroll", reason: "Payroll can never be deferred (policy), so it is paid first." },
  { action: "defer", obligationId: "ob_saas", newDate: "2026-11-15", reason: "Lowest priority and allowed to slip until Nov 15, after Acme's payment lands." },
  { action: "defer", obligationId: "ob_rent", newDate: "2026-11-10", reason: "Can wait until Nov 10, the day after Acme Corp is expected to pay $15,000." },
  { action: "escalate", obligationId: "ob_supplier", question: "Pay Northwind late, or break the $2,000 reserve to pay on time?", reason: "Paying $9,000 now would drop USD below the reserve, and it can only slip to Nov 6, before any money arrives." },
  { action: "escalate", obligationId: "ob_legal", question: "Is the Kessler & Rowe invoice correct and approved for payment?", reason: "The invoice is flagged as disputed, so it is never paid automatically." },
];

export function buildDemoPlan(state: BusinessState): Plan {
  return {
    id: "demo-plan",
    createdAt: `${state.asOf}T09:00:00.000Z`,
    decisions,
    summary: "Convert EUR to cover payroll, push back two low-priority bills, and ask you about two payments.",
    resultingForecast: engine.forecast(engine.applyDecisions(state, decisions), 14),
  };
}
