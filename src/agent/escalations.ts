import type { BankAdapter, ExecutionResult } from "@/contracts/interfaces";
import type { Decision, Escalation, EscalationStatus } from "@/contracts/types";

type EscalateDecision = Extract<Decision, { action: "escalate" }>;

export interface ResolveResult {
  escalation: Escalation;
  /** Present when approving paid an obligation (or the bank refused to). */
  execution?: ExecutionResult;
  error?: string;
}

/**
 * In-memory queue of decisions waiting for a human. Nothing here runs automatically:
 * approving pays the escalated obligation with exactly one bank.payObligation call; rejecting never touches the bank.
 */
export class EscalationQueue {
  private items = new Map<string, Escalation>();
  private inFlight = new Map<string, Promise<ResolveResult>>();
  private counter = 0;

  /** Idempotent: the same plan and obligation always map to the same escalation. */
  add(planId: string, decision: EscalateDecision): Escalation {
    const id = `${planId}:${decision.obligationId ?? `q${++this.counter}`}`;
    const existing = this.items.get(id);
    if (existing) return structuredClone(existing);
    const escalation: Escalation = { id, planId, decision: structuredClone(decision), status: "pending" };
    this.items.set(id, escalation);
    return structuredClone(escalation);
  }

  list(status?: EscalationStatus): Escalation[] {
    return [...this.items.values()].filter((e) => !status || e.status === status).map((e) => structuredClone(e));
  }

  get(id: string): Escalation | undefined {
    const e = this.items.get(id);
    return e && structuredClone(e);
  }

  /** The human approves. Repeat or concurrent calls share the first call's result and never pay twice. */
  approve(id: string, bank: BankAdapter, now: () => Date = () => new Date()): Promise<ResolveResult> {
    const e = this.items.get(id);
    if (!e) return Promise.reject(new Error(`Unknown escalation ${id}`));
    const running = this.inFlight.get(id);
    if (running) return running.then((r) => ({ ...r, error: r.error ?? `Escalation ${id} is already approved` }));
    if (e.status !== "pending") return Promise.resolve({ escalation: structuredClone(e), error: `Escalation ${id} is already ${e.status}` });

    const run = (async (): Promise<ResolveResult> => {
      const obligationId = e.decision.obligationId;
      if (!obligationId) {
        this.resolve(e, "approved", now);
        return { escalation: structuredClone(e) };
      }
      const state = await bank.getBusinessState();
      const obligation = state.obligations.find((o) => o.id === obligationId);
      if (!obligation) return { escalation: structuredClone(e), error: `Payment ${obligationId} is no longer scheduled` };
      const execution = await bank.payObligation(obligation);
      if (execution.ok) this.resolve(e, "approved", now);
      return { escalation: structuredClone(e), execution, error: execution.ok ? undefined : execution.error };
    })();
    this.inFlight.set(id, run);
    // Once it settles, a failed payment can be retried; a successful one stays approved.
    void run.finally(() => {
      if (this.items.get(id)?.status !== "approved") this.inFlight.delete(id);
    });
    return run;
  }

  reject(id: string, now: () => Date = () => new Date()): ResolveResult {
    const e = this.items.get(id);
    if (!e) throw new Error(`Unknown escalation ${id}`);
    if (e.status !== "pending" || this.inFlight.has(id)) return { escalation: structuredClone(e), error: `Escalation ${id} is already ${e.status === "pending" ? "being approved" : e.status}` };
    this.resolve(e, "rejected", now);
    return { escalation: structuredClone(e) };
  }

  private resolve(e: Escalation, status: EscalationStatus, now: () => Date) {
    e.status = status;
    e.resolvedAt = now().toISOString();
  }
}

/** Process-wide default queue, shared by the executor and the UI unless a caller passes its own. */
export const escalationQueue = new EscalationQueue();
