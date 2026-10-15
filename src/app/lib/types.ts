import type { Decision, IsoDate, Obligation } from "@/contracts/types";

export type DecisionStatus = "PENDING" | "APPROVED" | "REJECTED";
export type UiAction = "FUND" | "CONVERT" | "DEFER" | "ESCALATE";
export type PaymentStatus = "UPCOMING" | "NEEDS_APPROVAL" | "APPROVED" | "REJECTED" | "DEFERRED";

export interface UiDecision {
  id: string;
  decision: Decision;
  status: DecisionStatus;
  source: "agent" | "user";
}

export interface Completed {
  id: string;
  obligation: Obligation; // snapshot used to restore it on undo
  executedDay: number; // 0 = yesterday, 1 = today
  undone?: boolean;
}

export type UiContext = {
  type: "payment" | "inflow" | "account" | "graphDay" | "decision" | "completed";
  id: string;
  label: string;
};

export type Proposal =
  | { kind: "defer"; obligationId: string; days: number; label: string }
  | { kind: "transfer"; assetId: string; amount: number; by: IsoDate; label: string };

export interface ChatMessage {
  id: string;
  role: "agent" | "user";
  text: string;
  context?: UiContext;
  proposal?: Proposal;
  proposalState?: "open" | "applied" | "dismissed";
}

export type Tab = "payments" | "assets" | "move";

export const ACTION_LABEL: Record<UiAction, string> = { FUND: "FUND", CONVERT: "CONVERT", DEFER: "DEFER", ESCALATE: "ESCALATE" };

export function uiAction(d: Decision): UiAction {
  return d.action.toUpperCase() as UiAction;
}

export function priorityTag(p: number): "Protected" | "High" | "Normal" | "Low" {
  return p >= 5 ? "Protected" : p === 4 ? "High" : p === 3 ? "Normal" : "Low";
}
