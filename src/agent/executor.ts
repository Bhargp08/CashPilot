import type { BankAdapter, Engine } from "@/contracts/interfaces";
import type { AuditEntry, Decision, Escalation, Plan } from "@/contracts/types";
import { escalationQueue, type EscalationQueue } from "./escalations";

export type DecisionStatus =
  | "executed" // bank call succeeded
  | "recorded" // defer: noted, nothing sent to the bank
  | "escalated" // queued for a human, never executed
  | "rejected" // refused by a safety check (e.g. FX spread)
  | "failed" // the bank returned an error
  | "skipped"; // not attempted because an earlier step failed

export interface DecisionOutcome {
  index: number;
  decision: Decision;
  status: DecisionStatus;
  ref?: string;
  error?: string;
}

export interface ExecutionReport {
  planId: string;
  ok: boolean;
  /** Engine violations found before execution. Non-empty means nothing was executed. */
  violations: string[];
  outcomes: DecisionOutcome[];
  audit: AuditEntry[];
  escalations: Escalation[];
  /** True when this plan was already executed against this bank and the earlier report is returned. */
  replayed: boolean;
}

export interface ExecuteOptions {
  queue?: EscalationQueue;
}

// Plans already executed per bank, so running the same plan twice never moves money twice
// (conversions are not idempotent at the bank; payments are, but we do not lean on that alone).
// The promise is stored before any bank call, so concurrent calls for the same plan also replay.
const executed = new WeakMap<BankAdapter, Map<string, Promise<ExecutionReport>>>();

export async function execute(plan: Plan, bank: BankAdapter, engine: Engine, options: ExecuteOptions = {}): Promise<ExecutionReport> {
  const ledger = executed.get(bank) ?? new Map<string, Promise<ExecutionReport>>();
  executed.set(bank, ledger);
  const prior = ledger.get(plan.id);
  if (prior) return { ...structuredClone(await prior), replayed: true };

  const run = runPlan(plan, bank, engine, options.queue ?? escalationQueue);
  ledger.set(plan.id, run);
  const report = await run.catch((e) => {
    ledger.delete(plan.id);
    throw e;
  });
  // A plan that failed validation moved no money; allow it to be retried after a re-plan.
  if (report.violations.length > 0) ledger.delete(plan.id);
  return structuredClone(report);
}

async function runPlan(plan: Plan, bank: BankAdapter, engine: Engine, queue: EscalationQueue): Promise<ExecutionReport> {
  const state = await bank.getBusinessState();
  const violations = engine.validate(state, plan.decisions);
  const audit = engine.buildAudit(state, plan);
  if (violations.length > 0) {
    return {
      planId: plan.id,
      ok: false,
      violations,
      outcomes: plan.decisions.map((decision, index) => ({ index, decision, status: "skipped", error: "plan failed validation" })),
      audit,
      escalations: [],
      replayed: false,
    };
  }

  const outcomes: DecisionOutcome[] = [];
  const escalations: Escalation[] = [];
  let fxFailed = false;
  const order = plan.decisions.map((decision, index) => ({ decision, index }));
  // Conversions first: the funding decisions rely on the converted cash.
  order.sort((a, b) => Number(b.decision.action === "convert") - Number(a.decision.action === "convert") || a.index - b.index);

  for (const { decision: d, index } of order) {
    if (d.action === "convert") {
      const quote = await bank.quoteFx(d.from, d.to, d.sellAmount);
      if (quote.spreadBps > state.policy.maxFxSpreadBps) {
        fxFailed = true;
        outcomes.push({ index, decision: d, status: "rejected", error: `quote ${quote.quoteId} spread ${quote.spreadBps} bps exceeds policy.maxFxSpreadBps ${state.policy.maxFxSpreadBps}` });
        continue;
      }
      if (quote.sellAmount !== d.sellAmount || quote.from !== d.from || quote.to !== d.to) {
        fxFailed = true;
        outcomes.push({ index, decision: d, status: "rejected", error: `quote ${quote.quoteId} does not match the planned conversion` });
        continue;
      }
      const r = await bank.convert(quote);
      if (!r.ok) fxFailed = true;
      outcomes.push({ index, decision: d, status: r.ok ? "executed" : "failed", ref: r.ref, error: r.error });
    } else if (d.action === "fund") {
      if (fxFailed) {
        outcomes.push({ index, decision: d, status: "skipped", error: "a planned conversion did not execute; re-plan before paying" });
        continue;
      }
      const o = state.obligations.find((x) => x.id === d.obligationId)!;
      const r = await bank.payObligation(o);
      outcomes.push({ index, decision: d, status: r.ok ? "executed" : "failed", ref: r.ref, error: r.error });
    } else if (d.action === "defer") {
      outcomes.push({ index, decision: d, status: "recorded" });
    } else {
      const o = d.obligationId ? state.obligations.find((x) => x.id === d.obligationId) : undefined;
      escalations.push(queue.add(plan.id, index, d, o));
      outcomes.push({ index, decision: d, status: "escalated" });
    }
  }

  outcomes.sort((a, b) => a.index - b.index);
  const byIndex = new Map(outcomes.map((o) => [o.index, o]));
  const report: ExecutionReport = {
    planId: plan.id,
    ok: outcomes.every((o) => o.status !== "failed" && o.status !== "rejected" && o.status !== "skipped"),
    violations: [],
    outcomes,
    audit: audit.map((a) => {
      const o = byIndex.get(a.decisionIndex);
      return { ...a, executed: o?.status === "executed", executionRef: o?.status === "executed" ? o.ref : undefined };
    }),
    escalations,
    replayed: false,
  };
  return report;
}
