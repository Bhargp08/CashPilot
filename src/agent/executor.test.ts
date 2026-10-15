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

function spied(bank = new MockBank()) {
  return { bank, pay: vi.spyOn(bank, "payObligation"), convert: vi.spyOn(bank, "convert"), quote: vi.spyOn(bank, "quoteFx") };
}

describe("execute", () => {
  it("executes nothing when the plan has a violation", async () => {
    const { bank, pay, convert, quote } = spied();
    const queue = new EscalationQueue();
    const base = goodPlan();
    const plan: Plan = { ...base, decisions: base.decisions.map((d) => ("obligationId" in d && d.obligationId === "ob_supplier" ? { action: "fund", obligationId: "ob_supplier", reason: "x" } : d)) };
    const r = await execute(plan, bank, { queue, executeAll: true });
    expect(r).toMatchObject({ executed: false, items: [] });
    expect(r.violations.join()).toMatch(/needsReview/);
    expect(pay).not.toHaveBeenCalled();
    expect(convert).not.toHaveBeenCalled();
    expect(quote).not.toHaveBeenCalled();
    expect(queue.list()).toEqual([]);
  });

  it("leaves future-dated items scheduled unless executeAll", async () => {
    const { bank, pay, convert, quote } = spied();
    const queue = new EscalationQueue();
    const r = await execute(goodPlan(), bank, { queue }); // now = asOf = Day 1: nothing is due yet
    expect(r.executed).toBe(true);
    expect(pay).not.toHaveBeenCalled();
    expect(convert).not.toHaveBeenCalled();
    expect(quote).not.toHaveBeenCalled();
    const status = (a: string) => r.items.filter((i) => i.decision.action === a).map((i) => i.status);
    expect(status("convert")).toEqual(["scheduled"]);
    expect(status("fund")).toEqual(["scheduled", "scheduled", "scheduled"]);
    expect(status("defer")).toEqual(["recorded"]);
    expect(status("escalate")).toEqual(["awaiting_human"]);
  });

  it("runs what is due as days pass, and everything with executeAll", async () => {
    const { bank, pay, convert } = spied();
    const queue = new EscalationQueue();
    const plan = goodPlan();
    await execute(plan, bank, { queue, now: "2026-11-04" }); // Day 3: the conversion is due
    expect(convert).toHaveBeenCalledTimes(1);
    expect(pay).not.toHaveBeenCalled();
    const r = await execute(plan, bank, { queue, now: "2026-11-05" }); // Day 4: payroll
    expect(pay.mock.calls.map(([o]) => o.id)).toEqual(["ob_payroll"]);
    expect(convert).toHaveBeenCalledTimes(1);
    const payroll = r.audit.find((a) => a.basedOn.obligationIds.includes("ob_payroll"))!;
    expect(payroll).toMatchObject({ executed: true, executionRef: "pay_ob_payroll" });
    expect((await bank.getBalances()).find((b) => b.currency === "USD")!.available).toBe(506_800);
  });

  it("never sends an escalation to the bank", async () => {
    const { bank, pay } = spied();
    const queue = new EscalationQueue();
    const r = await execute(goodPlan(), bank, { queue, executeAll: true });
    expect(pay.mock.calls.map(([o]) => o.id)).not.toContain("ob_supplier");
    expect(queue.list("pending").map((e) => e.decision.obligationId)).toEqual(["ob_supplier"]);
    expect(r.items.find((i) => i.decision.action === "escalate")!.status).toBe("awaiting_human");
  });

  it("executing the same plan twice, even at once, never pays or converts twice", async () => {
    const { bank, pay, convert } = spied(new MockBank({ ...s, balances: [{ accountId: "acc_usd", currency: "USD", available: 5_000_000 }, { accountId: "acc_eur", currency: "EUR", available: 1_400_000 }] }));
    const queue = new EscalationQueue();
    const plan = goodPlan();
    await Promise.all([execute(plan, bank, { queue, executeAll: true }), execute(plan, bank, { queue, executeAll: true })]);
    await execute(plan, bank, { queue, executeAll: true });
    expect(convert).toHaveBeenCalledTimes(1);
    expect(pay.mock.calls.map(([o]) => o.id).sort()).toEqual(["ob_payroll", "ob_rent", "ob_tax"]);
    expect(queue.list()).toHaveLength(1);
  });

  it("rejects a quote above the spread limit and pays nothing that depended on it", async () => {
    class WideSpreadBank extends MockBank {
      async quoteFx(from: Currency, to: Currency, sellAmount: number): Promise<FxQuote> {
        return { ...(await super.quoteFx(from, to, sellAmount)), spreadBps: 150 };
      }
    }
    const { bank, pay, convert } = spied(new WideSpreadBank());
    const r = await execute(goodPlan(), bank, { queue: new EscalationQueue(), executeAll: true });
    expect(convert).not.toHaveBeenCalled();
    expect(pay).not.toHaveBeenCalled();
    const fx = r.items.find((i) => i.decision.action === "convert")!;
    expect(fx.status).toBe("rejected_spread");
    expect(fx.error).toMatch(/150 bps is above your limit of 80 bps/);
    expect(r.items.filter((i) => i.decision.action === "fund").every((i) => i.status === "skipped")).toBe(true);
  });
});

describe("EscalationQueue", () => {
  const escalation = { action: "escalate" as const, obligationId: "ob_saas", question: "Pay SaaS Stack now?", reason: "test" };

  it("approve pays exactly once, even if called twice", async () => {
    const { bank, pay } = spied();
    const queue = new EscalationQueue();
    const e = queue.add("plan_x", escalation);
    expect(queue.add("plan_x", escalation).id).toBe(e.id);
    const [a, b] = await Promise.all([queue.approve(e.id, bank), queue.approve(e.id, bank)]);
    const c = await queue.approve(e.id, bank);
    expect(pay).toHaveBeenCalledTimes(1);
    expect(a.execution?.ok).toBe(true);
    expect(b.error).toMatch(/already approved/);
    expect(c.error).toMatch(/already approved/);
    expect(queue.get(e.id)!.status).toBe("approved");
  });

  it("reject never touches the bank", async () => {
    const { bank, pay } = spied();
    const getState = vi.spyOn(bank, "getBusinessState");
    const queue = new EscalationQueue();
    const e = queue.add("plan_x", escalation);
    expect(queue.reject(e.id).escalation.status).toBe("rejected");
    expect((await queue.approve(e.id, bank)).error).toMatch(/already rejected/);
    expect(pay).not.toHaveBeenCalled();
    expect(getState).not.toHaveBeenCalled();
  });
});
