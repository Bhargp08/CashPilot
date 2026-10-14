import { describe, expect, it, vi } from "vitest";
import type { FxQuote } from "@/contracts/interfaces";
import type { Currency, Plan } from "@/contracts/types";
import { MockBank } from "@/bank/mock";
import { engine } from "@/engine";
import { crunchScenario as s } from "@/scenarios/crunch";
import { EscalationQueue } from "./escalations";
import { execute } from "./executor";
import { planWithRules } from "./rules";

let n = 0;
const goodPlan = (): Plan => planWithRules(engine, { state: s, forecast: engine.forecast(s, 14) }, { newId: () => `plan_${++n}` });

function spiedBank(bank = new MockBank()) {
  return {
    bank,
    pay: vi.spyOn(bank, "payObligation"),
    convert: vi.spyOn(bank, "convert"),
    quote: vi.spyOn(bank, "quoteFx"),
  };
}

describe("execute", () => {
  it("executes nothing when the plan has violations", async () => {
    const { bank, pay, convert, quote } = spiedBank();
    const queue = new EscalationQueue();
    const plan: Plan = { ...goodPlan(), decisions: [...goodPlan().decisions.filter((d) => !("obligationId" in d && d.obligationId === "ob_legal")), { action: "fund", obligationId: "ob_legal", reason: "x" }] };
    const r = await execute(plan, bank, engine, { queue });
    expect(r.ok).toBe(false);
    expect(r.violations.join()).toMatch(/needsReview/);
    expect(pay).not.toHaveBeenCalled();
    expect(convert).not.toHaveBeenCalled();
    expect(quote).not.toHaveBeenCalled();
    expect(queue.list()).toEqual([]);
    expect(r.outcomes.every((o) => o.status === "skipped")).toBe(true);
  });

  it("runs the good plan: convert, pay payroll, record deferrals, queue escalations", async () => {
    const { bank, pay, convert } = spiedBank();
    const queue = new EscalationQueue();
    const plan = goodPlan();
    const r = await execute(plan, bank, engine, { queue });
    expect(r.ok).toBe(true);
    expect(convert).toHaveBeenCalledTimes(1);
    expect(pay.mock.calls.map(([o]) => o.id)).toEqual(["ob_payroll"]);
    expect(r.outcomes.filter((o) => o.status === "recorded").map((o) => o.decision.action)).toEqual(["defer", "defer"]);
    const usd = (await bank.getBalances()).find((b) => b.currency === "USD")!;
    expect(usd.available).toBe(200_000); // exactly the reserve floor

    const payroll = r.audit.find((a) => a.basedOn.obligationIds.includes("ob_payroll"))!;
    expect(payroll).toMatchObject({ executed: true, executionRef: "pay_ob_payroll" });
    expect(r.audit.find((a) => a.basedOn.obligationIds.includes("ob_supplier"))!.executed).toBe(false);
  });

  it("never sends an escalation to the bank", async () => {
    const { bank, pay } = spiedBank();
    const queue = new EscalationQueue();
    const r = await execute(goodPlan(), bank, engine, { queue });
    const paid = pay.mock.calls.map(([o]) => o.id);
    expect(paid).not.toContain("ob_supplier");
    expect(paid).not.toContain("ob_legal");
    expect(queue.list("pending").map((e) => e.decision.obligationId).sort()).toEqual(["ob_legal", "ob_supplier"]);
    expect(r.escalations).toHaveLength(2);
  });

  it("executing twice never pays or converts twice", async () => {
    const { bank, pay, convert } = spiedBank();
    const queue = new EscalationQueue();
    const plan = goodPlan();
    const [a, b] = await Promise.all([execute(plan, bank, engine, { queue }), execute(plan, bank, engine, { queue })]);
    const c = await execute(plan, bank, engine, { queue });
    expect(pay).toHaveBeenCalledTimes(1);
    expect(convert).toHaveBeenCalledTimes(1);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(c.replayed).toBe(true);
    expect(queue.list()).toHaveLength(2);
  });

  it("rejects a quote whose spread exceeds policy and pays nothing that depended on it", async () => {
    class WideSpreadBank extends MockBank {
      async quoteFx(from: Currency, to: Currency, sellAmount: number): Promise<FxQuote> {
        return { ...(await super.quoteFx(from, to, sellAmount)), spreadBps: 150 };
      }
    }
    const { bank, pay, convert } = spiedBank(new WideSpreadBank());
    const r = await execute(goodPlan(), bank, engine, { queue: new EscalationQueue() });
    expect(r.ok).toBe(false);
    expect(convert).not.toHaveBeenCalled();
    expect(pay).not.toHaveBeenCalled();
    const fx = r.outcomes.find((o) => o.decision.action === "convert")!;
    expect(fx).toMatchObject({ status: "rejected" });
    expect(fx.error).toMatch(/150 bps exceeds policy.maxFxSpreadBps 80/);
    expect(r.outcomes.find((o) => o.decision.action === "fund")!.status).toBe("skipped");
  });
});

describe("EscalationQueue", () => {
  it("approving pays the obligation exactly once", async () => {
    const { bank, pay } = spiedBank();
    const queue = new EscalationQueue();
    const saas = s.obligations.find((o) => o.id === "ob_saas")!;
    const e = queue.add("plan_x", 0, { action: "escalate", obligationId: "ob_saas", question: "Pay ob_saas now?", reason: "test" }, saas);
    expect(queue.add("plan_x", 0, { action: "escalate", obligationId: "ob_saas", question: "dup", reason: "dup" }, saas).id).toBe(e.id);
    const [first, second] = await Promise.all([queue.approve(e.id, bank), queue.approve(e.id, bank)]);
    const third = await queue.approve(e.id, bank);
    expect(pay).toHaveBeenCalledTimes(1);
    expect([first, second].filter((r) => r.execution?.ok)).toHaveLength(1);
    expect(third.error).toMatch(/already approved/);
    expect(queue.get(e.id)!.status).toBe("approved");
    expect(queue.list()).toHaveLength(1);
  });

  it("rejecting pays nothing", async () => {
    const { bank, pay } = spiedBank();
    const queue = new EscalationQueue();
    await execute(goodPlan(), bank, engine, { queue });
    pay.mockClear();
    const legal = queue.list().find((e) => e.decision.obligationId === "ob_legal")!;
    expect(queue.reject(legal.id).escalation.status).toBe("rejected");
    expect((await queue.approve(legal.id, bank)).error).toMatch(/already rejected/);
    expect(pay).not.toHaveBeenCalled();
  });
});
