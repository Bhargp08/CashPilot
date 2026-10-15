import type { BankAdapter, Engine } from "@/contracts/interfaces";
import type { AuditEntry, BusinessState, Decision, IsoDate, Plan } from "@/contracts/types";
import { engine as defaultEngine } from "@/engine";
import { escalationQueue, type EscalationQueue } from "./escalations";

export type ItemStatus =
  | "executed" // the bank call succeeded
  | "scheduled" // dated in the future; not sent to the bank yet
  | "recorded" // defer: noted, no bank call
  | "awaiting_human" // escalated: queued, never executed
  | "rejected_spread" // FX quote worse than policy.maxFxSpreadBps
  | "failed" // the bank returned an error
  | "skipped"; // not attempted because a conversion it depends on did not happen

export interface ExecutionItem {
  index: number;
  decision: Decision;
  status: ItemStatus;
  ref?: string;
  error?: string;
}

export interface ExecutionReport {
  planId: string;
  /** False when validation failed and nothing was sent to the bank. */
  executed: boolean;
  violations: string[];
  items: ExecutionItem[];
  audit: AuditEntry[];
}

export interface ExecuteOptions {
  /** Today's date for deciding what is due. Defaults to the bank state's asOf. */
  now?: IsoDate;
  /** Send everything now, including items dated in the future. */
  executeAll?: boolean;
  queue?: EscalationQueue;
  engine?: Engine;
}

interface Ledger {
  /** Items that reached a final state (executed, recorded, awaiting_human) are never run again. */
  done: Map<number, ExecutionItem>;
  /** The bank state the plan was validated against on its first run. */
  state: BusinessState;
}

// Per bank, per plan. Calls for the same plan are chained so concurrent executes cannot both pay.
const ledgers = new WeakMap<BankAdapter, Map<string, Ledger>>();
const locks = new WeakMap<BankAdapter, Map<string, Promise<unknown>>>();

export async function execute(plan: Plan, bank: BankAdapter, opts: ExecuteOptions = {}): Promise<ExecutionReport> {
  const planLocks = locks.get(bank) ?? new Map<string, Promise<unknown>>();
  locks.set(bank, planLocks);
  const prev = planLocks.get(plan.id) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(() => runPlan(plan, bank, opts));
  planLocks.set(plan.id, run);
  return run;
}

async function runPlan(plan: Plan, bank: BankAdapter, opts: ExecuteOptions): Promise<ExecutionReport> {
  const engine = opts.engine ?? defaultEngine;
  const queue = opts.queue ?? escalationQueue;
  const byPlan = ledgers.get(bank) ?? new Map<string, Ledger>();
  ledgers.set(bank, byPlan);

  let ledger = byPlan.get(plan.id);
  if (!ledger) {
    // First run: validate against the bank's current state. On violations nothing is executed.
    const state = await bank.getBusinessState();
    const violations = engine.validate(state, plan.decisions);
    if (violations.length > 0) return { planId: plan.id, executed: false, violations, items: [], audit: engine.buildAudit(state, plan) };
    ledger = { done: new Map(), state };
    byPlan.set(plan.id, ledger);
  }
  const { state } = ledger;
  const now = opts.now ?? state.asOf;
  const due = (date: IsoDate) => opts.executeAll || date <= now;
  const items: ExecutionItem[] = [];
  let fxProblem = false;

  // Conversions first: the payments rely on the converted cash.
  const order = plan.decisions.map((decision, index) => ({ decision, index }));
  order.sort((a, b) => Number(b.decision.action === "convert") - Number(a.decision.action === "convert") || a.index - b.index);

  for (const { decision: d, index } of order) {
    const prior = ledger.done.get(index);
    if (prior) {
      items.push(prior);
      continue;
    }
    const item = await runOne(d, index);
    if (item.status === "executed" || item.status === "recorded" || item.status === "awaiting_human") ledger.done.set(index, item);
    items.push(item);
  }

  items.sort((a, b) => a.index - b.index);
  const byIndex = new Map(items.map((i) => [i.index, i]));
  return {
    planId: plan.id,
    executed: true,
    violations: [],
    items,
    audit: engine.buildAudit(state, plan).map((a) => {
      const i = byIndex.get(a.decisionIndex);
      return { ...a, executed: i?.status === "executed", executionRef: i?.status === "executed" ? i.ref : undefined };
    }),
  };

  async function runOne(d: Decision, index: number): Promise<ExecutionItem> {
    if (d.action === "convert") {
      if (!due(d.executeOn ?? state.asOf)) return { index, decision: d, status: "scheduled" };
      const quote = await bank.quoteFx(d.from, d.to, d.sellAmount);
      if (quote.spreadBps > state.policy.maxFxSpreadBps) {
        fxProblem = true;
        return { index, decision: d, status: "rejected_spread", error: `Quote spread ${quote.spreadBps} bps is above your limit of ${state.policy.maxFxSpreadBps} bps` };
      }
      if (quote.sellAmount !== d.sellAmount || quote.from !== d.from || quote.to !== d.to) {
        fxProblem = true;
        return { index, decision: d, status: "failed", error: "The bank's quote does not match the planned conversion" };
      }
      const r = await bank.convert(quote);
      if (!r.ok) fxProblem = true;
      return { index, decision: d, status: r.ok ? "executed" : "failed", ref: r.ref, error: r.error };
    }
    if (d.action === "fund") {
      const o = state.obligations.find((x) => x.id === d.obligationId);
      if (!o) return { index, decision: d, status: "failed", error: "Payment is no longer scheduled" };
      if (!due(o.dueDate)) return { index, decision: d, status: "scheduled" };
      if (fxProblem) return { index, decision: d, status: "skipped", error: "A planned conversion did not go through; re-plan before paying" };
      const r = await bank.payObligation(o);
      return { index, decision: d, status: r.ok ? "executed" : "failed", ref: r.ref, error: r.error };
    }
    if (d.action === "defer") return { index, decision: d, status: "recorded" };
    queue.add(plan.id, d);
    return { index, decision: d, status: "awaiting_human" };
  }
}
