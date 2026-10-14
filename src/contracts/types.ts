// SHARED CONTRACT. Owner: Bharg. Change only via PR to main; all workstreams depend on this file.
// Money is always integer minor units (cents) to avoid float errors. Dates are "YYYY-MM-DD" (UTC).

export type Currency = "USD" | "EUR" | "GBP" | "AUD" | "SGD";
export type IsoDate = string;

export interface Money {
  amount: number; // minor units, e.g. 1250 = 12.50
  currency: Currency;
}

export interface Balance {
  accountId: string;
  currency: Currency;
  available: number; // minor units
}

export type ObligationCategory =
  | "payroll"
  | "rent"
  | "tax"
  | "supplier"
  | "software"
  | "other";

export interface Obligation {
  id: string;
  payee: string;
  category: ObligationCategory;
  amount: number; // minor units
  currency: Currency;
  dueDate: IsoDate;
  priority: 1 | 2 | 3 | 4 | 5; // 5 = must not miss, 1 = easily postponed
  latePenaltyNote?: string; // free text shown to the agent and the human
  deferrableUntil?: IsoDate; // latest date it can slip to without consequence
  needsReview?: boolean; // disputed/unverified: must be escalated, never auto-funded
}

export interface Inflow {
  id: string;
  payer: string;
  amount: number; // minor units
  currency: Currency;
  expectedDate: IsoDate;
  confidence: number; // 0..1, how sure we are it lands on expectedDate
}

export interface Policy {
  reserveFloor: Money; // balance (in this currency) never to dip below
  neverAutoDefer: ObligationCategory[]; // e.g. ["payroll","tax"]
  escalateAbove: Money; // any single action larger than this needs a human
  maxFxSpreadBps: number; // refuse conversions with worse spread than this
}

export interface BusinessState {
  asOf: IsoDate;
  baseCurrency: Currency;
  balances: Balance[];
  obligations: Obligation[];
  inflows: Inflow[];
  policy: Policy;
  fxRates: FxRate[]; // indicative rates used by the deterministic forecast
}

export interface FxRate {
  from: Currency;
  to: Currency;
  rate: number; // 1 `from` = rate `to`
}

// ---- Forecast (deterministic, produced by src/engine) ----

export interface DailyPosition {
  date: IsoDate;
  balances: Record<string, number>; // currency -> minor units at end of day
  totalInBase: number; // sum converted to baseCurrency, minor units
  events: ForecastEvent[];
}

export interface ForecastEvent {
  kind: "obligation" | "inflow";
  refId: string;
  currency: Currency;
  signedAmount: number; // negative = out
}

export interface Shortfall {
  date: IsoDate;
  currency: Currency;
  gap: number; // minor units missing in that currency (positive)
  coveredByOtherCurrencies: boolean; // true if conversion could close it
  blockedObligationIds: string[];
}

export interface Forecast {
  horizonDays: number;
  days: DailyPosition[];
  shortfalls: Shortfall[]; // empty = no problem found
  firstShortfallDate: IsoDate | null;
}

// ---- Decisions (produced by src/agent, validated by src/engine) ----

export type Decision =
  | { action: "fund"; obligationId: string; reason: string }
  | {
      action: "convert";
      from: Currency;
      to: Currency;
      sellAmount: number; // minor units of `from`
      reason: string;
    }
  | { action: "defer"; obligationId: string; newDate: IsoDate; reason: string }
  | {
      action: "escalate";
      obligationId?: string;
      question: string; // what the human must decide
      reason: string;
    };

export interface Plan {
  id: string;
  createdAt: string; // ISO timestamp
  decisions: Decision[];
  summary: string;
  resultingForecast: Forecast; // forecast with the plan applied
}

export interface AuditEntry {
  id: string;
  planId: string;
  decisionIndex: number;
  basedOn: {
    balanceAccountIds: string[];
    obligationIds: string[];
    inflowIds: string[];
    policyRules: string[]; // e.g. "reserveFloor", "neverAutoDefer:payroll"
  };
  policyViolations: string[]; // empty if the decision passed validation
  executed: boolean;
  executionRef?: string; // bank conversion/transfer id when executed
}

export type EscalationStatus = "pending" | "approved" | "rejected";

export interface Escalation {
  id: string;
  planId: string;
  decision: Extract<Decision, { action: "escalate" }>;
  status: EscalationStatus;
  resolvedAt?: string;
}
