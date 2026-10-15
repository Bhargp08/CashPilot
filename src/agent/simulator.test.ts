import { describe, expect, it } from "vitest";
import type { BusinessState, Decision } from "@/contracts/types";
import { engine } from "@/engine";
import { planWithRules } from "./rules";
import { createSimulator } from "./simulator";
import { payroll, scenario, vendor } from "./fixtures.test-util";

const plan = (s: BusinessState) => planWithRules(engine, { state: s, forecast: engine.forecast(s, 14) }, { newId: () => "p", now: () => new Date(0) });
const find = (ds: Decision[], id: string) => ds.find((d) => "obligationId" in d && d.obligationId === id);
const fund = (id: string): Decision => ({ action: "fund", obligationId: id, reason: "" });

describe("A: funding a low-priority obligation would jeopardise payroll", () => {
  const s = scenario({ usd: 1_000_000, obligations: [payroll(800_000), vendor(300_000)] });

  it("simulation flags the payroll risk with the numbers", () => {
    const r = createSimulator(s, engine).simulate([fund("ob_payroll")], fund("ob_vendor"));
    expect(r.safe).toBe(false);
    expect(r.risks.map((x) => x.code)).toEqual(expect.arrayContaining(["payroll_at_risk", "negative_balance"]));
    const msg = r.risks.map((x) => x.message).join(" ");
    expect(msg).toMatch(/Paying Vendor Co \(\$3,000/);
    expect(msg).toMatch(/negative \(-\$1,000\) on Day 3 \(Oct 16\)/);
    expect(msg).toMatch(/cash that Payroll \(\$8,000/);
  });

  it("the rules agent does not fund it, funds payroll, and says why", () => {
    const p = plan(s);
    expect(find(p.decisions, "ob_payroll")?.action).toBe("fund");
    const v = find(p.decisions, "ob_vendor")!;
    expect(v.action).toBe("escalate");
    expect(v.reason).toMatch(/Vendor Co .*-\$1,000 .*leaving too little for Payroll \(\$8,000/);
    expect(engine.validate(s, p.decisions)).toEqual([]);
  });
});

describe("B: a deferrable low-priority obligation crowds out a higher-priority payment", () => {
  const s = scenario({
    usd: 1_000_000,
    obligations: [
      { id: "ob_supplier", payee: "Key Supplier", category: "supplier", amount: 700_000, currency: "USD", dueDate: "2026-10-16", priority: 4 },
      vendor(300_000, { deferrableUntil: "2026-10-24" }),
    ],
    inflows: [{ id: "in_customer", payer: "Customer", amount: 600_000, currency: "USD", expectedDate: "2026-10-20", confidence: 0.9 }],
  });

  it("defers it when policy permits, past the next reliable inflow, citing what it protects", () => {
    const p = plan(s);
    expect(find(p.decisions, "ob_supplier")?.action).toBe("fund");
    const v = find(p.decisions, "ob_vendor")!;
    expect(v).toMatchObject({ action: "defer", newDate: "2026-10-22" });
    expect(v.reason).toMatch(/Vendor Co \(\$3,000\) moves .*\$0 on Day 3 \(Oct 16\), below your \$500 reserve, leaving too little for Key Supplier/);
    expect(engine.validate(s, p.decisions)).toEqual([]);
  });

  it("simulation says funding is unsafe for the higher-priority item", () => {
    const r = createSimulator(s, engine).simulate([], fund("ob_vendor"));
    const risk = r.risks.find((x) => x.code === "higher_priority_at_risk")!;
    expect(risk.obligationIds).toEqual(["ob_supplier"]);
    expect(risk.message).toMatch(/Key Supplier/);
  });
});

describe("C: funding stays above reserves and protects higher-priority items", () => {
  const s = scenario({ usd: 5_000_000, obligations: [payroll(800_000), vendor(300_000, { deferrableUntil: "2026-10-24" })] });

  it("is allowed", () => {
    const r = createSimulator(s, engine).simulate([fund("ob_payroll")], fund("ob_vendor"));
    expect(r.safe).toBe(true);
    expect(r.risks).toEqual([]);
    expect(r.lowPoint).toEqual({ currency: "USD", amount: 3_900_000, date: "2026-10-16" });
    const p = plan(s);
    expect(["fund", undefined]).toContain(find(p.decisions, "ob_vendor")?.action); // paid as scheduled
    expect(engine.validate(s, p.decisions)).toEqual([]);
  });
});

describe("D: only viable because of an inflow with confidence < 0.7", () => {
  const make = (priority: 3 | 4, confidence: number) =>
    scenario({
      usd: 500_000,
      floor: 200_000,
      obligations: [{ id: "ob_vendor", payee: "Vendor Co", category: "supplier", amount: 400_000, currency: "USD", dueDate: "2026-10-20", priority }],
      inflows: [{ id: "in_customer_12", payer: "Customer 12", amount: 300_000, currency: "USD", expectedDate: "2026-10-17", confidence }],
    });

  it("escalates a lower-priority payment instead of relying on the uncertain inflow", () => {
    const s = make(3, 0.58);
    const r = createSimulator(s, engine).simulate([], fund("ob_vendor"));
    expect(r.safe).toBe(false);
    expect(r.safeIfAllInflowsArrive).toBe(true);
    const risk = r.risks.find((x) => x.code === "uncertain_inflow")!;
    expect(risk.inflowIds).toEqual(["in_customer_12"]);
    expect(risk.message).toMatch(/only safe if the \$3,000 Customer 12 .* arrives on time, and it is only 58% likely/);

    const v = find(plan(s).decisions, "ob_vendor") as Extract<Decision, { action: "escalate" }>;
    expect(v.action).toBe("escalate");
    expect(v.reason).toMatch(/only safe if the \$3,000 Customer 12 \(58% likely\)/);
    expect(v.question).toMatch(/Vendor Co/);
  });

  it("funds a high-priority payment but says it counts on the uncertain inflow", () => {
    const v = find(plan(make(4, 0.58)).decisions, "ob_vendor")!;
    expect(v.action).toBe("fund");
    expect(v.reason).toMatch(/counts on the \$3,000 Customer 12 \(58% likely\)/);
  });

  it("does not escalate when the same inflow is reliable", () => {
    expect(find(plan(make(3, 0.9)).decisions, "ob_vendor")?.action).not.toBe("escalate");
  });
});

describe("E: payroll is never deferred", () => {
  it("even when policy.neverAutoDefer omits it and a deferral date exists", () => {
    for (const usd of [100_000, 300_000, 700_000, 900_000, 5_000_000]) {
      const s = scenario({
        usd,
        neverAutoDefer: [],
        obligations: [payroll(800_000, "2026-10-16", { deferrableUntil: "2026-10-25" }), vendor(100_000, { deferrableUntil: "2026-10-24" })],
        inflows: [{ id: "in_big", payer: "Big Co", amount: 2_000_000, currency: "USD", expectedDate: "2026-10-20", confidence: 0.95 }],
      });
      const p = plan(s);
      expect(p.decisions.some((d) => d.action === "defer" && d.obligationId === "ob_payroll")).toBe(false);
      expect(engine.validate(s, p.decisions)).toEqual([]);
    }
  });

  it("simulating a payroll deferral is always unsafe", () => {
    const s = scenario({ usd: 5_000_000, neverAutoDefer: [], obligations: [payroll(800_000, "2026-10-16", { deferrableUntil: "2026-10-25" })] });
    const r = createSimulator(s, engine).simulate([], { action: "defer", obligationId: "ob_payroll", newDate: "2026-10-20", reason: "" });
    expect(r.safe).toBe(false);
    expect(r.risks.map((x) => x.code)).toContain("payroll_at_risk");
  });
});

describe("policy limits", () => {
  it("escalates a payment above policy.escalateAbove", () => {
    const s = scenario({ usd: 50_000_000, escalateAbove: 1_000_000, obligations: [vendor(2_000_000)] });
    const v = find(plan(s).decisions, "ob_vendor") as Extract<Decision, { action: "escalate" }>;
    expect(v.action).toBe("escalate");
    expect(v.question).toMatch(/approval limit/);
  });
});

describe("simulator properties", () => {
  const s = scenario({ usd: 1_000_000, obligations: [payroll(800_000), vendor(300_000)] });

  it("is deterministic", () => {
    const a = createSimulator(s, engine).simulate([fund("ob_payroll")], fund("ob_vendor"));
    const b = createSimulator(structuredClone(s), engine).simulate([fund("ob_payroll")], fund("ob_vendor"));
    expect(b).toEqual(a);
  });

  it("is read-only: works on a deeply frozen state", () => {
    const frozen = deepFreeze(structuredClone(s));
    expect(() => createSimulator(frozen, engine).simulate([], fund("ob_vendor"), { mode: "plan" })).not.toThrow();
  });

  it("converts the minimum, rounded up to 100 units, the day before it is needed", () => {
    const st: BusinessState = {
      ...scenario({ usd: 100_000, obligations: [payroll(800_000)] }),
      balances: [
        { accountId: "acc_usd", currency: "USD", available: 100_000 },
        { accountId: "acc_eur", currency: "EUR", available: 5_000_000 },
      ],
    };
    const [c] = createSimulator(st, engine).planConversions([fund("ob_payroll")]);
    // need $7,500 (pay $8,000 from $1,000 and keep $500): 7,500 / 1.08 = 6,944.44 -> EUR 7,000
    expect(c).toMatchObject({ from: "EUR", to: "USD", sellAmount: 700_000, executeOn: "2026-10-15" });
  });

  it("never sells what the source currency needs for its own payments", () => {
    const st: BusinessState = {
      ...scenario({ usd: 100_000, obligations: [payroll(800_000), { ...vendor(4_000_000), currency: "EUR", id: "ob_eur" }] }),
      balances: [
        { accountId: "acc_usd", currency: "USD", available: 100_000 },
        { accountId: "acc_eur", currency: "EUR", available: 5_000_000 },
      ],
    };
    const [c] = createSimulator(st, engine).planConversions([fund("ob_payroll")]);
    expect(c.sellAmount).toBeLessThanOrEqual(1_000_000);
  });
});

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object") {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}
