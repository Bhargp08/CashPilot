import type { BankAdapter, ExecutionResult } from "@/contracts/interfaces";
import type { Decision, Escalation, EscalationStatus, Obligation } from "@/contracts/types";

type EscalateDecision = Extract<Decision, { action: "escalate" }>;

export interface ResolveResult {
  escalation: Escalation;
  /** Present when approving paid an obligation (or the bank refused to). */
  execution?: ExecutionResult;
  error?: string;
}

/**
 * In-memory queue of decisions waiting for a human. Escalations are never executed automatically;
 * approving one pays its obligation exactly once, rejecting one pays nothing.
 */
export class EscalationQueue {
  private items = new Map<string, Escalation>();
  private obligations = new Map<string, Obligation>();
  private inFlight = new Set<string>();

  /** Idempotent on (planId, decisionIndex): re-adding the same escalation returns the existing entry. */
  add(planId: string, decisionIndex: number, decision: EscalateDecision, obligation?: Obligation): Escalation {
    const id = `${planId}:${decisionIndex}`;
    const existing = this.items.get(id);
    if (existing) return structuredClone(existing);
    const escalation: Escalation = { id, planId, decision: structuredClone(decision), status: "pending" };
    this.items.set(id, escalation);
    if (obligation) this.obligations.set(id, structuredClone(obligation));
    return structuredClone(escalation);
  }

  list(status?: EscalationStatus): Escalation[] {
    return [...this.items.values()].filter((e) => !status || e.status === status).map((e) => structuredClone(e));
  }

  get(id: string): Escalation | undefined {
    const e = this.items.get(id);
    return e && structuredClone(e);
  }

  /** The human approves. Pays the escalated obligation (if any) with a single bank.payObligation call. */
  async approve(id: string, bank: BankAdapter, now: () => Date = () => new Date()): Promise<ResolveResult> {
    const e = this.items.get(id);
    if (!e) throw new Error(`Unknown escalation ${id}`);
    if (e.status !== "pending" || this.inFlight.has(id)) {
      return { escalation: structuredClone(e), error: `Escalation ${id} is already ${this.inFlight.has(id) ? "being approved" : e.status}` };
    }
    const obligation = this.obligations.get(id);
    if (!obligation) {
      this.resolve(e, "approved", now);
      return { escalation: structuredClone(e) };
    }
    this.inFlight.add(id);
    try {
      const execution = await bank.payObligation(obligation);
      if (execution.ok) this.resolve(e, "approved", now);
      return { escalation: structuredClone(e), execution, error: execution.ok ? undefined : execution.error };
    } finally {
      this.inFlight.delete(id);
    }
  }

  reject(id: string, now: () => Date = () => new Date()): ResolveResult {
    const e = this.items.get(id);
    if (!e) throw new Error(`Unknown escalation ${id}`);
    if (e.status !== "pending" || this.inFlight.has(id)) return { escalation: structuredClone(e), error: `Escalation ${id} is already ${e.status}` };
    this.resolve(e, "rejected", now);
    return { escalation: structuredClone(e) };
  }

  private resolve(e: Escalation, status: EscalationStatus, now: () => Date) {
    e.status = status;
    e.resolvedAt = now().toISOString();
  }
}

/** Process-wide default queue, shared by the executor and the UI unless a test passes its own. */
export const escalationQueue = new EscalationQueue();
