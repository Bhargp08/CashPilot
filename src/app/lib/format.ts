import type { Currency, IsoDate } from "@/contracts/types";

export function money(minor: number, currency: Currency): string {
  const v = minor === 0 ? 0 : minor / 100;
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
  const nd = violation.match(/^neverAutoDefer:(\w+):/);
  if (nd) return `${nd[1]} payments are protected by your rules and cannot be moved`;
  const slip = violation.match(/^defer: \S+ cannot slip past (\S+)$/);
  if (slip) return `it can only be pushed to ${shortDate(slip[1])}`;
  if (/^defer: \S+ has no deferrableUntil$/.test(violation)) return "it has no room to be pushed back";
  return violation.replace(/^[A-Za-z:]+: /, "");
}

import { dayNumber } from "@/scenarios/crunch";

export function dayLabel(d: IsoDate): string {
  return `Day ${dayNumber(d)} · ${shortDate(d)}`;
}

export function signed(minor: number, currency: Currency): string {
  return minor < 0 ? `−${money(-minor, currency)}` : money(minor, currency);
}
