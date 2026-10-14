import type { BusinessState, Decision } from "@/contracts/types";
import { convertAmount } from "./util";

/**
 * Semantics: fund = paid on its due date (no change to the schedule); defer = moves the due date;
 * convert = executes on the as-of date at the indicative rate; escalate = removed from the plan's
 * committed outflows until a human decides (the human's choice triggers a re-plan).
 */
export function applyDecisions(state: BusinessState, decisions: Decision[]): BusinessState {
  const next: BusinessState = structuredClone(state);
  for (const d of decisions) {
    if (d.action === "convert") {
      const from = next.balances.find((b) => b.currency === d.from);
      let to = next.balances.find((b) => b.currency === d.to);
      if (!from) continue;
      if (!to) {
        to = { accountId: `acc_${d.to.toLowerCase()}`, currency: d.to, available: 0 };
        next.balances.push(to);
      }
      from.available -= d.sellAmount;
      to.available += convertAmount(state, d.sellAmount, d.from, d.to);
    } else if (d.action === "defer") {
      const o = next.obligations.find((x) => x.id === d.obligationId);
      if (o) o.dueDate = d.newDate;
    } else if (d.action === "escalate" && d.obligationId) {
      next.obligations = next.obligations.filter((x) => x.id !== d.obligationId);
    }
  }
  return next;
}
