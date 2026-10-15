import type { BusinessState, Forecast, Inflow, IsoDate, Obligation } from "@/contracts/types";
import { applyDecisions, forecast, neededFunding, transferInflow } from "@/engine";
import { dayNumber } from "@/scenarios/crunch";
import type { Completed, PaymentStatus, UiDecision } from "./types";

export const HORIZON = 14;

export interface PersistedState {
  base: BusinessState;
  decisions: UiDecision[];
  completed: Completed[];
  notes: Record<string, string>;
  transfers: Record<string, number>;
}

export interface PaymentRow {
  ob: Obligation;
  status: PaymentStatus;
  decision?: UiDecision;
  dueDate: IsoDate; // effective due date (after any deferral)
  note?: string;
}

export interface Derived {
  state: PersistedState;
  noAction: Forecast;
  withPlan: Forecast;
  dates: IsoDate[];
  usdNo: number[];
  usdPlan: number[];
  rows: PaymentRow[];
  inflows: Inflow[];
  pending: UiDecision[];
  summary: { shortfallDay: number | null; shortfallValue: number | null; avoided: number; lowestPlan: number; lowestPlanDay: number };
  combinedUsd: number;
  fx: number;
  need: { need: number; by: IsoDate };
}

export const isActive = (d: UiDecision) => d.status !== "REJECTED";

/** Decisions that change cash. Escalations leave the payment scheduled (it is paid once approved). */
export function cashDecisions(decisions: UiDecision[]) {
  return decisions.filter((d) => isActive(d) && d.decision.action !== "escalate").map((d) => d.decision);
}

export function planState(s: PersistedState): BusinessState {
  const applied = applyDecisions(s.base, cashDecisions(s.decisions));
  const extra = Object.entries(s.transfers).map(([id, amt]) => transferInflow(s.base, id, amt)).filter((i) => i !== null);
  return { ...applied, inflows: [...applied.inflows, ...extra] };
}

export function derive(s: PersistedState): Derived {
  const { base } = s;
  const cur = base.policy.reserveFloor.currency;
  const floor = base.policy.reserveFloor.amount;
  const noAction = forecast(base, HORIZON);
  const withPlan = forecast(planState(s), HORIZON);
  const usdNo = noAction.days.map((d) => d.balances[cur] ?? 0);
  const usdPlan = withPlan.days.map((d) => d.balances[cur] ?? 0);
  const dates = noAction.days.map((d) => d.date);

  const firstBelow = usdNo.findIndex((v) => v < floor);
  const iMin = usdNo.indexOf(Math.min(...usdNo));
  const lowestPlan = Math.min(...usdPlan);

  const rows: PaymentRow[] = base.obligations
    .map((ob) => {
      const decision = s.decisions.find((d) => "obligationId" in d.decision && d.decision.obligationId === ob.id && d.status !== "REJECTED");
      const rejected = s.decisions.find((d) => "obligationId" in d.decision && d.decision.obligationId === ob.id && d.status === "REJECTED");
      let status: PaymentStatus = "UPCOMING";
      let dueDate = ob.dueDate;
      if (decision?.decision.action === "escalate") status = decision.status === "PENDING" ? "NEEDS_APPROVAL" : "APPROVED";
      else if (decision?.decision.action === "defer") {
        status = "DEFERRED";
        dueDate = decision.decision.newDate;
      } else if (decision?.decision.action === "fund") status = "APPROVED";
      else if (rejected) status = "REJECTED";
      return { ob, status, decision, dueDate, note: s.notes[ob.id] };
    })
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  const fx = base.fxRates.find((r) => r.from === "EUR" && r.to === "USD")?.rate ?? 1;
  const bal = (c: string) => base.balances.find((b) => b.currency === c)?.available ?? 0;

  return {
    state: s,
    noAction,
    withPlan,
    dates,
    usdNo,
    usdPlan,
    rows,
    inflows: [...base.inflows].sort((a, b) => a.expectedDate.localeCompare(b.expectedDate)),
    pending: s.decisions.filter((d) => d.status === "PENDING"),
    summary: {
      shortfallDay: firstBelow >= 0 ? dayNumber(dates[firstBelow]) : null,
      shortfallValue: firstBelow >= 0 ? usdNo[firstBelow] : null,
      avoided: Math.max(0, usdPlan[iMin] - usdNo[iMin]),
      lowestPlan,
      lowestPlanDay: dayNumber(dates[usdPlan.indexOf(lowestPlan)]),
    },
    combinedUsd: bal("USD") + Math.round(bal("EUR") * fx),
    fx,
    need: neededFunding(base, forecast(applyDecisions(base, cashDecisions(s.decisions)), HORIZON).days),
  };
}
