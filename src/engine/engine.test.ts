import { describe, expect, it } from "vitest";
import type { Decision, Plan } from "@/contracts/types";
import { crunchScenario as s } from "@/scenarios/crunch";
import { MockBank } from "@/bank/mock";
import { addDays } from "./util";
import { applyDecisions, buildAudit, forecast, validate } from "./index";

const goodPlan: Decision[] = [
  { action: "convert", from: "EUR", to: "USD", sellAmount: 926_000, reason: "close USD gap for payroll" },
  { action: "fund", obligationId: "ob_payroll", reason: "payroll" },
  { action: "defer", obligationId: "ob_saas", newDate: "2026-11-15", reason: "low priority" },
  { action: "defer", obligationId: "ob_rent", newDate: "2026-11-10", reason: "after Acme lands" },
  { action: "escalate", obligationId: "ob_supplier", question: "Cannot fund without breaching floor", reason: "cash" },
  { action: "escalate", obligationId: "ob_legal", question: "Disputed invoice", reason: "needsReview" },
];

describe("addDays", () => {
  it("crosses month boundaries", () => expect(addDays("2026-11-30", 2)).toBe("2026-12-02"));
});

describe("forecast", () => {
  const f = forecast(s, 14);
  it("finds the USD shortfall on payroll day, coverable by EUR", () => {
    expect(f.firstShortfallDate).toBe("2026-11-03");
    const usd = f.shortfalls.find((x) => x.currency === "USD")!;
    expect(usd.gap).toBe(800_000);
    expect(usd.coveredByOtherCurrencies).toBe(true);
    expect(usd.blockedObligationIds).toEqual(["ob_payroll"]);
  });
  it("is deterministic", () => expect(forecast(s, 14)).toEqual(f));
  it("has horizon-many days", () => expect(f.days).toHaveLength(14));
});

describe("validate", () => {
  it("accepts a sound plan", () => expect(validate(s, goodPlan)).toEqual([]));
  it("rejects deferring payroll", () =>
    expect(validate(s, [{ action: "defer", obligationId: "ob_payroll", newDate: "2026-11-04", reason: "x" }]).join()).toMatch(/neverAutoDefer/));
  it("rejects funding a flagged obligation", () =>
    expect(validate(s, [{ action: "fund", obligationId: "ob_legal", reason: "x" }]).join()).toMatch(/needsReview/));
  it("rejects deferring past deferrableUntil", () =>
    expect(validate(s, [{ action: "defer", obligationId: "ob_supplier", newDate: "2026-11-09", reason: "x" }]).join()).toMatch(/cannot slip/));
  it("rejects overselling a balance", () =>
    expect(validate(s, [{ action: "convert", from: "EUR", to: "USD", sellAmount: 99_000_000, reason: "x" }]).join()).toMatch(/exceeds available/));
  it("rejects a plan that breaches the reserve floor", () =>
    expect(validate(s, [{ action: "fund", obligationId: "ob_supplier", reason: "x" }]).join()).toMatch(/reserveFloor/));
  it("rejects two decisions on one obligation", () =>
    expect(validate(s, [{ action: "fund", obligationId: "ob_saas", reason: "x" }, { action: "defer", obligationId: "ob_saas", newDate: "2026-11-15", reason: "y" }]).join()).toMatch(/more than one/));
});

describe("applyDecisions", () => {
  it("does not mutate the input", () => {
    const before = structuredClone(s);
    applyDecisions(s, goodPlan);
    expect(s).toEqual(before);
  });
  it("the good plan clears every USD shortfall and respects the floor", () => {
    const after = forecast(applyDecisions(s, goodPlan), 14);
    expect(after.shortfalls.filter((x) => x.currency === "USD")).toEqual([]);
    expect(Math.min(...after.days.map((d) => d.balances.USD))).toBeGreaterThanOrEqual(200_000);
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
    const bad: Plan = { ...plan, decisions: [{ action: "fund", obligationId: "ob_legal", reason: "x" }] };
    expect(buildAudit(s, bad)[0].policyViolations.join()).toMatch(/needsReview/);
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
    expect(usd.available).toBe(600_000 - 120_000);
  });
  it("converts and refuses overspend", async () => {
    const bank = new MockBank();
    const ok = await bank.convert(await bank.quoteFx("EUR", "USD", 100_000));
    expect(ok.ok).toBe(true);
    const no = await bank.convert(await bank.quoteFx("EUR", "USD", 99_000_000));
    expect(no.ok).toBe(false);
  });
});
