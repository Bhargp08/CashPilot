import { describe, expect, it } from "vitest";
import type { Decision, Plan } from "@/contracts/types";
import { crunchScenario as s, dayDate } from "@/scenarios/crunch";
import { MockBank } from "@/bank/mock";
import { addDays } from "./util";
import { applyDecisions, buildAudit, forecast, fundingOptions, neededFunding, transferInflow, validate } from "./index";

const goodPlan: Decision[] = [
  { action: "convert", from: "EUR", to: "USD", sellAmount: 710_000, executeOn: dayDate(3), reason: "cover payroll" },
  { action: "fund", obligationId: "ob_payroll", reason: "protected" },
  { action: "defer", obligationId: "ob_saas", newDate: dayDate(12), reason: "low priority" },
  { action: "fund", obligationId: "ob_rent", reason: "high priority" },
  { action: "fund", obligationId: "ob_tax", reason: "penalties accrue" },
  { action: "escalate", obligationId: "ob_supplier", question: "Pay the supplier?", reason: "needsReview" },
];
const executable = goodPlan.filter((d) => d.action !== "escalate");

describe("addDays", () => {
  it("crosses month boundaries", () => expect(addDays("2026-11-30", 2)).toBe("2026-12-02"));
});

describe("forecast", () => {
  const f = forecast(s, 14);
  it("finds the USD shortfall on payroll day", () => {
    expect(f.firstShortfallDate).toBe(dayDate(4));
    const usd = f.shortfalls.find((x) => x.currency === "USD")!;
    expect(usd.gap).toBe(260_000);
    expect(usd.coveredByOtherCurrencies).toBe(true);
    expect(usd.blockedObligationIds).toEqual(["ob_payroll"]);
  });
  it("is deterministic", () => expect(forecast(s, 14)).toEqual(f));
  it("has horizon-many days", () => expect(f.days).toHaveLength(14));
});

describe("validate", () => {
  it("accepts a sound plan", () => expect(validate(s, goodPlan)).toEqual([]));
  it("rejects deferring payroll", () =>
    expect(validate(s, [{ action: "defer", obligationId: "ob_payroll", newDate: dayDate(5), reason: "x" }]).join()).toMatch(/neverAutoDefer/));
  it("rejects funding a flagged obligation", () =>
    expect(validate(s, [{ action: "fund", obligationId: "ob_supplier", reason: "x" }]).join()).toMatch(/needsReview/));
  it("rejects deferring past deferrableUntil", () =>
    expect(validate(s, [{ action: "defer", obligationId: "ob_saas", newDate: dayDate(30), reason: "x" }]).join()).toMatch(/cannot slip/));
  it("rejects overselling a balance", () =>
    expect(validate(s, [{ action: "convert", from: "EUR", to: "USD", sellAmount: 99_000_000, reason: "x" }]).join()).toMatch(/exceeds available/));
  it("rejects a plan that breaches the reserve floor", () =>
    expect(validate(s, [{ action: "fund", obligationId: "ob_payroll", reason: "x" }]).join()).toMatch(/reserveFloor/));
  it("rejects two decisions on one obligation", () =>
    expect(validate(s, [{ action: "fund", obligationId: "ob_saas", reason: "x" }, { action: "defer", obligationId: "ob_saas", newDate: dayDate(12), reason: "y" }]).join()).toMatch(/more than one/));
});

describe("applyDecisions", () => {
  it("does not mutate the input", () => {
    const before = structuredClone(s);
    applyDecisions(s, goodPlan);
    expect(s).toEqual(before);
  });
  it("the plan clears the USD shortfall and respects the floor", () => {
    const after = forecast(applyDecisions(s, executable), 14);
    expect(after.shortfalls.filter((x) => x.currency === "USD")).toEqual([]);
    expect(Math.min(...after.days.map((d) => d.balances.USD))).toBe(506_800);
  });
});

describe("scheduled conversion", () => {
  it("moves money on the chosen day, not the as-of day", () => {
    const f = forecast(applyDecisions(s, executable), 14);
    expect(f.days[1].balances.USD).toBe(1_240_000);
    expect(f.days[2].balances.USD).toBe(2_006_800);
    expect(f.days[2].balances.EUR).toBe(690_000);
  });
});

describe("buildAudit", () => {
  const plan: Plan = { id: "p1", createdAt: "", decisions: goodPlan, summary: "", resultingForecast: forecast(s, 14) };
  it("links each decision to its inputs", () => {
    const a = buildAudit(s, plan);
    expect(a).toHaveLength(goodPlan.length);
    expect(a[1].basedOn.obligationIds).toEqual(["ob_payroll"]);
    expect(a[0].basedOn.balanceAccountIds.sort()).toEqual(["acc_eur", "acc_usd"]);
    expect(a.every((e) => e.policyViolations.length === 0)).toBe(true);
  });
  it("records violations", () => {
    const bad: Plan = { ...plan, decisions: [{ action: "fund", obligationId: "ob_supplier", reason: "x" }] };
    expect(buildAudit(s, bad)[0].policyViolations.join()).toMatch(/needsReview/);
  });
});

describe("funding", () => {
  it("covers a $9,000 need for free from savings, Roth last", () => {
    const a = fundingOptions(s, 900_000, dayDate(4));
    expect(a.mix).toHaveLength(1);
    expect(a.mix[0].assetId).toBe("as_sav");
    expect(a.mixCost).toBe(0);
    expect(a.mixCoversNeed).toBe(true);
    expect(a.options[a.options.length - 1].assetId).toBe("as_roth");
  });
  it("only uses Roth when nothing else can close the gap, and charges the penalty above contributions", () => {
    const a = fundingOptions(s, 12_000_000, dayDate(10));
    const roth = a.mix.find((o) => o.assetId === "as_roth")!;
    expect(roth).toBeDefined();
    expect(roth.cost).toBeGreaterThan(0);
  });
  it("flags a source that arrives too late", () => {
    const a = fundingOptions(s, 900_000, dayDate(2));
    expect(a.options.find((o) => o.assetId === "as_brk")!.inTime).toBe(false);
  });
  it("computes the need from a forecast", () => {
    expect(neededFunding(s, forecast(s, 14).days).need).toBeGreaterThan(0);
    expect(neededFunding(s, forecast(applyDecisions(s, executable), 14).days).need).toBe(0);
  });
  it("turns a transfer into a net-of-cost inflow", () => {
    const i = transferInflow(s, "as_brk", 1_000_000)!;
    expect(i.amount).toBe(1_000_000 - 32_000);
    expect(i.expectedDate).toBe(dayDate(3));
  });
});

describe("MockBank", () => {
  it("pays an obligation exactly once", async () => {
    const bank = new MockBank();
    const ob = s.obligations.find((o) => o.id === "ob_saas")!;
    const a = await bank.payObligation(ob);
    const b = await bank.payObligation(ob);
    expect(b.ref).toBe(a.ref);
    const usd = (await bank.getBalances()).find((x) => x.currency === "USD")!;
    expect(usd.available).toBe(1_240_000 - 84_000);
  });
  it("converts and refuses overspend", async () => {
    const bank = new MockBank();
    expect((await bank.convert(await bank.quoteFx("EUR", "USD", 100_000))).ok).toBe(true);
    expect((await bank.convert(await bank.quoteFx("EUR", "USD", 99_000_000))).ok).toBe(false);
  });
});
