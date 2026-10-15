import Anthropic from "@anthropic-ai/sdk";
import type { Engine } from "@/contracts/interfaces";
import type { BusinessState, Decision, IsoDate, Obligation, Plan } from "@/contracts/types";
import { engine as defaultEngine, fundingOptions } from "@/engine";
import { addDays, day, money, payment, percent } from "./format";
import { applyUserNote } from "./note";
import { canDefer, explainDecision, isProtected, planWithRules, PLAN_HORIZON_DAYS } from "./rules";
import type { MessagesClient } from "./claude";

/** Same shape as the UI's Proposal (src/app/lib/types.ts). */
export type ChatProposal =
  | { kind: "defer"; obligationId: string; days: number; label: string }
  | { kind: "transfer"; assetId: string; amount: number; by: IsoDate; label: string };

export interface ChatContext {
  state: BusinessState;
  plan?: Plan;
  selected?: { type: string; id: string };
}

export interface ChatAnswer {
  text: string;
  proposal?: ChatProposal;
}

export interface ChatOptions {
  engine?: Engine;
  /** Defaults to the real SDK when ANTHROPIC_API_KEY is set; pass a fake in tests. */
  client?: MessagesClient | null;
  model?: string;
}

/**
 * Answers questions about the plan. The answer and any proposal are always computed by our code from the engine;
 * with an API key, Claude only rewords that answer, using the numbers it is given.
 */
export async function answerQuestion(question: string, ctx: ChatContext, options: ChatOptions = {}): Promise<ChatAnswer> {
  const engine = options.engine ?? defaultEngine;
  const facts = answerWithRules(question, ctx, engine);
  const client = options.client === undefined ? (process.env.ANTHROPIC_API_KEY ? new Anthropic() : null) : options.client;
  if (!client) return facts;
  try {
    const res = await client.messages.create({
      model: options.model ?? process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5",
      max_tokens: 1024,
      system:
        "You are CashPilot, a treasury assistant talking to a small-business owner. Answer in 1-3 plain sentences. " +
        "Use ONLY the amounts, dates, names and conclusions in <facts>; never compute or invent a number. " +
        "If the facts do not answer the question, say what you can answer instead. Do not mention internal ids.",
      messages: [{ role: "user", content: `<question>${question}</question>\n<facts>${JSON.stringify({ answer: facts.text, proposal: facts.proposal?.label ?? null })}</facts>` }],
    });
    const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(" ").trim();
    return text && res.stop_reason !== "refusal" ? { text, proposal: facts.proposal } : facts;
  } catch {
    return facts;
  }
}

export function answerWithRules(question: string, ctx: ChatContext, engine: Engine = defaultEngine): ChatAnswer {
  const { state } = ctx;
  const plan = ctx.plan ?? planWithRules(engine, { state, forecast: engine.forecast(state, PLAN_HORIZON_DAYS) });
  const q = question.toLowerCase();
  const cur = state.policy.reserveFloor.currency;
  const reserve = money(state.policy.reserveFloor.amount, cur);
  const named = findObligation(state, q) ?? (ctx.selected?.type === "payment" ? state.obligations.find((o) => o.id === ctx.selected!.id) : undefined);
  const decisionFor = (o: Obligation) => plan.decisions.find((d) => "obligationId" in d && d.obligationId === o.id);

  if (/what if|\blate\b|\bslip|\bdelay|doesn'?t pay|never pays/.test(q)) return whatIfLate();
  if (/convert|conversion|exchange|\beur\b|\bfx\b/.test(q)) return explainConversion();
  if (/protect/.test(q)) return explainProtected(named ?? state.obligations.find((o) => o.category === "payroll"));
  if (/escalat|waiting for me|needs? (my )?approval|review/.test(q)) {
    const target = named && decisionFor(named)?.action === "escalate" ? named : state.obligations.find((o) => decisionFor(o)?.action === "escalate");
    if (!target) return { text: "Nothing in the plan is waiting for your decision." };
    const d = decisionFor(target) as Extract<Decision, { action: "escalate" }>;
    return { text: `${d.reason} The question for you: ${d.question}` };
  }
  if (named) return explainPayment(named);
  return { text: plan.summary };

  function explainPayment(o: Obligation): ChatAnswer {
    const d = decisionFor(o);
    if (!d) return { text: `${payment(o, state.asOf)} has no special decision: it is paid as scheduled.` };
    return { text: d.reason || explainDecision(engine, state, d, plan.decisions) };
  }

  function explainProtected(o: Obligation | undefined): ChatAnswer {
    if (!o) return { text: `Your rules protect ${state.policy.neverAutoDefer.join(" and ")} payments: they are never moved.` };
    if (!isProtected(state, o)) return { text: `${o.payee} is not protected. Your rules only protect ${state.policy.neverAutoDefer.join(" and ")} payments${o.category === "payroll" ? "" : ", plus payroll, which is never moved"}.` };
    const d = decisionFor(o);
    return { text: `${o.payee} is ${o.category === "payroll" ? "payroll, which CashPilot never moves" : `a ${o.category} payment, and your rules never allow ${o.category} to be moved`}; missing it is costly${o.latePenaltyNote ? ` (${o.latePenaltyNote.replace(/^Protected: /, "").replace(/\.$/, "")})` : ""}. ${d?.reason ?? ""}`.trim() };
  }

  function explainConversion(): ChatAnswer {
    const c = plan.decisions.find((d): d is Extract<Decision, { action: "convert" }> => d.action === "convert");
    if (!c) return { text: `There is no conversion in the plan: your ${cur} account stays above your ${reserve} reserve without one.` };
    const without = lowest(state, plan.decisions.filter((d) => d.action !== "convert" && d.action !== "escalate"));
    const withIt = lowest(state, plan.decisions.filter((d) => d.action !== "escalate"));
    return { text: `${c.reason} Without it your ${cur} account drops to ${money(without.amount, cur)} on ${day(without.date, state.asOf)}; with it the lowest point is ${money(withIt.amount, cur)}.` };
  }

  function whatIfLate(): ChatAnswer {
    const selectedInflow = ctx.selected?.type === "inflow" ? state.inflows.find((i) => i.id === ctx.selected!.id) : undefined;
    const days = Number(q.match(/(\d+)\s*(?:business\s+)?days?/)?.[1] ?? 5);
    const note = selectedInflow ? `${selectedInflow.id} ${days} days late` : question;
    const applied = applyUserNote(state, note);
    if (applied.adjustments.length === 0) return { text: 'Tell me which incoming payment, for example "what if the customer payment is 5 days late?".' };
    const s2 = applied.state;
    const inflow = state.inflows.find((i) => i.id === applied.adjustments[0].inflowId)!;
    const executable = plan.decisions.filter((d) => d.action !== "escalate");
    const before = lowest(state, executable);
    const after = lowest(s2, executable);
    const head = `If ${inflow.payer} (${money(inflow.amount, inflow.currency)}, ${percent(inflow.confidence)} likely, expected ${day(inflow.expectedDate, state.asOf)}) ${applied.adjustments[0].description.replace(inflow.payer + " ", "")}, your lowest ${cur} balance with the plan goes from ${money(before.amount, cur)} to ${money(after.amount, cur)} on ${day(after.date, state.asOf)}.`;
    if (after.amount >= state.policy.reserveFloor.amount) return { text: `${head} That still clears your ${reserve} reserve, so the plan holds.` };
    const fix = cheapestFix(s2, executable, after);
    return { text: `${head} That breaks your ${reserve} reserve.${fix ? ` Cheapest fix: ${fix.label}.` : " I could not find a safe fix from your accounts."}`, proposal: fix ?? undefined };
  }

  function cheapestFix(s2: BusinessState, executable: Decision[], low: { amount: number; date: IsoDate }): ChatProposal | null {
    // 1. Free: push back a payment that is allowed to wait.
    const candidates = s2.obligations
      .filter((o) => o.currency === cur && canDefer(s2, o) && decisionFor(o)?.action !== "escalate")
      .sort((a, b) => a.priority - b.priority || a.dueDate.localeCompare(b.dueDate));
    for (const o of candidates) {
      for (const days of [5, 7, 10]) {
        const newDate = addDays(o.dueDate, days);
        if (newDate > o.deferrableUntil!) continue;
        const trial = [...executable.filter((d) => !("obligationId" in d && d.obligationId === o.id)), { action: "defer", obligationId: o.id, newDate, reason: "" } as Decision];
        if (lowest(s2, trial).amount >= s2.policy.reserveFloor.amount && engine.validate(s2, trial).length === 0) {
          return { kind: "defer", obligationId: o.id, days, label: `move ${o.payee} ${days} days to ${day(newDate, s2.asOf)}` };
        }
      }
    }
    // 2. Otherwise the cheapest transfer in from the owner's other accounts.
    const need = s2.policy.reserveFloor.amount - low.amount;
    const best = fundingOptions(s2, need, low.date).mix[0];
    if (!best) return null;
    return { kind: "transfer", assetId: best.assetId, amount: best.amount, by: low.date, label: `move ${money(best.amount, cur)} from ${best.name} (cost about ${money(best.cost, cur)})` };
  }

  function lowest(st: BusinessState, decisions: Decision[]) {
    const f = engine.forecast(engine.applyDecisions(st, decisions), PLAN_HORIZON_DAYS);
    let low = { amount: Infinity, date: st.asOf };
    for (const d of f.days) if ((d.balances[cur] ?? 0) < low.amount) low = { amount: d.balances[cur] ?? 0, date: d.date };
    return low;
  }
}

const STOP = new Set(["the", "and", "for", "payment", "payments", "stack", "office"]);

function findObligation(state: BusinessState, q: string): Obligation | undefined {
  return state.obligations.find((o) => {
    if (q.includes(o.id)) return true;
    if (new RegExp(`\\b${o.category}`).test(q)) return true;
    return o.payee
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !STOP.has(w))
      .some((w) => new RegExp(`\\b${w}`).test(q));
  });
}
