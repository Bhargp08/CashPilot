import type { BusinessState, Decision, Forecast } from "@/contracts/types";
import type { NoteAdjustment } from "./note";
import { canDefer, deferDate } from "./rules";
import { MIN_INFLOW_CONFIDENCE, type SimulationResult, type Simulator } from "./simulator";

export const SUBMIT_TOOL = "submit_plan";

export const SYSTEM_PROMPT = `You are CashPilot, a treasury controller for a small business facing a short-term cash crunch.
You decide what to do with upcoming payments using exactly four actions:
- fund: pay the obligation on its due date.
- convert: sell one currency for another to close a gap in the currency a payment is due in. Always set executeOn to the day before the money is first needed.
- defer: move an obligation to a later date, after its due date and no later than its deferrableUntil.
- escalate: leave the obligation for the human owner, with a clear question. Escalated items are never executed automatically.

Hard rules:
1. All amounts, dates, balances, currencies, exchange rates, forecasts and simulation results come ONLY from the provided JSON. Never invent or estimate a number. Conversion amounts are recomputed by the deterministic engine after you answer.
2. Protected categories (policy.neverAutoDefer) are never deferred. Payroll is never deferred.
3. Obligations with needsReview: true must be escalated.
4. Keep the reserve-floor currency at or above policy.reserveFloor on every day. Anything above policy.escalateAbove must be escalated.
5. Do not rely on an inflow with confidence below ${MIN_INFLOW_CONFIDENCE} for a low-priority payment (priority 3 or less): if it is only safe because of such an inflow, escalate it. A high-priority payment may rely on it, but its reason must say so.
6. Before recommending a payment, consider its effect on remaining liquidity and upcoming higher-priority obligations. Never sacrifice payroll or required reserves to fund a lower-priority obligation. All amounts, dates, balances, forecasts, and simulation results must come from the provided data.
7. The "simulation" section is the authoritative, deterministic answer to "what happens if we fund or defer this obligation". Use it; do not recompute it. When an option is unsafe, explain why using its risk messages.
8. At most one decision per obligation. An obligation with no decision is paid as scheduled.
9. Prefer the cheapest option (deferring a payment that may wait costs nothing) and escalate when unsure.
10. Every reason is one plain-English sentence for a business owner: name the payee and cite the real figures (amounts, dates, balances) from the data. No ids, no jargon.

Return your plan by calling the ${SUBMIT_TOOL} tool exactly once. Do not answer in plain text.`;

export interface PromptContext {
  state: BusinessState;
  forecast: Forecast;
  sim: Simulator;
  userNote?: string;
  noteAdjustments: NoteAdjustment[];
  referencePlan: Decision[];
}

/** Deterministic per-obligation "what if" results, computed by our code for the model to reason over. */
export function simulationContext(ctx: PromptContext) {
  const { state, sim } = ctx;
  const view = (r: SimulationResult) => ({
    safe: r.safe,
    safeOnlyIfUncertainInflowsArrive: !r.safe && r.safeIfAllInflowsArrive,
    lowestReserveCurrencyBalance: r.lowPoint,
    conversionsNeeded: r.conversions.map(({ from, to, sellAmount, executeOn }) => ({ from, to, sellAmount, executeOn })),
    risks: r.risks.map((x) => x.message),
  });
  return state.obligations.map((o) => ({
    obligationId: o.id,
    payee: o.payee,
    ifFunded: o.needsReview ? { safe: false, risks: [`${o.payee} is marked for review and must be escalated.`] } : view(sim.simulate([], { action: "fund", obligationId: o.id, reason: "" })),
    ifDeferred: canDefer(state, o) ? { newDate: deferDate(state, o), ...view(sim.simulate([], { action: "defer", obligationId: o.id, newDate: deferDate(state, o), reason: "" })) } : null,
  }));
}

export function userMessage(ctx: PromptContext): string {
  const { otherAssets: _omit, ...state } = ctx.state; // savings and investments are not part of this decision
  void _omit;
  const note = ctx.userNote
    ? ctx.noteAdjustments.length > 0
      ? `The user asked: "${ctx.userNote}". The engine has already applied it to the state and forecast below: ${ctx.noteAdjustments.map((a) => a.description).join("; ")}.`
      : `The user asked: "${ctx.userNote}". It is not a what-if the engine can apply, so the numbers below are unchanged. Consider it in your judgment (for example by escalating more), but do not invent numbers for it.`
    : "No user note.";
  return [
    note,
    "",
    "Simulation notes: each ifFunded / ifDeferred result is that single action on its own, with payroll and every higher-priority obligation still scheduled and lower-priority undecided items left out. Inflows below the confidence threshold are not counted.",
    "",
    `<state>${JSON.stringify(state)}</state>`,
    `<forecast>${JSON.stringify(ctx.forecast)}</forecast>`,
    `<simulation>${JSON.stringify(simulationContext(ctx))}</simulation>`,
    "<reference_plan>A deterministic rules engine proposed this plan. It satisfies every rule; improve on it only if you can.",
    JSON.stringify(ctx.referencePlan),
    "</reference_plan>",
  ].join("\n");
}
