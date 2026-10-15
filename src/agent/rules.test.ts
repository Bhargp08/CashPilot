import { describe, expect, it } from "vitest";
import type { Decision } from "@/contracts/types";
import { engine } from "@/engine";
import { crunchScenario as s, dayDate } from "@/scenarios/crunch";
import { RulesAgent } from "./rules";
import { applyUserNote } from "./note";
import { explainDecision } from "./index";

const agent = new RulesAgent(engine, { newId: () => "plan_test", now: () => new Date("2026-11-02T09:00:00Z") });
const input = (userNote?: string) => ({ state: s, forecast: engine.forecast(s, 14), userNote });
const forId = (ds: Decision[], id: string) => ds.filter((d) => "obligationId" in d && d.obligationId === id);
const shape = (ds: Decision[]) =>
  ds.map((d) => (d.action === "convert" ? `convert ${d.from}->${d.to} ${d.sellAmount} ${d.executeOn}` : d.action === "defer" ? `defer ${d.obligationId} ${d.newDate}` : `${d.action} ${d.obligationId}`)).sort();

describe("RulesAgent on crunchScenario (Northwind Roasters)", () => {
  it("returns exactly the plan in the brief, and it validates", async () => {
    const p = await agent.propose(input());
    expect(shape(p.decisions)).toEqual(
      [
        `convert EUR->USD 710000 ${dayDate(3)}`,
        "fund ob_payroll",
        "fund ob_rent",
        "fund ob_tax",
        `defer ob_saas ${dayDate(12)}`,
        "escalate ob_supplier",
      ].sort(),
    );
    expect(forId(p.decisions, "ob_lease")).toEqual([]);
    expect(engine.validate(s, p.decisions)).toEqual([]);
    expect(p.id).toBe("plan_test");
  });

  it("keeps USD at or above $5,000 every day, lowest $5,068", async () => {
    const p = await agent.propose(input());
    const usd = p.resultingForecast.days.map((d) => d.balances.USD);
    expect(p.resultingForecast.days).toHaveLength(14);
    expect(Math.min(...usd)).toBe(506_800);
  });

  it("never defers payroll or tax and never funds the supplier", async () => {
    for (const note of [undefined, "customer payment is 5 days late"]) {
      const p = await agent.propose(input(note));
      for (const id of ["ob_payroll", "ob_tax"]) expect(forId(p.decisions, id).map((d) => d.action)).not.toContain("defer");
      expect(forId(p.decisions, "ob_supplier").map((d) => d.action)).toEqual(["escalate"]);
    }
  });

  it("explains each decision in plain English with payee names and real figures, no ids", async () => {
    const p = await agent.propose(input());
    for (const d of p.decisions) {
      expect(d.reason).not.toMatch(/\bob_|\bin_|acc_/);
      expect(d.reason.split(/\.\s/).length).toBe(1); // one sentence
    }
    const reason = (id: string) => forId(p.decisions, id)[0].reason;
    expect(p.decisions.find((d) => d.action === "convert")!.reason).toMatch(/€7,100 to about \$7,668 .*Day 3 .*Payroll \(\$15,000.*€6,900 stays in EUR, enough for EU Supplier \(beans\) \(€6,500\)/);
    expect(reason("ob_payroll")).toMatch(/Payroll \(\$15,000, due Day 4 \(Nov 5\)\).*\$5,068/);
    expect(reason("ob_saas")).toMatch(/SaaS Stack \(\$840\) moves from Day 5 \(Nov 6\) to Day 12 \(Nov 13\)/);
    expect(reason("ob_supplier")).toMatch(/EU Supplier \(beans\).*review.*60% likely/);
    const q = forId(p.decisions, "ob_supplier")[0];
    expect(q.action === "escalate" && q.question).toMatch(/Pay EU Supplier \(beans\) €6,500/);
    expect(p.summary).toMatch(/-\$3,440 on Day 5/);
    expect(p.summary).toMatch(/never goes below \$5,068/);
  });

  it("funds rent and tax but warns that they count on the 60%-likely wholesale payment", async () => {
    const p = await agent.propose(input());
    for (const id of ["ob_rent", "ob_tax"]) expect(forId(p.decisions, id)[0].reason).toMatch(/counts on the \$9,500 Wholesale Customer Payment \(60% likely\)/);
    expect(forId(p.decisions, "ob_payroll")[0].reason).not.toMatch(/counts on/);
  });

  it("is deterministic apart from id and timestamp", async () => {
    const a = await agent.propose(input());
    const b = await new RulesAgent(engine).propose(input());
    expect(b.decisions).toEqual(a.decisions);
  });

  it("customer payment 5 days late: still valid, defers or escalates more instead of breaking policy", async () => {
    const note = "customer payment is 5 days late";
    const adjusted = applyUserNote(s, note).state;
    expect(adjusted.inflows.find((i) => i.id === "in_wholesale")!.expectedDate).toBe(dayDate(11));
    const p = await agent.propose(input(note));
    expect(engine.validate(adjusted, p.decisions)).toEqual([]);
    const base = await agent.propose(input());
    const moved = (ds: Decision[]) => ds.filter((d) => d.action === "defer" || d.action === "escalate").length;
    expect(moved(p.decisions)).toBeGreaterThan(moved(base.decisions));
    expect(Math.min(...p.resultingForecast.days.map((d) => d.balances.USD))).toBeGreaterThanOrEqual(500_000);
    expect(p.summary).toMatch(/Wholesale Customer Payment moved 5 days later/);
  });

  it("reports a note it cannot apply instead of guessing", async () => {
    const p = await agent.propose(input("interest rates go up"));
    expect(p.summary).toMatch(/could not turn "interest rates go up" into a what-if/);
    expect(engine.validate(s, p.decisions)).toEqual([]);
  });

  it("explainDecision gives the same plain reason", async () => {
    const p = await agent.propose(input());
    const fund = forId(p.decisions, "ob_payroll")[0];
    expect(explainDecision(s, fund, p.decisions)).toBe(fund.reason);
  });
});
