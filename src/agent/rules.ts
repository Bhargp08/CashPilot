import type { Agent, AgentInput, Engine } from "@/contracts/interfaces";
import type { BusinessState, Decision, Forecast, IsoDate, Obligation, Plan } from "@/contracts/types";
import { addDays, describeObligation, money } from "./format";
import { applyUserNote } from "./note";
import { createSimulator, MIN_INFLOW_CONFIDENCE, SIM_HORIZON_DAYS, type SimulationResult } from "./simulator";

export interface PlanIdentity {
  now?: () => Date;
  newId?: () => string;
}

type Fund = Extract<Decision, { action: "fund" }>;
type Defer = Extract<Decision, { action: "defer" }>;
type Escalate = Extract<Decision, { action: "escalate" }>;

/**
 * Deterministic rule-based agent: the offline default and the test oracle. No network.
 * Every fund/defer is simulated (see simulator.ts) against the decisions already made before it is emitted.
 */
export class RulesAgent implements Agent {
  constructor(
    private readonly engine: Engine,
    private readonly identity: PlanIdentity = {},
  ) {}

  async propose(input: AgentInput): Promise<Plan> {
    return planWithRules(this.engine, input, this.identity);
  }
}

export function planWithRules(engine: Engine, input: AgentInput, identity: PlanIdentity = {}): Plan {
  const horizon = Math.max(input.forecast.horizonDays, SIM_HORIZON_DAYS);
  const note = applyUserNote(input.state, input.userNote);
  const state = note.state;
  const forecast = note.adjustments.length > 0 ? engine.forecast(state, horizon) : input.forecast;
  const sim = createSimulator(state, engine, horizon);
  const lastDay = addDays(state.asOf, horizon - 1);
  const inHorizon = state.obligations.filter((o) => (o.dueDate < state.asOf ? state.asOf : o.dueDate) <= lastDay);
  const crunch = forecast.shortfalls.length > 0;

  const decided: Decision[] = [];
  const order = (a: Obligation, b: Obligation) => b.priority - a.priority || a.dueDate.localeCompare(b.dueDate) || a.id.localeCompare(b.id);

  // 1. Flagged items never auto-execute.
  for (const o of inHorizon.filter((x) => x.needsReview).sort(order)) decided.push(escalateReview(o));

  // 2. Must-pay items first: payroll, neverAutoDefer categories, priority 4-5.
  const mustPay = (o: Obligation) => o.category === "payroll" || state.policy.neverAutoDefer.includes(o.category) || o.priority >= 4;
  for (const o of inHorizon.filter((x) => !x.needsReview && mustPay(x)).sort(order)) {
    decided.push(decide(o, ["fund", "defer"]));
  }

  // 3. Everything else. In a crunch, deferrable low-priority items wait so cash stays with what matters.
  for (const o of inHorizon.filter((x) => !x.needsReview && !mustPay(x)).sort(order)) {
    decided.push(decide(o, crunch && canDefer(state, o) ? ["defer", "fund"] : ["fund", "defer"]));
  }

  let decisions = assemble(decided);

  // 4. Belt and braces: anything the engine still rejects goes to a human.
  for (let guard = 0; guard <= state.obligations.length; guard++) {
    const violations = engine.validate(state, decisions);
    if (violations.length === 0) break;
    const offending = decided.filter((d) => d.action !== "escalate" && "obligationId" in d && violations.some((v) => mentions(v, d.obligationId!)));
    const victim =
      offending[0] ??
      [...decided]
        .filter((d): d is Fund | Defer => d.action === "fund" || d.action === "defer")
        .sort((a, b) => priorityOf(state, a.obligationId) - priorityOf(state, b.obligationId))[0];
    if (!victim) break;
    const o = state.obligations.find((x) => x.id === (victim as Fund | Defer).obligationId)!;
    decided[decided.indexOf(victim)] = {
      action: "escalate",
      obligationId: o.id,
      question: `The engine rejected the automatic decision for ${describeObligation(o)}. How should it be handled?`,
      reason: `engine.validate rejected the plan: ${violations.join("; ")}.`,
    };
    decisions = assemble(decided);
  }

  const resultingForecast = engine.forecast(engine.applyDecisions(state, decisions), horizon);
  return {
    id: identity.newId?.() ?? `plan_${crypto.randomUUID().slice(0, 8)}`,
    createdAt: (identity.now?.() ?? new Date()).toISOString(),
    decisions,
    summary: summarize(state, forecast, decisions, resultingForecast, note.adjustments.map((a) => a.description), note.unparsed ? input.userNote : undefined),
    resultingForecast,
  };

  // ---- helpers (closures over state/sim/decided) ----

  function decide(o: Obligation, prefs: ("fund" | "defer")[]): Decision {
    const tried: SimulationResult[] = [];
    for (const pref of prefs) {
      if (pref === "defer" && !canDefer(state, o)) continue;
      const candidate: Fund | Defer =
        pref === "fund"
          ? { action: "fund", obligationId: o.id, reason: "" }
          : { action: "defer", obligationId: o.id, newDate: o.deferrableUntil!, reason: "" };
      const result = sim.simulate(decided, candidate);
      tried.push(result);
      if (result.safe) {
        const fundCheck = pref === "defer" ? (tried.find((t) => t.candidate.action === "fund") ?? sim.simulate(decided, { action: "fund", obligationId: o.id, reason: "" })) : undefined;
        candidate.reason = pref === "fund" ? fundReason(o, result) : deferReason(o, candidate as Defer, result, fundCheck!);
        return candidate;
      }
    }
    return escalateUnsafe(o, tried);
  }

  function fundReason(o: Obligation, r: SimulationResult): string {
    const why =
      o.category === "payroll"
        ? `${o.id} is payroll, which CashPilot always protects`
        : state.policy.neverAutoDefer.includes(o.category)
          ? `${o.id} is ${o.category}, listed in policy.neverAutoDefer`
          : `${o.id} is priority ${o.priority}`;
    const fx = r.conversions.length > 0 ? `, after converting ${r.conversions.map((c) => `${money(c.sellAmount, c.from)} to ${c.to}`).join(" and ")}` : "";
    return (
      `Fund ${describeObligation(o)} on its due date: ${why}. ` +
      `Simulated with the plan so far, the lowest ${lowText(r)}${fx}, which holds policy.reserveFloor ` +
      `${money(state.policy.reserveFloor.amount, state.policy.reserveFloor.currency)} without relying on any inflow below confidence ${MIN_INFLOW_CONFIDENCE}.`
    );
  }

  function deferReason(o: Obligation, d: Defer, r: SimulationResult, fundCheck: SimulationResult): string {
    const why = fundCheck.safe
      ? crunchText()
      : `Paying it on time is unsafe: ${fundCheck.risks.map((x) => x.message).join(" ")}`;
    const covering = state.inflows
      .filter((i) => i.currency === o.currency && i.expectedDate < d.newDate && i.expectedDate >= state.asOf && i.confidence >= MIN_INFLOW_CONFIDENCE)
      .map((i) => `${i.id} (${i.payer}, ${money(i.amount, i.currency)} expected ${i.expectedDate}, confidence ${i.confidence})`);
    const after = covering.length > 0 ? ` The new date falls after ${covering.join(" and ")}.` : "";
    return (
      `Defer ${describeObligation(o)} to ${d.newDate}, its deferrableUntil date; ${o.category} is not in policy.neverAutoDefer. ` +
      `${why}${after} With the deferral the lowest ${lowText(r)}.`
    );
  }

  function crunchText(): string {
    const s = forecast.shortfalls[0];
    if (!s) return "Paying it on time is affordable, but it is low priority.";
    const blocked = s.blockedObligationIds.length > 0 ? ` (blocking ${s.blockedObligationIds.join(", ")})` : "";
    return `The forecast shows a ${s.currency} shortfall of ${money(s.gap, s.currency)} on ${s.date}${blocked}, so low-priority payments wait while cash stays with higher-priority obligations.`;
  }

  function lowText(r: SimulationResult): string {
    return r.lowPoint ? `${r.lowPoint.currency} balance is ${money(r.lowPoint.amount, r.lowPoint.currency)} on ${r.lowPoint.date}` : "balance stays positive";
  }

  function escalateUnsafe(o: Obligation, tried: SimulationResult[]): Escalate {
    const risks = tried.flatMap((t) => t.risks);
    const codes = new Set(risks.map((r) => r.code));
    const floor = money(state.policy.reserveFloor.amount, state.policy.reserveFloor.currency);
    let question: string;
    if (risks.some((r) => r.policyRules.includes("escalateAbove"))) {
      question = `${describeObligation(o)} exceeds policy.escalateAbove (${money(state.policy.escalateAbove.amount, state.policy.escalateAbove.currency)}). Approve paying it?`;
    } else if (codes.has("uncertain_inflow")) {
      const ids = [...new Set(risks.flatMap((r) => r.inflowIds))].join(", ");
      question = `${describeObligation(o)} can only be paid safely if ${ids} arrives on time, which is uncertain. Pay it now and accept the risk, wait for the inflow, or negotiate a later date?`;
    } else if (o.category === "payroll") {
      question = `Payroll ${describeObligation(o)} cannot be fully covered without breaching the ${floor} reserve floor, and payroll is never deferred. Approve dipping into the reserve, or arrange emergency funding?`;
    } else {
      const slip = canDefer(state, o) ? ` or by ${o.deferrableUntil}` : "";
      question = `${describeObligation(o)} cannot be paid on time${slip} without breaching the ${floor} reserve floor. Pay it anyway, negotiate a later date with ${o.payee}, or let it slip?`;
    }
    const detail = risks.map((r) => r.message).join(" ");
    return { action: "escalate", obligationId: o.id, question, reason: `${o.id}: no safe automatic option. ${detail}`.trim() };
  }

  function assemble(list: Decision[]): Decision[] {
    const rest = list.filter((d) => d.action !== "convert");
    const funded = rest.filter((d): d is Fund => d.action === "fund").map((d) => state.obligations.find((o) => o.id === d.obligationId)!);
    const converts = sim.planConversions(rest).map((c) => {
      const needing = funded.filter((o) => o.currency === c.to).map((o) => o.id);
      const acct = state.balances.find((b) => b.currency === c.from);
      const src = acct ? ` ${acct.accountId} holds ${money(acct.available, acct.currency)}.` : "";
      return { ...c, reason: `${c.reason}${needing.length > 0 ? ` Covers funded ${needing.join(", ")}.` : ""}${src}` };
    });
    const rank = { convert: 0, fund: 1, defer: 2, escalate: 3 } as const;
    return [...converts, ...rest].sort((a, b) => rank[a.action] - rank[b.action]);
  }
}

export function canDefer(state: BusinessState, o: Obligation): boolean {
  if (o.category === "payroll" || state.policy.neverAutoDefer.includes(o.category)) return false;
  return !!o.deferrableUntil && o.deferrableUntil > o.dueDate;
}

function escalateReview(o: Obligation): Escalate {
  const note = o.latePenaltyNote ? ` (${o.latePenaltyNote})` : "";
  return {
    action: "escalate",
    obligationId: o.id,
    question: `${describeObligation(o)} is flagged needsReview${note}. Pay it, dispute it, or hold it?`,
    reason: `${o.id} has needsReview set, so policy requires a human decision; CashPilot never auto-funds or auto-defers a flagged obligation.`,
  };
}

function summarize(
  state: BusinessState,
  before: Forecast,
  decisions: Decision[],
  after: Forecast,
  assumptions: string[],
  unparsedNote: string | undefined,
): string {
  const parts: string[] = [];
  if (assumptions.length > 0) parts.push(`What-if applied: ${assumptions.join("; ")}.`);
  if (unparsedNote) parts.push(`The note "${unparsedNote}" did not match a known what-if pattern, so the forecast is unchanged.`);
  const s = before.shortfalls[0];
  parts.push(
    s
      ? `Forecast shows a ${s.currency} shortfall of ${money(s.gap, s.currency)} on ${s.date}${s.blockedObligationIds.length ? ` (blocking ${s.blockedObligationIds.join(", ")})` : ""}.`
      : "Forecast shows no shortfall.",
  );
  const count = (a: Decision["action"]) => decisions.filter((d) => d.action === a);
  const ids = (list: Decision[]) => list.map((d) => ("obligationId" in d && d.obligationId) || "").filter(Boolean).join(", ");
  const conv = count("convert") as Extract<Decision, { action: "convert" }>[];
  if (conv.length) parts.push(`Convert ${conv.map((c) => `${money(c.sellAmount, c.from)} to ${c.to}`).join(", ")}.`);
  if (count("fund").length) parts.push(`Fund ${ids(count("fund"))}.`);
  if (count("defer").length) parts.push(`Defer ${(count("defer") as Defer[]).map((d) => `${d.obligationId} to ${d.newDate}`).join(", ")}.`);
  if (count("escalate").length) parts.push(`Escalate ${ids(count("escalate"))} for a human decision.`);
  const fc = state.policy.reserveFloor.currency;
  const low = after.days.reduce<{ amount: number; date: IsoDate } | null>((m, d) => {
    const b = d.balances[fc] ?? 0;
    return !m || b < m.amount ? { amount: b, date: d.date } : m;
  }, null);
  if (low) parts.push(`After the plan the lowest ${fc} balance is ${money(low.amount, fc)} on ${low.date} (floor ${money(state.policy.reserveFloor.amount, fc)}).`);
  return parts.join(" ");
}

function mentions(message: string, id: string): boolean {
  return new RegExp(`(^|[^\\w])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w]|$)`).test(message);
}

function priorityOf(state: BusinessState, id: string): number {
  return state.obligations.find((o) => o.id === id)?.priority ?? 0;
}

