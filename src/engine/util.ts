import type { BusinessState, Currency, IsoDate } from "@/contracts/types";

export function addDays(date: IsoDate, n: number): IsoDate {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function rate(state: BusinessState, from: Currency, to: Currency): number {
  if (from === to) return 1;
  const direct = state.fxRates.find((r) => r.from === from && r.to === to);
  if (direct) return direct.rate;
  const inverse = state.fxRates.find((r) => r.from === to && r.to === from);
  if (inverse) return 1 / inverse.rate;
  throw new Error(`No FX rate for ${from}->${to}`);
}

export function convertAmount(state: BusinessState, amount: number, from: Currency, to: Currency): number {
  return Math.round(amount * rate(state, from, to));
}

/** Overdue items are treated as due on the as-of date. */
export function effectiveDate(date: IsoDate, asOf: IsoDate): IsoDate {
  return date < asOf ? asOf : date;
}
