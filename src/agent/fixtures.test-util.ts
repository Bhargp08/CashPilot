import type { BusinessState, Inflow, Obligation } from "@/contracts/types";

// Small hand-built scenarios for the simulator tests. Amounts are minor units.
export function scenario(over: { usd: number; obligations: Obligation[]; inflows?: Inflow[]; floor?: number; neverAutoDefer?: BusinessState["policy"]["neverAutoDefer"]; escalateAbove?: number }): BusinessState {
  return {
    asOf: "2026-10-14",
    baseCurrency: "USD",
    balances: [{ accountId: "acc_usd", currency: "USD", available: over.usd }],
    fxRates: [{ from: "EUR", to: "USD", rate: 1.08 }],
    obligations: over.obligations,
    inflows: over.inflows ?? [],
    policy: {
      reserveFloor: { amount: over.floor ?? 50_000, currency: "USD" },
      neverAutoDefer: over.neverAutoDefer ?? ["payroll", "tax"],
      escalateAbove: { amount: over.escalateAbove ?? 10_000_000, currency: "USD" },
      maxFxSpreadBps: 80,
    },
  };
}

export const payroll = (amount: number, dueDate = "2026-10-16", extra: Partial<Obligation> = {}): Obligation => ({
  id: "ob_payroll",
  payee: "Payroll",
  category: "payroll",
  amount,
  currency: "USD",
  dueDate,
  priority: 5,
  ...extra,
});

export const vendor = (amount: number, extra: Partial<Obligation> = {}): Obligation => ({
  id: "ob_vendor",
  payee: "Vendor Co",
  category: "other",
  amount,
  currency: "USD",
  dueDate: "2026-10-15",
  priority: 2,
  ...extra,
});
