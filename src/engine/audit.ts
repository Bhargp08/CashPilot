import type { AuditEntry, BusinessState, Plan } from "@/contracts/types";
import { PLAN_LEVEL, violations } from "./validate";

export function buildAudit(state: BusinessState, plan: Plan): AuditEntry[] {
  const all = violations(state, plan.decisions);
  const planLevel = all.filter((x) => x.index === PLAN_LEVEL).map((x) => x.message);

  return plan.decisions.map((d, i) => {
    const rules: string[] = [];
    const balanceAccountIds: string[] = [];
    const obligationIds: string[] = [];
    const inflowIds: string[] = [];

    if (d.action === "convert") {
      for (const b of state.balances) if (b.currency === d.from || b.currency === d.to) balanceAccountIds.push(b.accountId);
      rules.push("maxFxSpreadBps", "reserveFloor");
    } else {
      if (d.obligationId) {
        obligationIds.push(d.obligationId);
        const o = state.obligations.find((x) => x.id === d.obligationId);
        if (o) for (const b of state.balances) if (b.currency === o.currency) balanceAccountIds.push(b.accountId);
        if (o && d.action === "defer") rules.push(`neverAutoDefer:${o.category}`);
        if (o?.needsReview) rules.push("needsReview");
      }
      if (d.action === "fund") rules.push("reserveFloor", "escalateAbove");
      if (d.action === "defer") for (const inf of state.inflows) inflowIds.push(inf.id);
    }

    return {
      id: `${plan.id}:${i}`,
      planId: plan.id,
      decisionIndex: i,
      basedOn: { balanceAccountIds, obligationIds, inflowIds, policyRules: rules },
      policyViolations: [...all.filter((x) => x.index === i).map((x) => x.message), ...planLevel],
      executed: false,
    };
  });
}
