import type { Agent, AgentInput, Engine } from "@/contracts/interfaces";
import type { BusinessState, Decision, Forecast, Inflow, IsoDate, Obligation, Plan } from "@/contracts/types";
import { addDays, day, effectiveDate, money, payment, percent, rateOf } from "./format";
import { applyUserNote, type NoteAdjustment } from "./note";
import { createSimulator, MIN_INFLOW_CONFIDENCE, plainRule, SIM_HORIZON_DAYS, type Simulator } from "./simulator";

export const PLAN_HORIZON_DAYS = SIM_HORIZON_DAYS;

export interface PlanIdentity {
  now?: () => Date;
  newId?: () => string;
}

type Fund = Extract<Decision, { action: "fund" }>;
type Defer = Extract<Decision, { action: "defer" }>;
type Escalate = Extract<Decision, { action: "escalate" }>;
type Convert = Extract<Decision, { action: "convert" }>;

/**
 * Deterministic rule-based agent: the offline default and the test oracle. No network.
 * Every plan is checked with Engine.validate, and every payment with the what-if simulator, before it is returned.
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

/** The plan's forecast as the UI shows it: escalated payments stay on the schedule until the human decides. */
/** Works in Node 18 and the browser (no global crypto needed). */
export function newPlanId(): string {
  return `plan_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function resultingForecast(engine: Engine, state: BusinessState, decisions: Decision[]): Forecast {
  return engine.forecast(engine.applyDecisions(state, decisions.filter((d) => d.action !== "escalate")), PLAN_HORIZON_DAYS);
}

export function isProtected(state: BusinessState, o: Obligation): boolean {
  return o.category === "payroll" || state.policy.neverAutoDefer.includes(o.category);
}

export function canDefer(state: BusinessState, o: Obligation): boolean {
  return !isProtected(state, o) && !o.needsReview && !!o.deferrableUntil && o.deferrableUntil > o.dueDate;
}

/** About a week later, and after the next reliable inflow in that currency when possible; never past deferrableUntil. */
export function deferDate(state: BusinessState, o: Obligation): IsoDate {
  const due = effectiveDate(o.dueDate, state.asOf);
  const next = state.inflows
    .filter((i) => i.currency === o.currency && i.confidence >= MIN_INFLOW_CONFIDENCE && i.expectedDate > due)
    .map((i) => i.expectedDate)
    .sort()[0];
  let date = addDays(due, 7);
  if (next && addDays(next, 1) > date) date = addDays(next, 1);
  return o.deferrableUntil && date > o.deferrableUntil ? o.deferrableUntil : date;
}

export function planWithRules(engine: Engine, input: AgentInput, identity: PlanIdentity = {}): Plan {
  const note = applyUserNote(input.state, input.userNote);
  const state = note.state;
  const { asOf, policy } = state;
  const floorCur = policy.reserveFloor.currency;
  const sim = createSimulator(state, engine, PLAN_HORIZON_DAYS);
  const baseline = engine.forecast(state, PLAN_HORIZON_DAYS);
  const lastDay = addDays(asOf, PLAN_HORIZON_DAYS - 1);
  const inHorizon = state.obligations
    .filter((o) => effectiveDate(o.dueDate, asOf) <= lastDay)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || b.priority - a.priority || a.id.localeCompare(b.id));
  const crunch = baseline.days.some((d) => (d.balances[floorCur] ?? 0) < policy.reserveFloor.amount);

  const decided = new Map<string, Decision>();
  const escalateWhy = new Map<string, "review" | "limit" | "cash" | "uncertain">();
  let fxBlocked = false;

  // b. Flagged items and anything above the approval limit go to a human.
  for (const o of inHorizon) {
    if (o.needsReview) setEscalate(o, "review");
    else if (overLimit(state, o)) setEscalate(o, "limit");
  }
  // c. Fund high-priority and protected payments, in due-date order.
  for (const o of inHorizon) if (!decided.has(o.id) && (o.priority >= 4 || isProtected(state, o))) decided.set(o.id, fund(o));
  // e. In a crunch, low-priority payments that are allowed to wait, wait.
  if (crunch) for (const o of inHorizon) if (!decided.has(o.id) && o.priority <= 2 && canDefer(state, o)) decided.set(o.id, defer(o, deferDate(state, o)));

  // d + f. Add the minimum conversion, validate, and repair until the engine accepts the plan.
  let decisions = settle();

  // What-if pass: a lower-priority payment that is only safe because an uncertain inflow lands goes to a human.
  let changed = false;
  for (const o of inHorizon) {
    const d = decided.get(o.id);
    if (o.priority > 3 || isProtected(state, o) || (d && d.action !== "fund")) continue;
    const others = decisions.filter((x) => !("obligationId" in x && x.obligationId === o.id));
    const r = sim.simulate(others, fund(o), { mode: "plan" });
    if (r.risks.some((x) => x.code === "uncertain_inflow")) {
      setEscalate(o, "uncertain");
      changed = true;
    }
  }
  if (changed) decisions = settle();

  const plan = resultingForecast(engine, state, decisions);
  const explain = explainer(engine, state, decisions, sim, escalateWhy);
  const withReasons = decisions.map((d) => ({ ...d, reason: explain.reason(d), ...(d.action === "escalate" ? { question: explain.question(d) } : {}) }) as Decision);

  return {
    id: identity.newId?.() ?? newPlanId(),
    createdAt: (identity.now?.() ?? new Date()).toISOString(),
    decisions: withReasons,
    summary: summarize(state, baseline, withReasons, plan, note.adjustments, note.unparsed ? input.userNote : undefined, explain.planWarning()),
    resultingForecast: plan,
  };

  // ---- steps ----

  function settle(): Decision[] {
    let out = assemble();
    for (let guard = 0; guard < 4 * inHorizon.length + 4; guard++) {
      const v = engine.validate(state, out);
      if (v.length === 0) return out;
      if (!repair(v)) break;
      out = assemble();
    }
    // Could not reach a valid plan: hand every remaining floor-currency payment to the human.
    for (const o of inHorizon) if (o.currency === floorCur && decided.get(o.id)?.action !== "escalate") setEscalate(o, "cash");
    fxBlocked = true;
    out = assemble();
    if (engine.validate(state, out).length === 0) return out;
    for (const o of inHorizon) if (decided.get(o.id)?.action !== "escalate") setEscalate(o, "cash");
    return assemble();
  }

  function assemble(): Decision[] {
    const rest = [...decided.values()];
    const converts = fxBlocked ? [] : (sim.planConversions(rest) as Convert[]);
    const rank = { convert: 0, fund: 1, defer: 2, escalate: 3 } as const;
    return [...converts, ...rest].sort((a, b) => rank[a.action] - rank[b.action]);
  }

  /** One repair step. Order: defer another payment that may wait, then escalate the payment causing the breach. */
  function repair(violations: string[]): boolean {
    if (violations.some((v) => v.startsWith("convert") || (v.startsWith("escalateAbove") && v.includes("conversion")))) {
      fxBlocked = true;
      return true;
    }
    const named = inHorizon.filter((o) => violations.some((v) => mentions(v, o.id)) && decided.get(o.id)?.action !== "escalate");
    if (named.length > 0) {
      setEscalate(named[0], "cash");
      return true;
    }
    const waitable = inHorizon
      .filter((o) => canDefer(state, o) && o.currency === floorCur && !["defer", "escalate"].includes(decided.get(o.id)?.action ?? ""))
      .sort((a, b) => a.priority - b.priority || a.dueDate.localeCompare(b.dueDate));
    if (waitable.length > 0) {
      const o = waitable[0];
      decided.set(o.id, defer(o, o.deferrableUntil!));
      return true;
    }
    const breach = violations.map((v) => v.match(/on (\d{4}-\d{2}-\d{2})/)?.[1]).find(Boolean) ?? lastDay;
    const culprit = inHorizon
      .filter((o) => o.currency === floorCur && decided.get(o.id)?.action !== "escalate")
      .filter((o) => {
        const d = decided.get(o.id);
        return (d?.action === "defer" ? d.newDate : effectiveDate(o.dueDate, asOf)) <= breach;
      })
      .sort((a, b) => Number(isProtected(state, a)) - Number(isProtected(state, b)) || a.priority - b.priority || b.amount - a.amount)[0];
    if (!culprit) return false;
    setEscalate(culprit, "cash");
    return true;
  }

  function setEscalate(o: Obligation, why: "review" | "limit" | "cash" | "uncertain") {
    decided.set(o.id, { action: "escalate", obligationId: o.id, question: "", reason: "" });
    escalateWhy.set(o.id, why);
  }
}

function fund(o: Obligation): Fund {
  return { action: "fund", obligationId: o.id, reason: "" };
}

function defer(o: Obligation, newDate: IsoDate): Defer {
  return { action: "defer", obligationId: o.id, newDate, reason: "" };
}

export function overLimit(state: BusinessState, o: Obligation): boolean {
  const limit = state.policy.escalateAbove;
  const r = rateOf(state, o.currency, limit.currency);
  return r !== null && Math.round(o.amount * r) > limit.amount;
}

function mentions(message: string, id: string): boolean {
  return new RegExp(`(^|[^\\w])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w]|$)`).test(message);
}

// ---- explanations: one plain sentence each, payee names and real figures, no ids ----

export interface Explainer {
  reason(d: Decision): string;
  question(d: Escalate): string;
  /** Owner-facing warning when the plan as a whole depends on an uncertain inflow, else "". */
  planWarning(): string;
}

export function explainer(
  engine: Engine,
  state: BusinessState,
  decisions: Decision[],
  sim: Simulator = createSimulator(state, engine, PLAN_HORIZON_DAYS),
  escalateWhy: Map<string, string> = new Map(),
): Explainer {
  const { asOf, policy } = state;
  const floorCur = policy.reserveFloor.currency;
  const reserve = money(policy.reserveFloor.amount, floorCur);
  const plan = resultingForecast(engine, state, decisions);
  const baseline = engine.forecast(state, PLAN_HORIZON_DAYS);
  const ob = (id?: string) => state.obligations.find((o) => o.id === id);
  const balanceOn = (date: IsoDate, cur: string) => plan.days.find((d) => d.date === date)?.balances[cur];
  const reliableLow = sim.reliableLow(decisions.filter((d) => d.action !== "escalate"));
  const exposedFrom = reliableLow && reliableLow.amount < policy.reserveFloor.amount ? reliableLow : null;
  const uncertainBefore = (date: IsoDate) => sim.uncertainInflows.filter((i) => i.expectedDate <= date);
  const inflowText = (i: Inflow) => `the ${money(i.amount, i.currency)} ${i.payer} (${percent(i.confidence)} likely) arriving ${day(i.expectedDate, asOf)}`;

  function warning(o: Obligation): string {
    if (!exposedFrom || o.currency !== floorCur) return "";
    if (effectiveDate(o.dueDate, asOf) < firstUncertainDate()) return "";
    const relied = sim.uncertainInflows.filter((i) => i.currency === floorCur);
    if (relied.length === 0) return "";
    return `, but this counts on ${relied.map(inflowText).join(" and ")}, and without it your ${floorCur} balance would fall to ${money(exposedFrom.amount, floorCur)} on ${day(exposedFrom.date, asOf)}`;
  }

  function firstUncertainDate(): IsoDate {
    return sim.uncertainInflows.map((i) => i.expectedDate).sort()[0] ?? "9999-12-31";
  }

  /** Lowest reserve-currency balance if this one payment were paid on its due date and the rest of the plan stood. Null if that is fine. */
  function ifPaidOnTime(o: Obligation): { amount: number; date: IsoDate } | null {
    const rest = decisions.filter((x) => x.action !== "escalate" && !("obligationId" in x && x.obligationId === o.id));
    const f = engine.forecast(engine.applyDecisions(state, [...rest, fund(o)]), PLAN_HORIZON_DAYS);
    const low = lowOf(f, floorCur);
    return low && low.amount < policy.reserveFloor.amount ? low : null;
  }

  /** Higher-priority payments in the plan that fall between this payment's due date and the low point. */
  function squeezed(o: Obligation, until: IsoDate): Obligation[] {
    const due = effectiveDate(o.dueDate, asOf);
    return state.obligations.filter((x) => {
      if (x.id === o.id || x.currency !== floorCur || (x.priority <= o.priority && x.category !== "payroll")) return false;
      const d = decisions.find((y) => "obligationId" in y && y.obligationId === x.id);
      if (d?.action === "escalate") return false;
      const date = d?.action === "defer" ? d.newDate : effectiveDate(x.dueDate, asOf);
      return date >= due && date <= until;
    });
  }

  function reason(d: Decision): string {
    if (d.action === "convert") return convertReason(d);
    const o = ob(d.obligationId);
    if (!o) return d.reason;
    if (d.action === "fund") {
      const why =
        o.category === "payroll"
          ? "is payroll, which your rules protect, so it is paid on time"
          : policy.neverAutoDefer.includes(o.category)
            ? `is a ${o.category} payment your rules never allow to be moved, so it is paid on time`
            : o.priority >= 4
              ? "is high priority, so it is paid on time"
              : "fits within your cash, so it is paid on time";
      const after = balanceOn(effectiveDate(o.dueDate, asOf), o.currency);
      const bal = after !== undefined ? `; that day your ${o.currency} account ends at ${money(after, o.currency)}${o.currency === floorCur ? `, above your ${reserve} reserve` : ""}` : "";
      return `${payment(o, asOf)} ${why}${bal}${warning(o)}.`;
    }
    if (d.action === "defer") {
      const onTime = ifPaidOnTime(o);
      const crowded = onTime ? squeezed(o, onTime.date) : [];
      const low = lowOf(baseline, floorCur);
      const why = onTime
        ? `paying it on time would take your ${floorCur} account to ${money(onTime.amount, floorCur)} on ${day(onTime.date, asOf)}, below your ${reserve} reserve${crowded.length ? `, leaving too little for ${crowded.map((x) => payment(x, asOf)).join(" and ")}` : ""}`
        : low && low.amount < policy.reserveFloor.amount
          ? `paying everything on schedule would take your ${floorCur} account to ${money(low.amount, floorCur)} on ${day(low.date, asOf)}`
          : "it frees cash during the tightest days";
      const penalty = o.latePenaltyNote ? ` (${lower(o.latePenaltyNote)})` : "";
      return `${o.payee} (${money(o.amount, o.currency)}) moves from ${day(o.dueDate, asOf)} to ${day(d.newDate, asOf)}, inside the latest date it can wait (${day(o.deferrableUntil ?? d.newDate, asOf)}), because ${why}, and it is ${priorityWord(o.priority)} priority${penalty}.`;
    }
    const why = escalateWhy.get(o.id) ?? (o.needsReview ? "review" : "cash");
    if (why === "review") {
      const risky = uncertainBefore(o.dueDate);
      const dep = risky.length > 0 ? `, and ${risky.map(inflowText).join(" and ")} may not land in time` : "";
      const note = o.latePenaltyNote ? ` (${lower(o.latePenaltyNote)})` : "";
      return `${payment(o, asOf)} is marked for your review${note}${dep}, so it waits for your decision.`;
    }
    if (why === "limit") return `${payment(o, asOf)} is above the ${money(policy.escalateAbove.amount, policy.escalateAbove.currency)} your rules allow without your approval, so it waits for your decision.`;
    if (why === "uncertain") {
      const relied = sim.uncertainInflows.filter((i) => i.currency === o.currency);
      const low = exposedFrom ?? sim.reliableLow(decisions.filter((x) => x.action !== "escalate"));
      return `Paying ${payment(o, asOf)} is only safe if ${relied.map(inflowText).join(" and ")} arrives on time${low ? `; without it your ${floorCur} balance would drop to ${money(low.amount, floorCur)} on ${day(low.date, asOf)}` : ""}, so it waits for your decision.`;
    }
    const lp = ifPaidOnTime(o);
    const crowded = lp ? squeezed(o, lp.date) : [];
    const where = lp
      ? `would take your ${floorCur} account to ${money(lp.amount, floorCur)} on ${day(lp.date, asOf)}, below your ${reserve} reserve${crowded.length ? `, leaving too little for ${crowded.map((x) => payment(x, asOf)).join(" and ")}` : ""}`
      : `would break your ${reserve} reserve`;
    const cannot = isProtected(state, o) ? `your rules never allow ${o.category} to be moved` : canDefer(state, o) ? `moving it as late as ${day(o.deferrableUntil!, asOf)} does not fix that` : "it cannot be moved";
    return `Paying ${payment(o, asOf)} ${where}, and ${cannot}, so it waits for your decision.`;
  }

  function question(d: Escalate): string {
    const o = ob(d.obligationId);
    if (!o) return d.question || "How should this be handled?";
    const why = escalateWhy.get(o.id) ?? (o.needsReview ? "review" : "cash");
    if (why === "review") return `Pay ${o.payee} ${money(o.amount, o.currency)} on ${day(o.dueDate, asOf)}?`;
    if (why === "limit") return `Approve paying ${o.payee} ${money(o.amount, o.currency)} on ${day(o.dueDate, asOf)}? It is above your approval limit.`;
    if (why === "uncertain") return `Pay ${o.payee} ${money(o.amount, o.currency)} on ${day(o.dueDate, asOf)}, or wait until the customer payment it depends on has arrived?`;
    if (isProtected(state, o)) return `${o.payee} ${money(o.amount, o.currency)} on ${day(o.dueDate, asOf)} cannot be covered without going below your ${reserve} reserve. Dip into the reserve or move money in from another account?`;
    return `${o.payee} ${money(o.amount, o.currency)} on ${day(o.dueDate, asOf)} cannot be paid without going below your ${reserve} reserve. Pay it anyway, move money in, or agree a later date with ${o.payee}?`;
  }

  function convertReason(c: Convert): string {
    const on = c.executeOn ?? asOf;
    const r = rateOf(state, c.from, c.to) ?? 0;
    const bought = Math.round(c.sellAmount * r);
    const withoutFx = engine.forecast(engine.applyDecisions(state, decisions.filter((d) => d.action !== "convert")), PLAN_HORIZON_DAYS);
    const firstShort = withoutFx.days.find((d) => (d.balances[c.to] ?? 0) < (c.to === floorCur ? policy.reserveFloor.amount : 0));
    const needed = firstShort
      ? state.obligations.filter((o) => o.currency === c.to && effectiveDate(o.dueDate, asOf) === firstShort.date && decisions.some((d) => d.action === "fund" && d.obligationId === o.id))
      : [];
    const forWhat = needed.length > 0 ? `${needed.map((o) => payment(o, asOf)).join(" and ")} can be paid` : `your ${c.to} payments can be paid`;
    const keep = c.to === floorCur ? ` while keeping your ${reserve} reserve` : "";
    const src = state.balances.find((b) => b.currency === c.from);
    const left = src ? src.available - c.sellAmount : null;
    const own = state.obligations.filter((o) => o.currency === c.from && effectiveDate(o.dueDate, asOf) <= addDays(asOf, PLAN_HORIZON_DAYS - 1));
    const covers = left !== null && own.length > 0 ? `; ${money(left, c.from)} stays in ${c.from}, enough for ${own.map((o) => `${o.payee} (${money(o.amount, o.currency)})`).join(" and ")}` : "";
    return `Convert ${money(c.sellAmount, c.from)} to about ${money(bought, c.to)} at ${r} on ${day(on, asOf)} so ${forWhat}${keep}${covers}.`;
  }

  function planWarning(): string {
    if (!exposedFrom) return "";
    const relied = sim.uncertainInflows.filter((i) => i.currency === floorCur);
    if (relied.length === 0) return "";
    return `It counts on ${relied.map((i) => `${i.payer} (${percent(i.confidence)} likely)`).join(" and ")}; without it ${floorCur} would dip to ${money(exposedFrom.amount, floorCur)} on ${day(exposedFrom.date, asOf)}.`;
  }

  return { reason, question, planWarning };
}

function lowOf(f: Forecast, cur: string) {
  let low: { amount: number; date: IsoDate } | null = null;
  for (const d of f.days) {
    const b = d.balances[cur] ?? 0;
    if (!low || b < low.amount) low = { amount: b, date: d.date };
  }
  return low;
}

function priorityWord(p: number): string {
  return p >= 5 ? "protected" : p === 4 ? "high" : p === 3 ? "normal" : "low";
}

function lower(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1).replace(/\.$/, "");
}

function summarize(
  state: BusinessState,
  baseline: Forecast,
  decisions: Decision[],
  plan: Forecast,
  adjustments: NoteAdjustment[],
  unparsedNote: string | undefined,
  warning: string,
): string {
  const cur = state.policy.reserveFloor.currency;
  const reserve = money(state.policy.reserveFloor.amount, cur);
  const before = lowOf(baseline, cur);
  const after = lowOf(plan, cur);
  const assume = adjustments.length > 0 ? `Assuming ${adjustments.map((a) => a.description).join(" and ")}: ` : unparsedNote ? `(I could not turn "${unparsedNote}" into a what-if, so the numbers are unchanged.) ` : "";
  const first =
    before && before.amount < state.policy.reserveFloor.amount
      ? `${assume}paying everything as scheduled takes your ${cur} account to ${money(before.amount, cur)} on ${day(before.date, state.asOf)}, below your ${reserve} reserve.`
      : `${assume}paying everything as scheduled keeps your ${cur} account above your ${reserve} reserve.`;
  const n = (a: Decision["action"]) => decisions.filter((d) => d.action === a).length;
  const conv = decisions.filter((d): d is Convert => d.action === "convert");
  const parts = [
    conv.length ? `converts ${conv.map((c) => money(c.sellAmount, c.from)).join(" and ")}` : "",
    n("fund") ? `pays ${n("fund")} payment${n("fund") === 1 ? "" : "s"} on time` : "",
    n("defer") ? `moves ${n("defer")}` : "",
    n("escalate") ? `leaves ${n("escalate")} for you to decide` : "",
  ].filter(Boolean);
  const second = `This plan ${parts.join(", ") || "changes nothing"}${after ? `, and your ${cur} balance never goes below ${money(after.amount, cur)}` : ""}.`;
  return [capitalize(first), second, warning].filter(Boolean).join(" ");
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** A short owner-facing reason for one decision, using the same rules as the planner. */
export function explainDecision(engine: Engine, state: BusinessState, decision: Decision, plan: Decision[] = [decision]): string {
  const decisions = plan.includes(decision) ? plan : [...plan, decision];
  return explainer(engine, state, decisions).reason(decision);
}

export { plainRule };
