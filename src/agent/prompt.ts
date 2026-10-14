import type { BusinessState, Decision, Forecast } from "@/contracts/types";
import { canDefer } from "./rules";
import type { Simulator, SimulationResult } from "./simulator";
import { MIN_INFLOW_CONFIDENCE } from "./simulator";
import type { NoteAdjustment } from "./note";

export const SUBMIT_TOOL = "submit_plan";

export const SYSTEM_PROMPT = `You are CashPilot, a treasury controller for a business facing a short-term cash crunch.
You decide what to do with every upcoming obligation using exactly four actions:
- fund: pay the obligation on its due date.
- convert: sell one currency for another to close a gap in the currency a payment is due in.
- defer: move an obligation to a later date, no later than its deferrableUntil.
- escalate: hand the obligation to a human with a clear question. Escalated items are never executed automatically.

Hard rules:
1. All amounts, dates, balances, exchange rates, forecasts and simulation results must come from the provided JSON. Never invent or estimate a number. Conversion sell amounts are recomputed by the deterministic engine; propose a convert only to say a conversion is needed.
2. Payroll is never deferred. Categories in policy.neverAutoDefer are never deferred.
3. Obligations with needsReview: true must be escalated.
4. Anything that would breach policy.reserveFloor must be deferred (if allowed) or escalated. Anything above policy.escalateAbove must be escalated.
5. Do not rely on an inflow with confidence below ${MIN_INFLOW_CONFIDENCE}. If an action is only safe because of such an inflow, escalate it.
6. Before recommending a payment, consider its effect on remaining liquidity and upcoming higher-priority obligations. Never sacrifice payroll or required reserves to fund a lower-priority obligation. All amounts, dates, balances, forecasts, and simulation results must come from the provided data.
7. The "simulation" section is the authoritative, deterministic answer to "what happens if we fund or defer this obligation". Use it; do not recompute it. When an option is marked unsafe, explain why using its risk messages.
8. Give exactly one decision per obligation that falls inside the forecast horizon.
9. Every reason must be plain English a business owner can verify and must cite the specific obligation id, balance, inflow id or policy rule it rests on.

Return your plan by calling the ${SUBMIT_TOOL} tool exactly once. Do not answer in plain text.`;

export interface PromptContext {
  state: BusinessState;
  forecast: Forecast;
  sim: Simulator;
  userNote?: string;
  noteAdjustments: NoteAdjustment[];
  noteUnparsed: boolean;
  referencePlan: Decision[];
}

/** Deterministic per-obligation "what if" results, computed by our code for the model to reason over. */
export function simulationContext(ctx: PromptContext) {
  const { state, sim } = ctx;
  const view = (r: SimulationResult) => ({
    safe: r.safe,
    safeOnlyIfUncertainInflowsArrive: !r.safe && r.safeIfAllInflowsArrive,
    lowestReserveCurrencyBalance: r.lowPoint,
    conversionsNeeded: r.conversions.map(({ from, to, sellAmount }) => ({ from, to, sellAmount })),
    protects: r.protectedObligationIds,
    risks: r.risks.map(({ code, message }) => ({ code, message })),
  });
  return state.obligations.map((o) => ({
    obligationId: o.id,
    ifFunded: o.needsReview ? { safe: false, risks: [{ code: "policy_violation", message: `${o.id} has needsReview set and must be escalated.` }] } : view(sim.simulate([], { action: "fund", obligationId: o.id, reason: "" })),
    ifDeferredToLatestAllowed: canDefer(state, o) && !o.needsReview ? { newDate: o.deferrableUntil, ...view(sim.simulate([], { action: "defer", obligationId: o.id, newDate: o.deferrableUntil!, reason: "" })) } : null,
  }));
}

export function userMessage(ctx: PromptContext): string {
  const note = ctx.userNote
    ? ctx.noteAdjustments.length > 0
      ? `The user asked: "${ctx.userNote}". The engine has already applied it to the state and forecast below: ${ctx.noteAdjustments.map((a) => a.description).join("; ")}.`
      : `The user asked: "${ctx.userNote}". It did not match a what-if the engine can apply, so the numbers below are unchanged. Take it into account in your judgment (for example by escalating more), but do not invent numbers for it.`
    : "No user note.";
  return [
    note,
    "",
    "Simulation notes: each ifFunded / ifDeferredToLatestAllowed result is that single action taken on its own, with payroll and every higher-priority obligation still scheduled. Lower-priority undecided items are left out. Inflows below the confidence threshold are not counted.",
    "",
    "<state>",
    JSON.stringify(ctx.state),
    "</state>",
    "<forecast>",
    JSON.stringify(ctx.forecast),
    "</forecast>",
    "<simulation>",
    JSON.stringify(simulationContext(ctx)),
    "</simulation>",
    "<reference_plan>",
    "A deterministic rules engine proposed this plan. You may improve on it, but it is known to satisfy every rule.",
    JSON.stringify(ctx.referencePlan),
    "</reference_plan>",
  ].join("\n");
}
