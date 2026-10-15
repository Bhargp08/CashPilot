import { describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { engine } from "@/engine";
import { crunchScenario as s } from "@/scenarios/crunch";
import { answerQuestion } from "./chat";
import type { MessagesClient } from "./claude";
import { planWithRules } from "./rules";

const plan = planWithRules(engine, { state: s, forecast: engine.forecast(s, 14) });
const ask = (q: string, selected?: { type: string; id: string }) => answerQuestion(q, { state: s, plan, selected }, { client: null });

describe("answerQuestion (rules)", () => {
  it("explains an escalation", async () => {
    const a = await ask("Why did you escalate the EU supplier?");
    expect(a.text).toMatch(/EU Supplier \(beans\).*review/);
    expect(a.text).toMatch(/Pay EU Supplier \(beans\) €6,500/);
  });

  it("explains why payroll is protected", async () => {
    expect((await ask("Why is payroll protected?")).text).toMatch(/Payroll is payroll, which CashPilot never moves/);
  });

  it("explains the conversion with before/after balances", async () => {
    const a = await ask("Explain the conversion");
    expect(a.text).toMatch(/€7,100 to about \$7,668/);
    expect(a.text).toMatch(/Without it your USD account drops to -\$2,600 on Day 4 .*lowest point is \$5,068/);
  });

  it("what-if: customer payment 5 days late breaks the reserve and proposes the cheapest fix", async () => {
    const a = await ask("What if the customer payment is 5 days late?");
    expect(a.text).toMatch(/Wholesale Customer Payment \(\$9,500, 60% likely/);
    expect(a.text).toMatch(/breaks your \$5,000 reserve/);
    expect(a.proposal).toBeDefined();
    if (a.proposal?.kind === "defer") expect(["ob_rent", "ob_lease"]).toContain(a.proposal.obligationId);
    else expect(a.proposal?.kind).toBe("transfer");
  });

  it("what-if on a selected reliable inflow that still holds", async () => {
    const a = await ask("what if this is 2 days late?", { type: "inflow", id: "in_store" });
    expect(a.text).toMatch(/Online Store Payout/);
    expect(a.proposal).toBeUndefined();
  });

  it("falls back to the plan summary", async () => {
    expect((await ask("hello")).text).toBe(plan.summary);
  });
});

describe("answerQuestion (Claude)", () => {
  it("lets Claude reword the deterministic answer, keeping the engine's proposal", async () => {
    const create = vi.fn<MessagesClient["messages"]["create"]>().mockResolvedValue({
      content: [{ type: "text", text: "Reworded." }],
      stop_reason: "end_turn",
    } as unknown as Anthropic.Message);
    const a = await answerQuestion("What if the customer payment is 5 days late?", { state: s, plan }, { client: { messages: { create } } });
    expect(a.text).toBe("Reworded.");
    expect(a.proposal).toBeDefined();
    expect(String(create.mock.calls[0][0].messages[0].content)).toMatch(/<facts>.*breaks your \$5,000 reserve/);
  });

  it("returns the rules answer if the API fails", async () => {
    const create = vi.fn<MessagesClient["messages"]["create"]>().mockRejectedValue(new Error("down"));
    const a = await answerQuestion("Explain the conversion", { state: s, plan }, { client: { messages: { create } } });
    expect(a.text).toMatch(/€7,100/);
  });
});
