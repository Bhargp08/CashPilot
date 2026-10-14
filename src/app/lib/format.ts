import type { Currency, IsoDate } from "@/contracts/types";

export function money(minor: number, currency: Currency): string {
  const v = minor / 100;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: Number.isInteger(v) ? 0 : 2,
  }).format(v);
}

export function shortDate(d: IsoDate): string {
  return new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function weekday(d: IsoDate): string {
  return new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
}

export function humanize(violation: string): string {
  const m = violation.match(/^reserveFloor: (\w+) balance falls to (-?\d+) on (\S+), below floor (\d+)$/);
  if (m) {
    const cur = m[1] as Currency;
    return `${cur} drops to ${money(Number(m[2]), cur)} on ${shortDate(m[3])}, below your ${money(Number(m[4]), cur)} reserve`;
  }
  return violation.replace(/^[A-Za-z:]+: /, "");
}
