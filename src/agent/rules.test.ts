import { describe, expect, it } from "vitest";
import type { Decision } from "@/contracts/types";
import { engine } from "@/engine";
import { crunchScenario as s } from "@/scenarios/crunch";
import { RulesAgent } from "./rules";
import { applyUserNote } from "./note";

const agent = new RulesAgent(engine, { newId: () => "plan_test", now: () => new Date("2026-11-02T09:00:00Z") });
const input = (userNote?: string) => ({ state: s, forecast: engine.forecast(s, 14), userNote });
const byId = (ds: Decision[], id: string) => ds.filter((d) => "obligationId" in d && d.obligationId === id);

describe("RulesAgent on crunchScenario", () => {
  it("produces the expected plan and validates clean", async () => {
    const p = await agent.propose(input());
    const shape = p.decisions.map((d) =>
      d.action === "convert" ? `convert ${d.from}->${d.to}` : d.action === "defer" ? `defer ${d.obligationId} ${d.newDate}` : `${d.action} ${d.obligationId}`,
    );
    expect(shape.sort()).toEqual(
      [
        "convert EUR->USD",
        "fund ob_payroll",
        "defer ob_saas 2026-11-15",
        "defer ob_rent 2026-11-10",
        "escalate ob_supplier",
        "escalate ob_legal",
      ].sort(),
    );
    const convert = p.decisions.find((d) => d.action === "convert")!;
    expect(convert.action === "convert" && convert.sellAmount).toBe(925_926); // about EUR 9.3k, minimal for payroll + floor
    expect(engine.validate(s, p.decisions)).toEqual([]);
    expect(p.resultingForecast.shortfalls.filter((x) => x.currency === "USD")).toEqual([]);
    expect(p.id).toBe("plan_test");
  });

  it("never defers payroll and gives each obligation one decision", async () => {
    const p = await agent.propose(input());
    expect(byId(p.decisions, "ob_payroll")).toEqual([expect.objectContaining({ action: "fund" })]);
    for (const o of s.obligations) expect(byId(p.decisions, o.id)).toHaveLength(1);
  });

  it("explains every decision with the ids and policy it rests on", async () => {
    const p = await agent.propose(input());
    for (const d of p.decisions) {
      if ("obligationId" in d && d.obligationId) expect(d.reason).toContain(d.obligationId);
    }
    const supplier = byId(p.decisions, "ob_supplier")[0];
    expect(supplier.action === "escalate" && supplier.question).toMatch(/reserve floor/);
    expect(supplier.reason).toMatch(/ob_payroll/);
    expect(byId(p.decisions, "ob_legal")[0].reason).toMatch(/needsReview/);
    expect(p.summary).toMatch(/shortfall of USD 8,000\.00 on 2026-11-03/);
  });

  it("is deterministic apart from id and timestamp", async () => {
    const a = await agent.propose(input());
    const b = await new RulesAgent(engine).propose(input());
    expect(b.decisions).toEqual(a.decisions);
  });

  it("still yields a valid plan when Acme pays 5 days late", async () => {
    const note = "Acme pays 5 days late";
    const p = await agent.propose(input(note));
    const adjusted = applyUserNote(s, note).state;
    expect(adjusted.inflows.find((i) => i.id === "in_acme")!.expectedDate).toBe("2026-11-14");
    expect(engine.validate(adjusted, p.decisions)).toEqual([]);
    expect(engine.validate(s, p.decisions)).toEqual([]);
    expect(byId(p.decisions, "ob_payroll")[0].action).toBe("fund");
    // Rent can no longer wait for Acme inside its deferral window, so it goes to a human.
    expect(byId(p.decisions, "ob_rent")[0].action).toBe("escalate");
    expect(p.summary).toMatch(/in_acme .* 2026-11-14/);
  });

  it("reports a note it cannot apply instead of guessing", async () => {
    const p = await agent.propose(input("interest rates go up"));
    expect(p.summary).toMatch(/did not match a known what-if/);
    expect(engine.validate(s, p.decisions)).toEqual([]);
  });
});
