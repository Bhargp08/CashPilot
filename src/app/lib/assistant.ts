import type { BusinessState, Decision, Plan } from "@/contracts/types";
import { costFor, engine, fundingOptions, neededFunding, transferInflow } from "@/engine";
import { addDays } from "@/engine/util";
import { humanize, money, shortDate } from "./format";

export type Effect =
  | { type: "delay"; inflowId: string; days: number }
  | { type: "reset" }
  | { type: "navigate"; page: "overview" | "assets" | "move"; amount?: number; by?: string }
  | { type: "transfer"; assetId: string; amount: number; by: string }
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
  resolved: Record<string, "approved" | "rejected">;
}

const aliases: Record<string, string[]> = {
  ob_payroll: ["payroll"],
  ob_supplier: ["supplier", "northwind"],
  ob_rent: ["rent", "harbor"],
  ob_saas: ["saas", "cloudsuite", "software"],
  ob_legal: ["legal", "kessler", "lawyer"],
};
const assetAliases: Record<string, string[]> = {
  as_sav: ["savings", "high-yield", "high yield"],
  as_tbill: ["treasur", "t-bill", "tbill", "bills"],
  as_brk: ["brokerage", "investment", "stocks", "index fund"],
  as_roth: ["roth", "ira", "retirement"],
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

  if (/\b(assets?|net worth|how much (money|do i have))\b/.test(t) && !/\b(move|cover|transfer|raise)\b/.test(t)) {
    return { tool: "Opened Assets", effect: { type: "navigate", page: "assets" }, text: "Here is everything you hold, inside and outside the business." };
  }

  if (/\b(move|transfer|cover|raise|fund|pull|take|sell|where.*money|get)\b/.test(t) && /\$|\d|northwind|gap|short|money/.test(t)) {
    const cur = state.policy.reserveFloor.currency;
    const dollars = t.match(/\$?\s?(\d[\d,]*(?:\.\d+)?)\s*(k\b)?/);
    const nw = findKey(t, aliases);
    const ob2 = nw ? state.obligations.find((o) => o.id === nw) ?? ctx.baseState.obligations.find((o) => o.id === nw) : undefined;
    let amount = dollars ? Math.round(Number(dollars[1].replace(/,/g, "")) * (dollars[2] ? 1000 : 1) * 100) : ob2 ? Math.round(ob2.amount * 1) : 0;
    let by = ob2?.dueDate ?? addDays(state.asOf, 3);
    if (!amount) {
      const planned = plan.decisions.filter((d) => !(d.action === "escalate" && d.obligationId && ctx.resolved[d.obligationId] === "approved"));
      const n = neededFunding(state, engine.forecast(engine.applyDecisions(state, planned), 14).days);
      amount = n.need;
      by = n.by;
    }
    if (amount <= 0) return { text: "Nothing needs funding right now. Tell me an amount, like \"cover $9,000 from savings\", and I will model it." };
    const assetId = findKey(t, assetAliases);
    if (assetId) {
      const a = state.otherAssets?.find((x) => x.id === assetId);
      const infl = a && transferInflow(state, assetId, amount);
      if (a && infl) {
        const cost = costFor(a, amount);
        return {
          tool: `Added transfer: ${a.name}`,
          effect: { type: "transfer", assetId, amount, by },
          text: `Added ${money(amount, cur)} from ${a.name} to the plan. It arrives ${shortDate(infl.expectedDate)} and costs ${money(cost, cur)}. It still needs your approval before anything moves.${a.restricted ? " This is retirement money, so I would only use it as a last resort." : ""}`,
        };
      }
    }
    const an = fundingOptions(state, amount, by);
    const mix = an.mix.map((o) => `${money(o.amount, cur)} from ${o.name}`).join(" + ");
    return {
      tool: `Modeled funding for ${money(amount, cur)}`,
      effect: { type: "navigate", page: "move", amount, by },
      text: an.mix.length
        ? `Cheapest way to get ${money(amount, cur)} by ${shortDate(by)}: ${mix}. Total cost ${money(an.mixCost, cur)}.${an.mixCoversNeed ? "" : " That is not enough to cover all of it."} I opened the Move money page so you can compare every option.`
        : "None of your other accounts can cover that in time.",
    };
  }

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
    text: "I can move money (\"cover $9,000 from savings\"), re-run the forecast (\"what if Acme pays 5 days late?\"), explain any decision (\"why defer rent?\"), or approve and reject items waiting on you (\"approve Kessler\").",
  };
}
