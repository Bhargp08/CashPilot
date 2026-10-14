import type { Agent } from "@/contracts/interfaces";
import { engine } from "@/engine";
import { ClaudeAgent } from "./claude";
import { RulesAgent } from "./rules";

/** Claude agent when ANTHROPIC_API_KEY is set, otherwise the offline rules agent. */
export function createAgent(): Agent {
  return process.env.ANTHROPIC_API_KEY ? new ClaudeAgent(engine) : new RulesAgent(engine);
}

export { ClaudeAgent } from "./claude";
export { RulesAgent, planWithRules } from "./rules";
export { createSimulator, MIN_INFLOW_CONFIDENCE } from "./simulator";
export type { SimulationResult, SimulationRisk, Simulator } from "./simulator";
export { execute } from "./executor";
export type { ExecutionReport, DecisionOutcome } from "./executor";
export { EscalationQueue, escalationQueue } from "./escalations";
export { applyUserNote } from "./note";
