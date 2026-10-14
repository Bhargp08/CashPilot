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
    const codes = r.risks.map((x) => x.code);
    expect(codes).toContain("payroll_at_risk");
    expect(codes).toContain("negative_balance");
    const msg = r.risks.map((x) => x.message).join(" ");
    expect(msg).toMatch(/ob_vendor/);
    expect(msg).toMatch(/ob_payroll/);
    expect(msg).toMatch(/negative \(-USD 1,000\.00\) on 2026-10-16/);
  });

  it("the rules agent does not fund it, funds payroll, and says why", () => {
    const p = plan(s);
    expect(find(p.decisions, "ob_payroll")?.action).toBe("fund");
    const v = find(p.decisions, "ob_vendor")!;
    expect(v.action).toBe("escalate");
    expect(v.reason).toMatch(/ob_payroll/);
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

  it("defers it when policy permits, citing the obligation it protects", () => {
    const p = plan(s);
    expect(find(p.decisions, "ob_supplier")?.action).toBe("fund");
    const v = find(p.decisions, "ob_vendor")!;
    expect(v).toMatchObject({ action: "defer", newDate: "2026-10-24" });
    expect(v.reason).toMatch(/ob_supplier/);
    expect(v.reason).toMatch(/in_customer/);
    expect(v.reason).toMatch(/policy\.reserveFloor/);
    expect(engine.validate(s, p.decisions)).toEqual([]);
  });

  it("simulation says funding is unsafe for the higher-priority item", () => {
    const r = createSimulator(s, engine).simulate([], fund("ob_vendor"));
    expect(r.risks.map((x) => x.code)).toContain("higher_priority_at_risk");
    expect(r.risks.find((x) => x.code === "higher_priority_at_risk")!.obligationIds).toEqual(["ob_supplier"]);
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
    expect(find(p.decisions, "ob_vendor")?.action).toBe("fund");
    expect(find(p.decisions, "ob_vendor")!.reason).toMatch(/USD 39,000\.00 on 2026-10-16/);
  });
});

describe("D: only viable because of an inflow with confidence < 0.7", () => {
  const make = (confidence: number) =>
    scenario({
      usd: 500_000,
      floor: 200_000,
      obligations: [{ id: "ob_vendor", payee: "Vendor Co", category: "supplier", amount: 400_000, currency: "USD", dueDate: "2026-10-20", priority: 4 }],
      inflows: [{ id: "in_customer_12", payer: "Customer 12", amount: 300_000, currency: "USD", expectedDate: "2026-10-17", confidence }],
    });

  it("escalates instead of relying on the uncertain inflow", () => {
    const s = make(0.58);
    const r = createSimulator(s, engine).simulate([], fund("ob_vendor"));
    expect(r.safe).toBe(false);
    expect(r.safeIfAllInflowsArrive).toBe(true);
    const risk = r.risks.find((x) => x.code === "uncertain_inflow")!;
    expect(risk.inflowIds).toEqual(["in_customer_12"]);
    expect(risk.message).toMatch(/only safe if in_customer_12 .* arrives, but its confidence is below 0\.7 \(in_customer_12 0\.58\)/);

    const v = find(plan(s).decisions, "ob_vendor")!;
    expect(v.action).toBe("escalate");
    expect((v as Extract<Decision, { action: "escalate" }>).question).toMatch(/in_customer_12/);
  });

  it("funds when the same inflow is reliable", () => {
    expect(find(plan(make(0.9)).decisions, "ob_vendor")?.action).toBe("fund");
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
      expect(["fund", "escalate"]).toContain(find(p.decisions, "ob_payroll")?.action);
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
    expect(v.question).toMatch(/escalateAbove/);
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
    expect(() => createSimulator(frozen, engine).simulate([], fund("ob_vendor"))).not.toThrow();
  });

  it("converts only what is needed to hold the floor", () => {
    const st: BusinessState = { ...scenario({ usd: 100_000, obligations: [payroll(800_000)] }), balances: [
      { accountId: "acc_usd", currency: "USD", available: 100_000 },
      { accountId: "acc_eur", currency: "EUR", available: 5_000_000 },
    ] };
    const [c] = createSimulator(st, engine).planConversions([fund("ob_payroll")]);
    // need USD 7,500 to pay 8,000 from 1,000 and keep the 500 floor: ceil(750000 / 1.08) = 694445
    expect(c).toMatchObject({ from: "EUR", to: "USD", sellAmount: 694_445 });
  });
});

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object") {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}
