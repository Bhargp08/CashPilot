import type { Engine } from "@/contracts/interfaces";
import type { BusinessState, Currency, Decision, Inflow, IsoDate, Obligation } from "@/contracts/types";
import { addDays, day, effectiveDate, money, payment, percent, rateOf } from "./format";

/**
 * "What if?" simulator. Answers: if we take decision X, what happens to cash?
 * Read-only and deterministic: it only calls the pure Engine (forecast / applyDecisions / validate)
 * on copies of the state. It never touches a bank, never executes anything, and never reads the clock.
 *
 * Forecast = what will probably happen. Simulator = what happens if we take action X.
 * Agent = what we should do. Executor = carries out the approved plan.
 */

/** Inflows below this confidence are not relied on. */
export const MIN_INFLOW_CONFIDENCE = 0.7;
/** Matches the engine's reserve-floor check window and the plan's resultingForecast. */
export const SIM_HORIZON_DAYS = 14;
/** Conversions are rounded up to whole 100 units of the currency sold (minor units). */
export const CONVERSION_STEP = 10_000;

export type ConvertDecision = Extract<Decision, { action: "convert" }>;

export type RiskCode =
  | "negative_balance"
  | "reserve_floor"
  | "payroll_at_risk"
  | "higher_priority_at_risk"
  | "uncertain_inflow"
  | "policy_violation";

export interface SimulationRisk {
  code: RiskCode;
  /** Plain English for the business owner: payee names and real figures, no ids. */
  message: string;
  obligationIds: string[];
  inflowIds: string[];
  policyRules: string[];
}

export interface LowPoint {
  currency: Currency;
  amount: number; // minor units
  date: IsoDate;
}

export interface SimulationResult {
  candidate: Decision;
  /** No risks, without counting any inflow below MIN_INFLOW_CONFIDENCE. */
  safe: boolean;
  /** Would pass if every forecast inflow, however uncertain, arrived on time. */
  safeIfAllInflowsArrive: boolean;
  /** Conversions used: planned by the simulator in "single" mode, taken from the plan in "plan" mode. */
  conversions: ConvertDecision[];
  /** Lowest reserve-currency balance over the horizon, counting only reliable inflows. */
  lowPoint: LowPoint | null;
  /** Plan mode: the candidate is paid after the point where the plan already depends on uncertain inflows. */
  exposedToUncertainInflows: Inflow[];
  /** Obligations the candidate must not crowd out (payroll always, plus anything that outranks it). */
  protectedObligationIds: string[];
  risks: SimulationRisk[];
  /** Raw engine violations in the reliable-inflows world. */
  engineViolations: string[];
}

export interface SimulateOptions {
  /**
   * "single" (default): the candidate on its own, with payroll and higher-priority obligations still scheduled,
   *   lower-priority undecided items left out, and conversions planned to suit.
   * "plan": the candidate inside a whole plan. Every obligation stays scheduled unless a decision moves it,
   *   and the plan's own conversions are used as given.
   */
  mode?: "single" | "plan";
}

export interface Simulator {
  simulate(committed: Decision[], candidate: Decision, options?: SimulateOptions): SimulationResult;
  /** Conversions a set of decisions needs to hold the reserve floor. `reliableOnly` ignores uncertain inflows. */
  planConversions(decisions: Decision[], options?: { reliableOnly?: boolean }): ConvertDecision[];
  /** Lowest reserve-currency balance of a whole plan, counting only reliable inflows. */
  reliableLow(decisions: Decision[]): LowPoint | null;
  uncertainInflows: Inflow[];
}

export function createSimulator(state: BusinessState, engine: Engine, horizonDays = SIM_HORIZON_DAYS): Simulator {
  const horizon = Math.max(horizonDays, SIM_HORIZON_DAYS);
  const byId = new Map(state.obligations.map((o) => [o.id, o]));
  const floorCur = state.policy.reserveFloor.currency;
  const floorAmt = state.policy.reserveFloor.amount;
  const floorOf = (c: string) => (c === floorCur ? floorAmt : 0);
  const uncertain = state.inflows.filter((i) => i.confidence < MIN_INFLOW_CONFIDENCE);
  const reserve = money(floorAmt, floorCur);

  const obligationOf = (d: Decision): Obligation | undefined => ("obligationId" in d && d.obligationId ? byId.get(d.obligationId) : undefined);
  const withoutConverts = (ds: Decision[]) => ds.filter((d) => d.action !== "convert");

  /** Payroll always, plus anything that outranks the candidate. Flagged items are a human's call and are not protected. */
  function protectedFor(candidate: Decision): Obligation[] {
    const subject = obligationOf(candidate);
    return state.obligations.filter((o) => {
      if (o.id === subject?.id || o.needsReview) return false;
      if (o.category === "payroll") return true;
      return subject ? o.priority > subject.priority : false;
    });
  }

  function world(opts: { keep?: (o: Obligation) => boolean; reliableOnly: boolean }): BusinessState {
    return {
      ...state,
      obligations: opts.keep ? state.obligations.filter(opts.keep) : state.obligations,
      inflows: opts.reliableOnly ? state.inflows.filter((i) => i.confidence >= MIN_INFLOW_CONFIDENCE) : state.inflows,
    };
  }

  function lows(st: BusinessState, decisions: Decision[]) {
    const f = engine.forecast(engine.applyDecisions(st, decisions), horizon);
    const low: Record<string, LowPoint> = {};
    const breach: Record<string, IsoDate> = {};
    for (const d of f.days) {
      for (const [cur, amount] of Object.entries(d.balances)) {
        if (!low[cur] || amount < low[cur].amount) low[cur] = { currency: cur as Currency, amount, date: d.date };
        if (amount < floorOf(cur) && !breach[cur]) breach[cur] = d.date;
      }
    }
    return { low, breach };
  }

  /**
   * Smallest conversion, rounded up to whole 100 units of the source, that keeps every currency at or above its floor.
   * Executes the day before the money is first needed. Never sells more than the source can spare after its own
   * scheduled payments (all of them, including ones waiting for a human).
   */
  function conversionsFor(st: BusinessState, nonConvert: Decision[]): ConvertDecision[] {
    const { low, breach } = lows(st, nonConvert);
    const spare: Record<string, number> = {};
    for (const p of Object.values(lows(st, []).low)) spare[p.currency] = Math.max(0, p.amount - floorOf(p.currency));
    const needs = Object.values(low)
      .filter((p) => p.amount < floorOf(p.currency))
      .sort((a, b) => (a.currency === floorCur ? -1 : b.currency === floorCur ? 1 : a.currency.localeCompare(b.currency)));

    const out: ConvertDecision[] = [];
    for (const { currency: to, amount } of needs) {
      let need = floorOf(to) - amount;
      const executeOn = maxDate(state.asOf, addDays(breach[to], -1));
      const sources = (Object.keys(spare) as Currency[]).filter((c) => c !== to && spare[c] > 0).sort((a, b) => spare[b] - spare[a] || a.localeCompare(b));
      for (const from of sources) {
        if (need <= 0) break;
        const r = rateOf(state, from, to);
        if (!r) continue;
        let sell = Math.ceil(Math.ceil(need / r) / CONVERSION_STEP) * CONVERSION_STEP;
        while (Math.round(sell * r) < need) sell += CONVERSION_STEP;
        if (sell > spare[from]) sell = Math.floor(spare[from] / CONVERSION_STEP) * CONVERSION_STEP;
        if (sell <= 0) continue;
        const bought = Math.round(sell * r);
        spare[from] -= sell;
        need -= bought;
        out.push({
          action: "convert",
          from,
          to,
          sellAmount: sell,
          executeOn,
          reason: `Convert ${money(sell, from)} to about ${money(bought, to)} on ${day(executeOn, state.asOf)} so your ${to} account stays at or above ${money(floorOf(to), to)}.`,
        });
      }
    }
    return out;
  }

  function planConversions(decisions: Decision[], options: { reliableOnly?: boolean } = {}): ConvertDecision[] {
    return conversionsFor(world({ reliableOnly: !!options.reliableOnly }), withoutConverts(decisions));
  }

  function reliableLow(decisions: Decision[]): LowPoint | null {
    return lows(world({ reliableOnly: true }), decisions).low[floorCur] ?? null;
  }

  /** Engine verdict for some decisions in a world. Plans conversions unless the decisions bring their own. */
  function check(st: BusinessState, decisions: Decision[], planFx: boolean) {
    const conversions = planFx ? conversionsFor(st, withoutConverts(decisions)) : (decisions.filter((d) => d.action === "convert") as ConvertDecision[]);
    const all = planFx ? [...conversions, ...withoutConverts(decisions)] : decisions;
    const { low, breach } = lows(st, all);
    return { conversions, violations: engine.validate(st, all), low, breach };
  }

  function simulate(committed: Decision[], candidate: Decision, options: SimulateOptions = {}): SimulationResult {
    const planMode = options.mode === "plan";
    const subject = obligationOf(candidate);
    const protect = protectedFor(candidate);
    const decisions = planMode ? [...committed, candidate] : [...withoutConverts(committed), candidate];

    // Which obligations exist in the simulated world.
    const scope = (exclude?: string) => {
      if (planMode) return (o: Obligation) => o.id !== exclude;
      const ids = new Set(protect.map((o) => o.id));
      for (const d of decisions) {
        const o = obligationOf(d);
        if (o) ids.add(o.id);
      }
      return (o: Obligation) => ids.has(o.id) && o.id !== exclude;
    };
    const minus = (ds: Decision[], id?: string) => ds.filter((d) => !(id && "obligationId" in d && d.obligationId === id));

    const prudent = check(world({ keep: scope(), reliableOnly: true }), decisions, !planMode);
    const optimistic = check(world({ keep: scope(), reliableOnly: false }), decisions, !planMode);
    const lowPoint = prudent.low[floorCur] ?? null;
    const verb = describe(candidate, subject);
    const risks: SimulationRisk[] = [];
    let exposed: Inflow[] = [];

    if (candidate.action === "defer" && subject?.category === "payroll") {
      risks.push({
        code: "payroll_at_risk",
        message: `${subject.payee} is payroll, and payroll is never moved, whatever the deferral rules allow.`,
        obligationIds: [subject.id],
        inflowIds: [],
        policyRules: ["neverAutoDefer:payroll"],
      });
    }

    const ruleViolations = prudent.violations.filter((v) => !v.startsWith("reserveFloor"));
    for (const v of ruleViolations) {
      risks.push({ code: "policy_violation", message: `${verb} breaks one of your rules: ${plainRule(v, subject)}.`, obligationIds: subject ? [subject.id] : [], inflowIds: [], policyRules: [v.split(":")[0]] });
    }

    const floorBreached = prudent.violations.some((v) => v.startsWith("reserveFloor"));
    if (floorBreached && ruleViolations.length === 0) {
      if (optimistic.violations.length === 0 && uncertain.length > 0) {
        // Safe only if an uncertain inflow lands. In plan mode, only blame the candidate if it alone tips the plan over.
        const breachDate = prudent.breach[floorCur];
        const alone = planMode && subject ? check(world({ keep: scope(subject.id), reliableOnly: true }), minus(decisions, subject.id), false).violations.length === 0 : true;
        const relied = reliedOn(decisions, scope(), planMode);
        if (alone) {
          risks.push({
            code: "uncertain_inflow",
            message:
              `${verb} is only safe if ${relied.map(inflowText).join(" and ")} arrives on time` +
              `${relied.length === 1 ? ", and it is only " + percent(relied[0].confidence) + " likely" : ""}. ` +
              `Without it, your ${floorCur} balance falls to ${money(lowPoint?.amount ?? 0, floorCur)} on ${day(lowPoint?.date ?? state.asOf, state.asOf)}, below your ${reserve} reserve.`,
            obligationIds: subject ? [subject.id] : [],
            inflowIds: relied.map((i) => i.id),
            policyRules: ["reserveFloor", "inflowConfidence"],
          });
        } else if (subject && breachDate && dateOf(candidate, subject) >= breachDate) {
          exposed = relied;
        }
      } else {
        risks.push(...cashRisks(subject, decisions, scope, minus, planMode, lowPoint, verb));
      }
    }

    return {
      candidate,
      safe: risks.length === 0,
      safeIfAllInflowsArrive: optimistic.violations.length === 0 && !risks.some((r) => r.code === "payroll_at_risk" || r.code === "policy_violation"),
      conversions: prudent.conversions,
      lowPoint,
      exposedToUncertainInflows: exposed,
      protectedObligationIds: protect.map((o) => o.id),
      risks,
      engineViolations: prudent.violations,
    };
  }

  /** Uncertain inflows that, added back one at a time, make the decisions pass. Falls back to all of them. */
  function reliedOn(decisions: Decision[], keep: (o: Obligation) => boolean, planMode: boolean): Inflow[] {
    const base = world({ keep, reliableOnly: true });
    const single = uncertain.filter((inf) => check({ ...base, inflows: [...base.inflows, inf] }, decisions, !planMode).violations.length === 0);
    return single.length > 0 ? single : uncertain;
  }

  function cashRisks(
    subject: Obligation | undefined,
    decisions: Decision[],
    scope: (exclude?: string) => (o: Obligation) => boolean,
    minus: (ds: Decision[], id?: string) => Decision[],
    planMode: boolean,
    lowPoint: LowPoint | null,
    verb: string,
  ): SimulationRisk[] {
    const low = lowPoint ?? { currency: floorCur, amount: 0, date: state.asOf };
    const when = day(low.date, state.asOf);
    const where =
      low.amount < 0
        ? `your ${floorCur} account would go negative (${money(low.amount, floorCur)}) on ${when}`
        : `your ${floorCur} balance would fall to ${money(low.amount, floorCur)} on ${when}, below your ${reserve} reserve`;
    const others = state.balances.map((b) => b.currency).filter((c) => c !== floorCur);
    const fx = !planMode && others.length > 0 ? `, even after converting what your ${[...new Set(others)].join("/")} account can spare` : "";
    const risks: SimulationRisk[] = [
      { code: low.amount < 0 ? "negative_balance" : "reserve_floor", message: `${verb}: ${where}${fx}.`, obligationIds: subject ? [subject.id] : [], inflowIds: [], policyRules: ["reserveFloor"] },
    ];

    // If everything else was fine without the candidate, it is crowding out the protected obligations.
    if (!subject) return risks;
    const without = check(world({ keep: scope(subject.id), reliableOnly: true }), minus(decisions, subject.id), !planMode);
    if (without.violations.length > 0) return risks;
    const escalated = new Set(decisions.filter((d) => d.action === "escalate").map((d) => ("obligationId" in d ? d.obligationId : undefined)));
    const competing = protectedFor({ action: "fund", obligationId: subject.id, reason: "" }).filter(
      (o) => !escalated.has(o.id) && (o.currency === subject.currency || o.currency === floorCur),
    );
    const lowWithout = without.low[floorCur];
    const keep = lowWithout ? ` Without it, your lowest ${floorCur} balance is ${money(lowWithout.amount, floorCur)}.` : "";
    const payroll = competing.filter((o) => o.category === "payroll");
    const higher = competing.filter((o) => o.category !== "payroll");
    if (payroll.length > 0) {
      risks.push({
        code: "payroll_at_risk",
        message: `${verb} would use cash that ${payroll.map((o) => payment(o, state.asOf)).join(" and ")} needs.${keep} Payroll and your reserve come first.`,
        obligationIds: payroll.map((o) => o.id),
        inflowIds: [],
        policyRules: ["reserveFloor", "neverAutoDefer:payroll"],
      });
    }
    if (higher.length > 0) {
      risks.push({
        code: "higher_priority_at_risk",
        message: `${verb} would leave too little for the higher-priority ${higher.map((o) => payment(o, state.asOf)).join(" and ")}.${keep}`,
        obligationIds: higher.map((o) => o.id),
        inflowIds: [],
        policyRules: ["reserveFloor"],
      });
    }
    return risks;
  }

  function inflowText(i: Inflow): string {
    return `the ${money(i.amount, i.currency)} ${i.payer} expected ${day(i.expectedDate, state.asOf)}`;
  }

  function describe(d: Decision, o: Obligation | undefined): string {
    const what = o ? payment(o, state.asOf) : "this";
    switch (d.action) {
      case "fund":
        return `Paying ${what}`;
      case "defer":
        return `Moving ${what} to ${day(d.newDate, state.asOf)}`;
      case "escalate":
        return `Holding ${what} for you`;
      case "convert":
        return `Converting ${money(d.sellAmount, d.from)} to ${d.to}`;
    }
  }

  function dateOf(d: Decision, o: Obligation): IsoDate {
    return d.action === "defer" ? d.newDate : effectiveDate(o.dueDate, state.asOf);
  }

  return { simulate, planConversions, reliableLow, uncertainInflows: uncertain };
}

/** Engine violation strings in owner language. */
export function plainRule(violation: string, o?: Obligation): string {
  const who = o?.payee ?? "this payment";
  if (violation.startsWith("needsReview")) return `${who} is marked for your review, so it is never paid automatically`;
  if (violation.startsWith("escalateAbove")) return `it is above the size your rules allow without your approval`;
  if (violation.startsWith("neverAutoDefer")) return `your rules never allow ${o?.category ?? "this kind of"} payments to be moved`;
  const slip = violation.match(/cannot slip past (\S+)/);
  if (slip) return `${who} can only be pushed to ${slip[1]}`;
  if (/has no deferrableUntil/.test(violation)) return `${who} has no room to be pushed back`;
  if (/newDate must be after/.test(violation)) return `the new date must be after the current due date`;
  if (/more than one decision/.test(violation)) return `${who} was given more than one decision`;
  if (/exceeds available/.test(violation)) return `it sells more than the account holds`;
  if (/unknown obligation/.test(violation)) return `it refers to a payment that is not scheduled`;
  return violation;
}

function maxDate(a: IsoDate, b: IsoDate): IsoDate {
  return a > b ? a : b;
}
