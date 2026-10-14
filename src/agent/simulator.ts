import type { Engine } from "@/contracts/interfaces";
import type { BusinessState, Currency, Decision, IsoDate, Obligation } from "@/contracts/types";
import { describeObligation, money, rateOf } from "./format";

/**
 * "What if?" simulator. Answers: if we take decision X on top of the decisions already made,
 * what happens to cash? Read-only and deterministic: it only calls the pure Engine
 * (forecast / applyDecisions / validate) on copies of the state. It never touches a bank,
 * never executes anything, and never reads the clock.
 */

/** Inflows below this confidence are not relied on: an action that is only safe because of one is escalated. */
export const MIN_INFLOW_CONFIDENCE = 0.7;
/** Matches the engine's reserve-floor check window. */
export const SIM_HORIZON_DAYS = 14;

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
  message: string; // plain English, cites ids, amounts and policy rules
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
  /** True when the action is safe without relying on any inflow below MIN_INFLOW_CONFIDENCE. */
  safe: boolean;
  /** True when the action would pass if every forecast inflow, however uncertain, arrived on time. */
  safeIfAllInflowsArrive: boolean;
  /** Smallest conversions (from the state's own rates) the decisions need to hold the reserve floor. */
  conversions: ConvertDecision[];
  /** Lowest balance of the reserve-floor currency over the horizon, counting only reliable inflows. */
  lowPoint: LowPoint | null;
  /** Obligations that share cash with the candidate and outrank it (payroll always included). */
  protectedObligationIds: string[];
  risks: SimulationRisk[];
  /** Raw engine violations for the prudent (reliable-inflows-only) case. */
  engineViolations: string[];
}

export interface Simulator {
  simulate(committed: Decision[], candidate: Decision): SimulationResult;
  planConversions(committed: Decision[], candidate?: Decision): ConvertDecision[];
}

export function createSimulator(state: BusinessState, engine: Engine, horizonDays = SIM_HORIZON_DAYS): Simulator {
  const horizon = Math.max(horizonDays, SIM_HORIZON_DAYS);
  const byId = new Map(state.obligations.map((o) => [o.id, o]));
  const floorCur = state.policy.reserveFloor.currency;
  const floorOf = (c: string) => (c === floorCur ? state.policy.reserveFloor.amount : 0);
  const uncertain = state.inflows.filter((i) => i.confidence < MIN_INFLOW_CONFIDENCE);

  /** Obligations a candidate must not crowd out: payroll always, plus anything that outranks it. */
  function protectedFor(candidate: Decision): Obligation[] {
    const subject = obligationOf(candidate);
    return state.obligations.filter((o) => {
      if (subject && o.id === subject.id) return false;
      if (o.needsReview) return false;
      if (o.category === "payroll") return true;
      return subject ? o.priority > subject.priority : false;
    });
  }

  function obligationOf(d: Decision): Obligation | undefined {
    return "obligationId" in d && d.obligationId ? byId.get(d.obligationId) : undefined;
  }

  /** The world the simulation runs in: decided obligations plus protected ones; undecided lower-priority items are left out. */
  function scoped(decisions: Decision[], protect: Obligation[], dropUncertain: boolean): BusinessState {
    const ids = new Set(protect.map((o) => o.id));
    for (const d of decisions) {
      const o = obligationOf(d);
      if (o) ids.add(o.id);
    }
    return {
      ...state,
      obligations: state.obligations.filter((o) => ids.has(o.id)),
      inflows: dropUncertain ? state.inflows.filter((i) => i.confidence >= MIN_INFLOW_CONFIDENCE) : state.inflows,
    };
  }

  function minBalances(st: BusinessState, decisions: Decision[]): Record<string, LowPoint> {
    const f = engine.forecast(engine.applyDecisions(st, decisions), horizon);
    const out: Record<string, LowPoint> = {};
    for (const day of f.days) {
      for (const [cur, amount] of Object.entries(day.balances)) {
        if (!out[cur] || amount < out[cur].amount) out[cur] = { currency: cur as Currency, amount, date: day.date };
      }
    }
    return out;
  }

  /** Smallest integer sell amounts that lift every currency to its floor, capped at what other currencies can spare. */
  function conversionsFor(st: BusinessState, nonConvert: Decision[]): ConvertDecision[] {
    const low = minBalances(st, nonConvert);
    const surplus: Record<string, number> = {};
    const needs: [Currency, number][] = [];
    for (const [cur, p] of Object.entries(low)) {
      const room = p.amount - floorOf(cur);
      if (room > 0) surplus[cur] = room;
      else if (room < 0) needs.push([cur as Currency, -room]);
    }
    needs.sort(([a], [b]) => (a === floorCur ? -1 : b === floorCur ? 1 : a.localeCompare(b)));

    const out: ConvertDecision[] = [];
    for (const [to, gap] of needs) {
      let need = gap;
      const sources = Object.keys(surplus)
        .filter((c) => c !== to && surplus[c] > 0)
        .sort((a, b) => surplus[b] - surplus[a] || a.localeCompare(b)) as Currency[];
      for (const from of sources) {
        if (need <= 0) break;
        const r = rateOf(state, from, to);
        if (!r) continue;
        let sell = Math.ceil(need / r);
        while (Math.round(sell * r) < need) sell++;
        sell = Math.min(sell, surplus[from]);
        if (sell <= 0) continue;
        surplus[from] -= sell;
        need -= Math.round(sell * r);
        const bought = Math.round(sell * r);
        out.push({
          action: "convert",
          from,
          to,
          sellAmount: sell,
          reason:
            `Sell ${money(sell, from)} at the indicative ${from}->${to} rate ${round4(r)} for about ${money(bought, to)}, ` +
            `the least needed to keep ${to} at or above ${money(floorOf(to), to)}` +
            (to === floorCur ? " (policy.reserveFloor)" : "") +
            ` through the ${horizon}-day forecast.`,
        });
      }
    }
    return out;
  }

  function planConversions(committed: Decision[], candidate?: Decision): ConvertDecision[] {
    const nonConvert = [...committed, ...(candidate ? [candidate] : [])].filter((d) => d.action !== "convert");
    const protect = candidate ? protectedFor(candidate) : [];
    return conversionsFor(scoped(nonConvert, protect, true), nonConvert);
  }

  /** Engine verdict for a set of non-convert decisions in a given world, with conversions recomputed for that world. */
  function check(st: BusinessState, nonConvert: Decision[]) {
    const conversions = conversionsFor(st, nonConvert);
    const all = [...conversions, ...nonConvert];
    return { conversions, violations: engine.validate(st, all), low: minBalances(st, all) };
  }

  function simulate(committed: Decision[], candidate: Decision): SimulationResult {
    const base = committed.filter((d) => d.action !== "convert");
    const nonConvert = [...base, candidate];
    const protect = protectedFor(candidate);
    const subject = obligationOf(candidate);
    const prudentState = scoped(nonConvert, protect, true);
    const prudent = check(prudentState, nonConvert);
    const optimistic = check(scoped(nonConvert, protect, false), nonConvert);
    const lowPoint = prudent.low[floorCur] ?? null;
    const risks: SimulationRisk[] = [];
    const verb = describeAction(candidate, subject);

    // Payroll is protected beyond whatever the policy lists.
    if (candidate.action === "defer" && subject?.category === "payroll") {
      risks.push({
        code: "payroll_at_risk",
        message: `${subject.id} is payroll; CashPilot never defers payroll, whatever policy.neverAutoDefer says.`,
        obligationIds: [subject.id],
        inflowIds: [],
        policyRules: ["neverAutoDefer:payroll"],
      });
    }

    const ruleViolations = prudent.violations.filter((v) => !v.startsWith("reserveFloor"));
    for (const v of ruleViolations) {
      risks.push({ code: "policy_violation", message: `${verb} breaks a policy rule: ${v}.`, obligationIds: subject ? [subject.id] : [], inflowIds: [], policyRules: [ruleName(v)] });
    }

    const floorBreached = prudent.violations.some((v) => v.startsWith("reserveFloor"));
    if (floorBreached && ruleViolations.length === 0) {
      const optimisticOk = optimistic.violations.length === 0;
      if (optimisticOk && uncertain.length > 0) {
        const relied = reliedOn(nonConvert, protect);
        const list = relied.map((i) => `${i.id} (${i.payer}, ${money(i.amount, i.currency)} expected ${i.expectedDate})`).join(", ");
        const conf = relied.map((i) => `${i.id} ${i.confidence}`).join(", ");
        risks.push({
          code: "uncertain_inflow",
          message:
            `${verb} is only safe if ${list} arrives, but its confidence is below ${MIN_INFLOW_CONFIDENCE} (${conf}). ` +
            `Without it, ${floorCur} falls to ${money(lowPoint?.amount ?? 0, floorCur)} on ${lowPoint?.date}, ` +
            `below the reserve floor ${money(state.policy.reserveFloor.amount, floorCur)}. Escalating instead of relying on the uncertain inflow.`,
          obligationIds: subject ? [subject.id] : [],
          inflowIds: relied.map((i) => i.id),
          policyRules: ["reserveFloor", "inflowConfidence"],
        });
      } else {
        risks.push(...cashRisks(subject, base, protect, prudentState, lowPoint, verb));
      }
    }

    return {
      candidate,
      safe: risks.length === 0,
      safeIfAllInflowsArrive: optimistic.violations.length === 0 && !risks.some((r) => r.code === "payroll_at_risk"),
      conversions: prudent.conversions,
      lowPoint,
      protectedObligationIds: protect.map((o) => o.id),
      risks,
      engineViolations: prudent.violations,
    };
  }

  /** Which uncertain inflows, added back one at a time, make the plan pass. Falls back to all of them. */
  function reliedOn(nonConvert: Decision[], protect: Obligation[]) {
    const prudentState = scoped(nonConvert, protect, true);
    const single = uncertain.filter((inf) => {
      const st = { ...prudentState, inflows: [...prudentState.inflows, inf] };
      return check(st, nonConvert).violations.length === 0;
    });
    return single.length > 0 ? single : uncertain;
  }

  function cashRisks(
    subject: Obligation | undefined,
    base: Decision[],
    protect: Obligation[],
    prudentState: BusinessState,
    lowPoint: LowPoint | null,
    verb: string,
  ): SimulationRisk[] {
    const floor = state.policy.reserveFloor;
    const low = lowPoint ?? { currency: floor.currency, amount: 0, date: state.asOf };
    const code: RiskCode = low.amount < 0 ? "negative_balance" : "reserve_floor";
    const where =
      low.amount < 0
        ? `${floor.currency} would go negative (${money(low.amount, floor.currency)}) on ${low.date}`
        : `${floor.currency} would fall to ${money(low.amount, floor.currency)} on ${low.date}, below the reserve floor ${money(floor.amount, floor.currency)} (policy.reserveFloor)`;
    const spare = Object.keys(prudentState.balances.reduce<Record<string, true>>((m, b) => ((m[b.currency] = true), m), {}))
      .filter((c) => c !== floor.currency);
    const afterFx = spare.length > 0 ? ` even after converting every spare ${spare.join("/")} balance` : "";
    const risks: SimulationRisk[] = [
      { code, message: `${verb}: ${where}${afterFx}.`, obligationIds: subject ? [subject.id] : [], inflowIds: [], policyRules: ["reserveFloor"] },
    ];

    // Did the candidate cause it? If the plan was fine without it, it is crowding out the protected obligations.
    const withoutCandidate = check(scoped(base, protect, true), base);
    if (withoutCandidate.violations.length === 0) {
      const decidedAway = new Set(
        base.filter((d) => d.action === "escalate" && d.obligationId).map((d) => (d as { obligationId: string }).obligationId),
      );
      const competing = protect.filter((o) => !decidedAway.has(o.id) && (!subject || o.currency === subject.currency || o.currency === floor.currency));
      const payroll = competing.filter((o) => o.category === "payroll");
      const others = competing.filter((o) => o.category !== "payroll");
      const lowWithout = withoutCandidate.low[floor.currency];
      const keep = lowWithout ? ` Without it, the lowest ${floor.currency} balance is ${money(lowWithout.amount, floor.currency)} on ${lowWithout.date}.` : "";
      if (payroll.length > 0) {
        risks.push({
          code: "payroll_at_risk",
          message: `${verb} would use cash that payroll ${payroll.map(describeObligation).join(", ")} needs.${keep} Payroll and the reserve floor come first.`,
          obligationIds: payroll.map((o) => o.id),
          inflowIds: [],
          policyRules: ["reserveFloor", "neverAutoDefer:payroll"],
        });
      }
      if (others.length > 0) {
        risks.push({
          code: "higher_priority_at_risk",
          message: `${verb} would leave too little for higher-priority ${others.map(describeObligation).join(", ")}.${keep}`,
          obligationIds: others.map((o) => o.id),
          inflowIds: [],
          policyRules: ["reserveFloor"],
        });
      }
    }
    return risks;
  }

  return { simulate, planConversions };
}

function describeAction(d: Decision, o: Obligation | undefined): string {
  const what = o ? `${o.id} (${money(o.amount, o.currency)} due ${o.dueDate})` : "this action";
  switch (d.action) {
    case "fund":
      return `Funding ${what}`;
    case "defer":
      return `Deferring ${what} to ${d.newDate}`;
    case "escalate":
      return `Escalating ${what}`;
    case "convert":
      return `Converting ${money(d.sellAmount, d.from)} to ${d.to}`;
  }
}

function ruleName(violation: string): string {
  return violation.split(":")[0] + (violation.startsWith("neverAutoDefer:") ? `:${violation.split(":")[1]}` : "");
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
