import { afterEach, describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type { Decision } from "@/contracts/types";
import { engine } from "@/engine";
import { crunchScenario as s } from "@/scenarios/crunch";
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
  question: d.action === "escalate" ? d.question : null,
  reason: d.reason,
});

function toolResponse(input: unknown): Anthropic.Message {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content: [{ type: "tool_use", id: "toolu_1", name: "submit_plan", input }],
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

const agent = (client: MessagesClient, onFallback = vi.fn()) => ({ agent: new ClaudeAgent(engine, { client, onFallback, model: "claude-sonnet-5-5" }), onFallback });

describe("ClaudeAgent", () => {
  it("falls back to the rules plan after two malformed responses", async () => {
    const { client, create } = fakeClient(toolResponse({ nope: true }), toolResponse({ summary: "", decisions: "x" }));
    const { agent: a, onFallback } = agent(client);
    const p = await a.propose(input);
    expect(create).toHaveBeenCalledTimes(2);
    expect(onFallback).toHaveBeenCalledOnce();
    expect(p.decisions).toEqual(reference);
  });

  it("retries once with the problems fed back, then accepts a fixed plan", async () => {
    const good = { summary: "Fund payroll ob_payroll; escalate ob_supplier and ob_legal.", decisions: reference.map(toRaw) };
    const { client, create } = fakeClient(toolResponse({ summary: "s", decisions: [{ action: "fund" }] }), toolResponse(good));
    const { agent: a, onFallback } = agent(client);
    const p = await a.propose(input);
    expect(create).toHaveBeenCalledTimes(2);
    expect(onFallback).not.toHaveBeenCalled();
    expect(p.summary).toBe(good.summary);
    expect(engine.validate(s, p.decisions)).toEqual([]);
    const retry = create.mock.calls[1][0].messages.at(-1)!;
    expect(JSON.stringify(retry.content)).toMatch(/"is_error":true/);
  });

  it("feeds policy violations back and falls back if they persist", async () => {
    const bad = { summary: "s", decisions: reference.map((d) => ("obligationId" in d && d.obligationId === "ob_legal" ? toRaw({ action: "fund", obligationId: "ob_legal", reason: "pay ob_legal" }) : toRaw(d))) };
    const { client, create } = fakeClient(toolResponse(bad), toolResponse(bad));
    const { agent: a, onFallback } = agent(client);
    const p = await a.propose(input);
    expect(create).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(create.mock.calls[1][0].messages.at(-1)!.content)).toMatch(/needsReview/);
    expect(onFallback).toHaveBeenCalledOnce();
    expect(p.decisions).toEqual(reference);
  });

  it("rejects a payroll deferral and an unsafe payment via the simulator", async () => {
    const bad = {
      summary: "s",
      decisions: reference.map((d) => {
        if ("obligationId" in d && d.obligationId === "ob_payroll") return toRaw({ action: "defer", obligationId: "ob_payroll", newDate: "2026-11-04", reason: "ob_payroll later" });
        return toRaw(d);
      }),
    };
    const { client, create } = fakeClient(toolResponse(bad), toolResponse(bad));
    const { agent: a } = agent(client);
    const p = await a.propose(input);
    expect(JSON.stringify(create.mock.calls[1][0].messages.at(-1)!.content)).toMatch(/payroll/);
    expect(p.decisions.find((d) => "obligationId" in d && d.obligationId === "ob_payroll")!.action).toBe("fund");
  });

  it("replaces the model's conversion amount with the engine's", async () => {
    const decisions = reference.map((d) => (d.action === "convert" ? toRaw({ ...d, sellAmount: 1_234 }) : toRaw(d)));
    const { client } = fakeClient(toolResponse({ summary: "s", decisions }));
    const p = await agent(client).agent.propose(input);
    const c = p.decisions.find((d) => d.action === "convert");
    expect(c && c.action === "convert" && c.sellAmount).toBe(925_926);
  });

  it("falls back when the API call throws or no tool is called", async () => {
    const create = vi.fn<MessagesClient["messages"]["create"]>().mockRejectedValue(new Error("network down"));
    const { agent: a, onFallback } = agent({ messages: { create } });
    expect((await a.propose(input)).decisions).toEqual(reference);
    expect(onFallback.mock.calls[0][0].join()).toMatch(/network down/);

    const text = { ...toolResponse({}), content: [{ type: "text", text: "I think you should pay payroll." }], stop_reason: "end_turn" } as unknown as Anthropic.Message;
    const { client } = fakeClient(text, text);
    expect((await agent(client).agent.propose(input)).decisions).toEqual(reference);
  });

  it("sends the state, forecast and deterministic simulation, and the safety rules", async () => {
    const noted = { ...input, userNote: "Acme pays 5 days late" };
    const { client, create } = fakeClient(toolResponse({ summary: "s", decisions: planWithRules(engine, noted).decisions.map(toRaw) }));
    const { agent: a, onFallback } = agent(client);
    await a.propose(noted);
    expect(onFallback).not.toHaveBeenCalled();
    const params = create.mock.calls[0][0];
    expect(params.model).toBe("claude-sonnet-5-5");
    expect(params.tool_choice).toEqual({ type: "auto" });
    expect(params.system).toBe(SYSTEM_PROMPT);
    expect(SYSTEM_PROMPT).toMatch(/Never sacrifice payroll or required reserves/);
    const msg = String(params.messages[0].content);
    expect(msg).toMatch(/<simulation>/);
    expect(msg).toMatch(/in_acme \(Acme Corp\) moved 5 days late/);
    expect(msg).toMatch(/"ifFunded"/);
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
