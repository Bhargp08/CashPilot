import type { BusinessState, Currency, IsoDate, Obligation } from "@/contracts/types";

/** "$15,000" / "€7,100" / "$8.40" from integer minor units, matching the UI. Display only; never used for math. */
export function money(amount: number, currency: Currency): string {
  const v = amount / 100;
  const s = new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: Number.isInteger(v) ? 0 : 2 }).format(Math.abs(v));
  return amount < 0 ? `-${s}` : s;
}

/** "Day 4 (Nov 5)", counting the as-of date as Day 1. */
export function day(date: IsoDate, asOf: IsoDate): string {
  const n = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${asOf}T00:00:00Z`)) / 86_400_000) + 1;
  const short = new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return `Day ${n} (${short})`;
}

/** "Payroll ($15,000, due Day 4 (Nov 5))" */
export function payment(o: Obligation, asOf: IsoDate): string {
  return `${o.payee} (${money(o.amount, o.currency)}, due ${day(o.dueDate, asOf)})`;
}

export function percent(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

/** Indicative rate from the state's own fxRates (direct, else inverse). Mirrors the engine's lookup. */
export function rateOf(state: BusinessState, from: Currency, to: Currency): number | null {
  if (from === to) return 1;
  const direct = state.fxRates.find((r) => r.from === from && r.to === to);
  if (direct) return direct.rate;
  const inverse = state.fxRates.find((r) => r.from === to && r.to === from);
  return inverse ? 1 / inverse.rate : null;
}

export function addDays(date: IsoDate, n: number): IsoDate {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Overdue items count as due on the as-of date, as in the engine. */
export function effectiveDate(date: IsoDate, asOf: IsoDate): IsoDate {
  return date < asOf ? asOf : date;
}
