import type { BusinessState, Decision } from "@/contracts/types";
import { applyDecisions } from "./apply";
import { forecast } from "./forecast";
import { convertAmount } from "./util";

export const PLAN_LEVEL = -1;
const FLOOR_CHECK_DAYS = 14;

export interface Violation {
  index: number; // decision index, or PLAN_LEVEL
  message: string;
}

export function violations(state: BusinessState, decisions: Decision[]): Violation[] {
  const out: Violation[] = [];
  const { policy } = state;
  const seen = new Set<string>();
  const avail: Record<string, number> = {};
  for (const b of state.balances) avail[b.currency] = (avail[b.currency] ?? 0) + b.available;
  const limit = (amount: number, cur: Parameters<typeof convertAmount>[2]) =>
    convertAmount(state, amount, cur, policy.escalateAbove.currency);

  decisions.forEach((d, index) => {
    const v = (message: string) => out.push({ index, message });

    if (d.action === "convert") {
      if (d.from === d.to) v("convert: from and to currencies are identical");
      if (!(d.sellAmount > 0) || !Number.isInteger(d.sellAmount)) v("convert: sellAmount must be a positive integer");
      if (d.sellAmount > (avail[d.from] ?? 0)) v(`convert: sellAmount exceeds available ${d.from} balance`);
      else avail[d.from] -= d.sellAmount;
      if (limit(d.sellAmount, d.from) > policy.escalateAbove.amount) v("escalateAbove: conversion exceeds the escalation threshold");
      return;
    }
    if (d.action === "escalate") {
      if (d.obligationId && !state.obligations.some((o) => o.id === d.obligationId)) v(`unknown obligation ${d.obligationId}`);
      if (d.obligationId) {
        if (seen.has(d.obligationId)) v(`obligation ${d.obligationId} has more than one decision`);
        seen.add(d.obligationId);
      }
      return;
    }

    const o = state.obligations.find((x) => x.id === d.obligationId);
    if (!o) return v(`unknown obligation ${d.obligationId}`);
    if (seen.has(o.id)) v(`obligation ${o.id} has more than one decision`);
    seen.add(o.id);

    if (d.action === "fund") {
      if (o.needsReview) v(`needsReview: ${o.id} is flagged and must be escalated, not auto-funded`);
      if (limit(o.amount, o.currency) > policy.escalateAbove.amount) v(`escalateAbove: funding ${o.id} exceeds the escalation threshold`);
    } else {
      if (policy.neverAutoDefer.includes(o.category)) v(`neverAutoDefer:${o.category}: ${o.id} cannot be deferred`);
      if (!o.deferrableUntil) v(`defer: ${o.id} has no deferrableUntil`);
      else if (d.newDate > o.deferrableUntil) v(`defer: ${o.id} cannot slip past ${o.deferrableUntil}`);
      if (d.newDate <= o.dueDate) v(`defer: newDate must be after ${o.dueDate}`);
    }
  });

  if (out.length === 0) {
    const result = forecast(applyDecisions(state, decisions), FLOOR_CHECK_DAYS);
    const fc = policy.reserveFloor.currency;
    for (const day of result.days) {
      const b = day.balances[fc] ?? 0;
      if (b < policy.reserveFloor.amount) {
        out.push({ index: PLAN_LEVEL, message: `reserveFloor: ${fc} balance falls to ${b} on ${day.date}, below floor ${policy.reserveFloor.amount}` });
        break;
      }
    }
  }
  return out;
}

export function validate(state: BusinessState, decisions: Decision[]): string[] {
  return violations(state, decisions).map((x) => x.message);
}
