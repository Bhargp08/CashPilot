import { afterEach, describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type { Decision } from "@/contracts/types";
import { engine } from "@/engine";
import { crunchScenario as s, dayDate } from "@/scenarios/crunch";
import { ClaudeAgent, type MessagesClient } from "./claude";
import { createAgent } from "./index";
import { RulesAgent, planWithRules } from "./rules";
import { SYSTEM_PROMPT } from "./prompt";

const input = { state: s, forecast: engine.forecast(s, 14) };
const reference = planWithRules(engine, input).decisions;

const toRaw = (d: Decision) => ({
  action: d.action,
  obligationId: "obligationId" in d ? (d.obligationId ?? null) : null,
  from: d.action === "convert" ? d.from : null,
  to: d.action === "convert" ? d.to : null,
  sellAmount: d.action === "convert" ? d.sellAmount : null,
  newDate: d.action === "defer" ? d.newDate : null,
  executeOn: d.action === "convert" ? (d.executeOn ?? null) : null,
  question: d.action === "escalate" ? d.question : null,
  reason: d.reason,
});

function toolResponse(toolInput: unknown): Anthropic.Message {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content: [{ type: "tool_use", id: "toolu_1", name: "submit_plan", input: toolInput }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as Anthropic.Message;
}

function fakeClient(...responses: Anthropic.Message[]) {
  const create = vi.fn<MessagesClient["messages"]["create"]>();
  for (const r of responses) create.mockResolvedValueOnce(r);
  return { client: { messages: { create } } satisfies MessagesClient, create };
}

const makeAgent = (client: MessagesClient) => {
  const onFallback = vi.fn();
  return { agent: new ClaudeAgent(engine, { client, onFallback, model: "claude-sonnet-5-5" }), onFallback };
};
const lastFeedback = (create: ReturnType<typeof fakeClient>["create"]) => JSON.stringify(create.mock.calls[1][0].messages.at(-1)!.content);

describe("ClaudeAgent", () => {
  it("malformed output: one retry, then the rules plan", async () => {
    const { client, create } = fakeClient(toolResponse({ nope: true }), toolResponse({ summary: "", decisions: "x" }));
    const { agent, onFallback } = makeAgent(client);
    const p = await agent.propose(input);
    expect(create).toHaveBeenCalledTimes(2);
    expect(onFallback).toHaveBeenCalledOnce();
    expect(p.decisions).toEqual(reference);
    expect(engine.validate(s, p.decisions)).toEqual([]);
  });

  it("policy violations: fed back once, then the rules plan", async () => {
    const bad = { summary: "s", decisions: reference.map((d) => ("obligationId" in d && d.obligationId === "ob_supplier" ? toRaw({ action: "fund", obligationId: "ob_supplier", reason: "Pay EU Supplier (beans)." }) : toRaw(d))) };
    const { client, create } = fakeClient(toolResponse(bad), toolResponse(bad));
    const { agent, onFallback } = makeAgent(client);
    const p = await agent.propose(input);
    expect(create).toHaveBeenCalledTimes(2);
    expect(lastFeedback(create)).toMatch(/needsReview/);
    expect(lastFeedback(create)).toMatch(/"is_error":true/);
    expect(onFallback).toHaveBeenCalledOnce();
    expect(engine.validate(s, p.decisions)).toEqual([]);
  });

  it("accepts a corrected plan on the retry", async () => {
    const good = { summary: "Convert euros, pay payroll, rent and tax, push SaaS Stack, and ask you about EU Supplier (beans).", decisions: reference.map(toRaw) };
    const { client, create } = fakeClient(toolResponse({ summary: "s", decisions: [{ action: "fund" }] }), toolResponse(good));
    const { agent, onFallback } = makeAgent(client);
    const p = await agent.propose(input);
    expect(create).toHaveBeenCalledTimes(2);
    expect(onFallback).not.toHaveBeenCalled();
    expect(p.summary).toBe(good.summary);
    expect(engine.validate(s, p.decisions)).toEqual([]);
    expect(Math.min(...p.resultingForecast.days.map((d) => d.balances.USD))).toBe(506_800);
  });

  it("never trusts model numbers: conversions are recomputed by the engine", async () => {
    const decisions = reference.map((d) => (d.action === "convert" ? toRaw({ ...d, sellAmount: 1_234, executeOn: dayDate(1) }) : toRaw(d)));
    const { client } = fakeClient(toolResponse({ summary: "s", decisions }));
    const p = await makeAgent(client).agent.propose(input);
    expect(p.decisions.find((d) => d.action === "convert")).toMatchObject({ sellAmount: 710_000, executeOn: dayDate(3) });
  });

  it("rejects a payroll deferral and a reason that does not name the payee", async () => {
    const bad = {
      summary: "s",
      decisions: reference.map((d) =>
        "obligationId" in d && d.obligationId === "ob_payroll"
          ? toRaw({ action: "defer", obligationId: "ob_payroll", newDate: dayDate(5), reason: "Later." })
          : toRaw(d),
      ),
    };
    const { client, create } = fakeClient(toolResponse(bad), toolResponse(bad));
    const p = await makeAgent(client).agent.propose(input);
    expect(lastFeedback(create)).toMatch(/payroll/i);
    expect(lastFeedback(create)).toMatch(/must name the payee/);
    expect(p.decisions.find((d) => "obligationId" in d && d.obligationId === "ob_payroll")!.action).toBe("fund");
  });

  it("falls back when the API throws or no tool is called", async () => {
    const create = vi.fn<MessagesClient["messages"]["create"]>().mockRejectedValue(new Error("network down"));
    const { agent, onFallback } = makeAgent({ messages: { create } });
    expect((await agent.propose(input)).decisions).toEqual(reference);
    expect(onFallback.mock.calls[0][0].join()).toMatch(/network down/);

    const text = { ...toolResponse({}), content: [{ type: "text", text: "Pay payroll." }], stop_reason: "end_turn" } as unknown as Anthropic.Message;
    const { client } = fakeClient(text, text);
    expect((await makeAgent(client).agent.propose(input)).decisions).toEqual(reference);
  });

  it("sends state (without other assets), forecast, simulation and the safety rules", async () => {
    const noted = { ...input, userNote: "customer payment is 5 days late" };
    const { client, create } = fakeClient(toolResponse({ summary: "s", decisions: planWithRules(engine, noted).decisions.map(toRaw) }));
    const { agent, onFallback } = makeAgent(client);
    await agent.propose(noted);
    expect(onFallback).not.toHaveBeenCalled();
    const params = create.mock.calls[0][0];
    expect(params.model).toBe("claude-sonnet-5-5");
    expect(params.tool_choice).toEqual({ type: "auto" });
    expect(params.system).toBe(SYSTEM_PROMPT);
    expect(SYSTEM_PROMPT).toMatch(/Never sacrifice payroll or required reserves/);
    expect(SYSTEM_PROMPT).toMatch(/executeOn/);
    const msg = String(params.messages[0].content);
    expect(msg).toMatch(/<simulation>/);
    expect(msg).toMatch(/Wholesale Customer Payment moved 5 days later/);
    expect(msg).not.toMatch(/otherAssets|Roth IRA/);
  });
});

describe("createAgent", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("uses the rules agent without ANTHROPIC_API_KEY", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(createAgent()).toBeInstanceOf(RulesAgent);
  });
  it("uses Claude when ANTHROPIC_API_KEY is set", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-not-a-real-key");
    expect(createAgent()).toBeInstanceOf(ClaudeAgent);
  });
});
