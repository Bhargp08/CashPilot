// SHARED CONTRACT. Owner: Bharg. Each workstream implements or consumes exactly one of these.
import type {
  Balance,
  BusinessState,
  Currency,
  Decision,
  Forecast,
  Plan,
  Policy,
  AuditEntry,
  Obligation,
} from "./types";

// ---- Workstream B (Codex): bank adapter. src/bank/ ----

export interface FxQuote {
  quoteId: string;
  from: Currency;
  to: Currency;
  sellAmount: number; // minor units
  buyAmount: number; // minor units
  rate: number;
  spreadBps: number;
  expiresAt: string; // ISO timestamp
}

export interface ExecutionResult {
  ok: boolean;
  ref?: string; // bank-side id
  error?: string;
}

export interface BankAdapter {
  getBalances(): Promise<Balance[]>;
  quoteFx(from: Currency, to: Currency, sellAmount: number): Promise<FxQuote>;
  convert(quote: FxQuote): Promise<ExecutionResult>;
  /** Pay an obligation now. Idempotent on obligation.id (never pay twice). */
  payObligation(obligation: Obligation): Promise<ExecutionResult>;
  /** Full state snapshot used to seed the engine. Mock adapter returns the seeded scenario. */
  getBusinessState(): Promise<BusinessState>;
}

// ---- Workstream A (Bharg): deterministic engine. src/engine/ ----
// Pure functions. No network, no LLM, no Date.now() (pass asOf in). Fully unit-tested.

export interface Engine {
  forecast(state: BusinessState, horizonDays: number): Forecast;
  /** Apply decisions to the state and return the resulting state (for re-forecasting). */
  applyDecisions(state: BusinessState, decisions: Decision[]): BusinessState;
  /** Returns policy violations for a decision list. Empty array = allowed. */
  validate(state: BusinessState, decisions: Decision[]): string[];
  buildAudit(state: BusinessState, plan: Plan): AuditEntry[];
}

// ---- Workstream C (Jai's Claude Code): agent. src/agent/ ----
// The LLM only proposes decisions. It never produces financial numbers that the engine did not compute,
// and every plan must pass Engine.validate before execution.

export interface AgentInput {
  state: BusinessState;
  forecast: Forecast;
  /** Optional free-text instruction from the user, e.g. "largest customer pays 5 days late". */
  userNote?: string;
}

export interface Agent {
  propose(input: AgentInput): Promise<Plan>;
}

// ---- Policy helper type used by UI forms ----
export type PolicyPatch = Partial<Policy>;
