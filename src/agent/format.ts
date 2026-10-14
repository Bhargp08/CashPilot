import type { BusinessState, Currency, IsoDate, Obligation } from "@/contracts/types";

/** "USD 14,000.00" from integer minor units. Display only; never used for math. */
export function money(amount: number, currency: Currency): string {
  const sign = amount < 0 ? "-" : "";
  const abs = Math.abs(amount);
  const major = Math.floor(abs / 100).toLocaleString("en-US");
  const minor = String(abs % 100).padStart(2, "0");
  return `${sign}${currency} ${major}.${minor}`;
}

export function describeObligation(o: Obligation): string {
  return `${o.id} (${o.payee}, ${money(o.amount, o.currency)} due ${o.dueDate}, priority ${o.priority})`;
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
