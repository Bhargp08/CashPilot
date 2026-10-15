import type { Currency, Decision, IsoDate } from "@/contracts/types";
import { forecast, fundingOptions } from "@/engine";
import { addDays } from "@/engine/util";
import { derive, HORIZON, planState, type Derived, type PersistedState } from "./derive";
import { dayLabel, money, signed } from "./format";
import { priorityTag, type Proposal, type UiContext } from "./types";

// Simulated, rule-based agent. It only reads numbers produced by the deterministic engine.
// Swap `agent` for a real LLM-backed implementation of the same interface without touching the UI.

export interface AgentReply {
  text: string;
  proposal?: Proposal;
}

export interface Agent {
  opening(d: Derived): string;
  suggestions(d: Derived, ctx: UiContext | null): string[];
  explain(ctx: UiContext, d: Derived): AgentReply;
  answer(question: string, ctx: UiContext | null, d: Derived): AgentReply;
}

const cur = (d: Derived): Currency => d.state.base.policy.reserveFloor.currency;
const floor = (d: Derived) => d.state.base.policy.reserveFloor.amount;
const minUsd = (s: PersistedState) => {
  const c = s.base.policy.reserveFloor.currency;
  const f = forecast(planState(s), HORIZON);
  const vals = f.days.map((x) => x.balances[c] ?? 0);
  const m = Math.min(...vals);
  return { min: m, date: f.days[vals.indexOf(m)].date };
};

function findFix(s: PersistedState): Proposal | null {
  const d = derive(s);
  const { min, date } = minUsd(s);
  if (min >= floor(d)) return null;
  for (const r of d.rows) {
    if (r.status !== "UPCOMING" && r.status !== "APPROVED") continue;
    const ob = r.ob;
    if (!ob.deferrableUntil || s.base.policy.neverAutoDefer.includes(ob.category) || ob.needsReview) continue;
    if (r.decision?.decision.action === "escalate") continue;
    for (const days of [5, 7, 10]) {
      const newDate = addDays(ob.dueDate, days);
      if (newDate > ob.deferrableUntil) continue;
      const trial: PersistedState = structuredClone(s);
      trial.decisions = trial.decisions.filter((x) => !("obligationId" in x.decision && x.decision.obligationId === ob.id));
      trial.decisions.push({ id: "trial", status: "APPROVED", source: "user", decision: { action: "defer", obligationId: ob.id, newDate, reason: "" } });
      if (minUsd(trial).min >= floor(d)) return { kind: "defer", obligationId: ob.id, days, label: `Move ${ob.payee} to ${dayLabel(newDate)}` };
    }
  }
  const need = floor(d) - min;
  const by = addDays(date, 0);
  const mix = fundingOptions(s.base, need, by).mix[0];
  if (mix) return { kind: "transfer", assetId: mix.assetId, amount: mix.amount, by, label: `Move ${money(mix.amount, cur(d))} from ${mix.name}` };
  return null;
}

function obByWord(d: Derived, q: string) {
  const words: [RegExp, (c: string, p: string) => boolean][] = [
    [/payroll|salar|staff/, (c) => c === "payroll"],
    [/supplier|beans|eu\b/, (_c, p) => /supplier|beans/i.test(p) && /eu|beans/i.test(p)],
    [/rent|office/, (c) => c === "rent"],
    [/saas|software|stack/, (c) => c === "software"],
    [/lease|equipment/, (_c, p) => /lease|equipment/i.test(p)],
    [/tax/, (c) => c === "tax"],
  ];
  for (const [re, test] of words) if (re.test(q)) return d.state.base.obligations.find((o) => test(o.category, o.payee));
  return undefined;
}

function explainPayment(id: string, d: Derived): AgentReply {
  const row = d.rows.find((r) => r.ob.id === id);
  if (!row) return { text: "That payment is no longer scheduled." };
  const { ob } = row;
  const dec = row.decision;
  const parts = [`${ob.payee} is ${money(ob.amount, ob.currency)}, due ${dayLabel(ob.dueDate)}. Priority: ${priorityTag(ob.priority)}.`];
  if (d.state.base.policy.neverAutoDefer.includes(ob.category)) parts.push(`Your rules never allow ${ob.category} to be deferred, so it is paid on time.`);
  if (ob.latePenaltyNote) parts.push(ob.latePenaltyNote + ".");
  if (dec) parts.push(`My call: ${dec.decision.action.toUpperCase()}. ${dec.decision.reason}`);
  if (row.status === "NEEDS_APPROVAL") parts.push("It is waiting for your approval.");
  if (row.note) parts.push(row.note + ".");
  return { text: parts.join(" ") };
}

function explainConvert(d: Derived): AgentReply {
  const dec = d.state.decisions.find((x) => x.decision.action === "convert");
  const payroll = d.state.base.obligations.find((o) => o.category === "payroll");
  if (!dec || dec.decision.action !== "convert") return { text: "There is no conversion in the plan right now." };
  const c = dec.decision;
  const i = payroll ? d.dates.indexOf(payroll.dueDate) : -1;
  const got = Math.round(c.sellAmount * d.fx);
  const base = `Convert ${money(c.sellAmount, c.from)} to ${money(got, c.to)} at ${d.fx} on Day 3.`;
  if (i < 0) return { text: base + " " + c.reason };
  return {
    text: `${base} Without it, your ${c.to} account is ${signed(d.usdNo[i], c.to)} after payroll on ${dayLabel(payroll!.dueDate)}. With it, it ends that day at ${signed(d.usdPlan[i], c.to)}, ${d.usdPlan[i] >= floor(d) ? "above" : "below"} your ${money(floor(d), c.to)} reserve.${dec.status === "REJECTED" ? " You rejected this, so the plan line is not using it." : ""}`,
  };
}

function summary(d: Derived): AgentReply {
  const s = d.summary;
  if (s.shortfallDay == null) return { text: `Paying everything as scheduled keeps your ${cur(d)} account above the ${money(floor(d), cur(d))} reserve for the next ${HORIZON} days.` };
  return {
    text: `If you pay everything as scheduled, your ${cur(d)} account drops to ${signed(Math.min(...d.usdNo), cur(d))} (below the ${money(floor(d), cur(d))} reserve from Day ${s.shortfallDay}). With the plan, the lowest point is ${money(s.lowestPlan, cur(d))} on Day ${s.lowestPlanDay}. ${d.pending.length} decision${d.pending.length === 1 ? "" : "s"} still need${d.pending.length === 1 ? "s" : ""} your approval.`,
  };
}

function whatIfInflow(d: Derived, inflowId: string, days: number): AgentReply {
  const inf = d.state.base.inflows.find((i) => i.id === inflowId);
  if (!inf) return { text: "I could not find that payment." };
  const s2: PersistedState = structuredClone(d.state);
  const i2 = s2.base.inflows.find((i) => i.id === inflowId)!;
  i2.expectedDate = addDays(i2.expectedDate, days);
  const { min, date } = minUsd(s2);
  const before = minUsd(d.state);
  const ok = min >= floor(d);
  const head = `If ${inf.payer} (${money(inf.amount, inf.currency)}, expected ${dayLabel(inf.expectedDate)}) arrives ${days} days late, your lowest ${cur(d)} balance with the plan goes from ${money(before.min, cur(d))} to ${signed(min, cur(d))} on ${dayLabel(date)}.`;
  if (ok) return { text: `${head} That still clears your ${money(floor(d), cur(d))} reserve, so the plan holds.` };
  const fix = findFix(s2);
  return {
    text: `${head} That breaks your ${money(floor(d), cur(d))} reserve.${fix ? ` I suggest: ${fix.label}.` : " I could not find a safe fix from your accounts."}`,
    proposal: fix ?? undefined,
  };
}

function whatIfDefer(d: Derived, id: string): AgentReply {
  const ob = d.state.base.obligations.find((o) => o.id === id);
  if (!ob) return { text: "That payment is not scheduled." };
  if (d.state.base.policy.neverAutoDefer.includes(ob.category)) return { text: `${ob.payee} is protected (${ob.category}), so it cannot be moved. Every other lever stays available: converting currency, or moving money from savings.` };
  if (!ob.deferrableUntil) return { text: `${ob.payee} has no room to slip.` };
  const days = 5;
  const newDate = addDays(ob.dueDate, days);
  if (newDate > ob.deferrableUntil) return { text: `${ob.payee} can only slip until ${dayLabel(ob.deferrableUntil)}.` };
  const s2: PersistedState = structuredClone(d.state);
  s2.decisions = s2.decisions.filter((x) => !("obligationId" in x.decision && x.decision.obligationId === id));
  s2.decisions.push({ id: "what-if", status: "APPROVED", source: "user", decision: { action: "defer", obligationId: id, newDate, reason: "" } as Decision });
  const a = minUsd(d.state);
  const b = minUsd(s2);
  return {
    text: `Moving ${ob.payee} ${days} days to ${dayLabel(newDate)} lifts your lowest ${cur(d)} balance from ${money(a.min, cur(d))} to ${money(b.min, cur(d))}.`,
    proposal: { kind: "defer", obligationId: id, days, label: `Move ${ob.payee} to ${dayLabel(newDate)}` },
  };
}

function funding(d: Derived): AgentReply {
  const { need, by } = d.need;
  if (need <= 0) return { text: `Nothing needs funding: the plan keeps ${cur(d)} above your reserve. If you approve every pending item and it changes, ask me again.` };
  const a = fundingOptions(d.state.base, need, by);
  const top = a.mix[0];
  return {
    text: `You are ${money(need, cur(d))} short of your reserve by ${dayLabel(by)}. Cheapest way to cover it: ${a.mix.map((o) => `${money(o.amount, cur(d))} from ${o.name}`).join(" + ")}, total cost ${money(a.mixCost, cur(d))}.`,
    proposal: top ? { kind: "transfer", assetId: top.assetId, amount: top.amount, by, label: `Move ${money(top.amount, cur(d))} from ${top.name}` } : undefined,
  };
}

export const agent: Agent = {
  opening(d) {
    const s = d.summary;
    const total = `You hold ${money(d.combinedUsd, "USD")} combined across USD and EUR.`;
    const risk =
      s.shortfallDay == null
        ? "Paying everything as scheduled keeps you above your reserve."
        : `Paying everything as scheduled puts your USD account at ${signed(Math.min(...d.usdNo), "USD")} (below your ${money(floor(d), "USD")} reserve from Day ${s.shortfallDay}).`;
    const n = d.pending.length;
    return `${total} ${risk} ${n === 0 ? "Nothing is waiting for your approval." : `${n} decision${n === 1 ? " needs" : "s need"} your approval.`}`;
  },

  suggestions(d, ctx) {
    const out: string[] = [];
    if (ctx?.type === "payment") out.push("Explain this", "What if this changes?");
    if (ctx?.type === "inflow") out.push("What if this is 5 days late?");
    if (d.state.decisions.some((x) => x.decision.action === "convert")) out.push("Explain the conversion");
    const esc = d.pending.find((x) => x.decision.action === "escalate");
    if (esc && esc.decision.action === "escalate" && esc.decision.obligationId) {
      const ob = d.state.base.obligations.find((o) => o.id === (esc.decision as { obligationId?: string }).obligationId);
      if (ob) out.push(`Why did you escalate ${ob.payee}?`);
    }
    const protectedRow = d.rows.find((r) => r.ob.priority >= 5);
    if (protectedRow) out.push(`Why is ${protectedRow.ob.payee.toLowerCase()} protected?`);
    const inf = d.inflows.find((i) => i.confidence < 0.8);
    if (inf) out.push(`What if the customer payment is 5 days late?`);
    if (d.need.need > 0) out.push("Where can I move money from?");
    return Array.from(new Set(out)).slice(0, 4);
  },

  explain(ctx, d) {
    switch (ctx.type) {
      case "payment": return explainPayment(ctx.id, d);
      case "completed": {
        const c = d.state.completed.find((x) => x.id === ctx.id);
        return { text: c ? `${c.obligation.payee} (${money(c.obligation.amount, c.obligation.currency)}) was executed ${c.executedDay === 0 ? "yesterday" : "today"}.${c.undone ? " It has been undone and is back in Upcoming." : " You can undo it and it returns to Upcoming, with the balance restored."}` : "That payment is no longer in the list." };
      }
      case "inflow": {
        const inf = d.state.base.inflows.find((i) => i.id === ctx.id);
        if (!inf) return { text: "I could not find that payment." };
        const i = d.dates.indexOf(inf.expectedDate);
        return { text: `${inf.payer} is ${money(inf.amount, inf.currency)}, expected ${dayLabel(inf.expectedDate)} (${Math.round(inf.confidence * 100)}% likely). With the plan it lifts ${inf.currency} from ${i > 0 ? money(d.usdPlan[i - 1], inf.currency) : "—"} to ${money(d.usdPlan[i], inf.currency)} that day.${inf.confidence < 0.8 ? " It may slip, which is why large payments that depend on it are escalated." : ""}` };
      }
      case "account": {
        const b = d.state.base.balances.find((x) => x.accountId === ctx.id);
        return { text: b ? `Your ${b.currency} account holds ${money(b.available, b.currency)} today.${b.currency === "EUR" ? ` At ${d.fx} that is about ${money(Math.round(b.available * d.fx), "USD")}, and it is the money the conversion draws on.` : ` Your reserve floor is ${money(floor(d), b.currency)}.`}` : "I could not find that account." };
      }
      case "graphDay": {
        const dateIso = ctx.id as IsoDate;
        const i = d.dates.indexOf(dateIso);
        if (i < 0) return { text: "That day is outside the forecast." };
        const evs = d.withPlan.days[i].events.map((e) => `${e.kind === "inflow" ? "+" : "−"}${money(Math.abs(e.signedAmount), e.currency)}`).join(", ");
        return { text: `On ${dayLabel(dateIso)}: ${cur(d)} ends at ${money(d.usdPlan[i], cur(d))} with the plan and ${signed(d.usdNo[i], cur(d))} if you pay as scheduled.${evs ? ` Movements that day: ${evs}.` : ""}` };
      }
      case "decision": {
        const x = d.state.decisions.find((y) => y.id === ctx.id);
        return { text: x ? `${x.decision.action.toUpperCase()}: ${x.decision.reason}${x.status === "PENDING" ? " Waiting for your approval." : x.status === "REJECTED" ? " You rejected this." : ""}` : "That decision no longer exists." };
      }
    }
  },

  answer(question, ctx, d) {
    const q = question.toLowerCase();
    if (/what if|late|slip|delay|changes/.test(q)) {
      const days = Number(q.match(/(\d+)\s*day/)?.[1] ?? 5);
      if (ctx?.type === "inflow") return whatIfInflow(d, ctx.id, days);
      if (/customer|wholesale|store|payout|inflow|pays?\b/.test(q)) {
        const id = /store|payout/.test(q) ? "in_store" : (d.inflows.find((i) => i.confidence < 0.8) ?? d.inflows[0])?.id;
        if (id) return whatIfInflow(d, id, days);
      }
      if (ctx?.type === "payment") return whatIfDefer(d, ctx.id);
      return { text: "Tell me which payment, for example \"what if the customer payment is 5 days late?\", or double-click one." };
    }
    if (/convert|conversion|\beur\b/.test(q)) return explainConvert(d);
    if (/move money|savings|raise|cover|roth|invest|where can/.test(q)) return funding(d);
    const ob = obByWord(d, q);
    if (/why|explain|what is|tell me|protected|escalat/.test(q)) {
      if (ctx && /^(explain this|why|tell me)/.test(q.trim())) return agent.explain(ctx, d);
      if (/escalat/.test(q) && !ob) {
        const e = d.state.decisions.find((x) => x.decision.action === "escalate");
        if (e && e.decision.action === "escalate" && e.decision.obligationId) return explainPayment(e.decision.obligationId, d);
      }
      if (ob) return explainPayment(ob.id, d);
      if (ctx) return agent.explain(ctx, d);
    }
    if (/shortfall|lowest|floor|forecast|summary|status|plan/.test(q)) return summary(d);
    if (ob) return explainPayment(ob.id, d);
    if (ctx) return agent.explain(ctx, d);
    return { text: `${summary(d).text} Ask about any payment, the conversion, or a what-if like "what if the customer payment is 5 days late?".` };
  },
};

