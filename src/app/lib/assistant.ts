import type { BusinessState, Decision, Plan } from "@/contracts/types";
import { engine } from "@/engine";
import { addDays } from "@/engine/util";
import { humanize, money, shortDate } from "./format";

export type Effect =
  | { type: "delay"; inflowId: string; days: number }
  | { type: "reset" }
  | { type: "resolve"; obligationId: string; status: "approved" | "rejected" };

export interface Reply {
  text: string;
  tool?: string; // shown as an "action taken" chip
  effect?: Effect;
}

export interface Ctx {
  state: BusinessState; // with any what-if already applied
  baseState: BusinessState;
  plan: Plan;
}

const aliases: Record<string, string[]> = {
  ob_payroll: ["payroll"],
  ob_supplier: ["supplier", "northwind"],
  ob_rent: ["rent", "harbor"],
  ob_saas: ["saas", "cloudsuite", "software"],
  ob_legal: ["legal", "kessler", "lawyer"],
};
const inflowAliases: Record<string, string[]> = {
  in_acme: ["acme", "largest customer", "biggest customer"],
  in_globex: ["globex"],
};

function findKey(text: string, table: Record<string, string[]>) {
  return Object.keys(table).find((k) => table[k].some((a) => text.includes(a)));
}

function decisionFor(plan: Plan, id: string): Decision | undefined {
  return plan.decisions.find((d) => "obligationId" in d && d.obligationId === id);
}

// Swap point: replace with a call to the real agent (POST /api/chat) once feat/agent is merged.
export function respond(input: string, ctx: Ctx): Reply {
  const t = input.toLowerCase();
  const { state, plan } = ctx;
  const ob = (id: string) => state.obligations.find((o) => o.id === id) ?? ctx.baseState.obligations.find((o) => o.id === id);

  const delay = t.match(/(\d+)\s*(day|days|d)\b/);
  const inflowId = findKey(t, inflowAliases);
  if ((t.includes("late") || t.includes("delay") || t.includes("push")) && inflowId && delay) {
    const days = Number(delay[1]);
    const next = structuredClone(ctx.baseState);
    const inflow = next.inflows.find((i) => i.id === inflowId)!;
    inflow.expectedDate = addDays(inflow.expectedDate, days);
    const issues = engine.validate(next, plan.decisions);
    const fc = engine.forecast(engine.applyDecisions(next, plan.decisions), 14);
    const cur = state.policy.reserveFloor.currency;
    const low = fc.days.reduce((a, d) => ((d.balances[cur] ?? 0) < (a.balances[cur] ?? 0) ? d : a));
    return {
      tool: `Re-forecast: ${inflow.payer} ${days} days late`,
      effect: { type: "delay", inflowId, days },
      text: issues.length
        ? `With ${inflow.payer} arriving ${shortDate(inflow.expectedDate)}, the current plan no longer holds: ${humanize(issues[0])}. I would re-plan before anything runs. The chart now shows the new picture.`
        : `With ${inflow.payer} arriving ${shortDate(inflow.expectedDate)}, the plan still works. Your lowest ${cur} balance is ${money(low.balances[cur] ?? 0, cur)} on ${shortDate(low.date)}.`,
    };
  }

  if (/\b(reset|undo|clear|back to normal)\b/.test(t)) {
    return { tool: "Reset what-if", effect: { type: "reset" }, text: "Back to the real schedule." };
  }

  const obId = findKey(t, aliases);
  if (/\b(approve|reject|pay it|hold)\b/.test(t) && obId) {
    const d = decisionFor(plan, obId);
    if (d?.action !== "escalate") return { text: `${ob(obId)?.payee} is not waiting on you. CashPilot handles it automatically.` };
    const status = /reject|hold/.test(t) ? "rejected" : "approved";
    return {
      tool: `${status === "approved" ? "Approved" : "Rejected"}: ${ob(obId)?.payee}`,
      effect: { type: "resolve", obligationId: obId, status },
      text: status === "approved" ? `Approved. ${ob(obId)?.payee} will be paid once the payment step is connected.` : `Rejected. ${ob(obId)?.payee} stays unpaid.`,
    };
  }

  if (t.includes("why") || t.includes("explain")) {
    if (obId) {
      const d = decisionFor(plan, obId);
      if (d) return { text: d.reason };
    }
    if (/convert|eur|currency|fx/.test(t)) {
      const d = plan.decisions.find((x) => x.action === "convert");
      if (d) return { text: d.reason };
    }
    return { text: "Ask about a specific bill, like \"why defer rent?\", and I will show the reasoning." };
  }

  if (/(summary|plan|what.*(do|doing)|status|overview)/.test(t)) {
    return { text: plan.summary };
  }

  return {
    text: "I can re-run the forecast (\"what if Acme pays 5 days late?\"), explain any decision (\"why defer rent?\"), or approve and reject items waiting on you (\"approve Kessler\").",
  };
}
