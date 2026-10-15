import type { Agent } from "@/contracts/interfaces";
import type { BusinessState, Decision } from "@/contracts/types";
import { engine } from "@/engine";
import { ClaudeAgent } from "./claude";
import { explainDecision as explainWith, RulesAgent } from "./rules";

/** Claude agent when ANTHROPIC_API_KEY is set, otherwise the offline rules agent. */
export function createAgent(): Agent {
  return process.env.ANTHROPIC_API_KEY ? new ClaudeAgent(engine) : new RulesAgent(engine);
}

/** A short owner-facing reason for one decision, using the rules agent's wording. Pass the whole plan for context. */
export function explainDecision(state: BusinessState, decision: Decision, plan?: Decision[]): string {
  return explainWith(engine, state, decision, plan);
}

export type { Agent, AgentInput } from "@/contracts/interfaces";
export type { Decision, Plan, Escalation } from "@/contracts/types";
export { ClaudeAgent, DEFAULT_MODEL } from "./claude";
export type { ClaudeAgentOptions, MessagesClient } from "./claude";
export { RulesAgent, planWithRules, resultingForecast, PLAN_HORIZON_DAYS } from "./rules";
export { createSimulator, MIN_INFLOW_CONFIDENCE, CONVERSION_STEP } from "./simulator";
export type { SimulationResult, SimulationRisk, Simulator, RiskCode } from "./simulator";
export { execute } from "./executor";
export type { ExecutionReport, ExecutionItem, ItemStatus, ExecuteOptions } from "./executor";
export { EscalationQueue, escalationQueue } from "./escalations";
export { answerQuestion, answerWithRules } from "./chat";
export type { ChatAnswer, ChatContext, ChatProposal } from "./chat";
export { applyUserNote } from "./note";
