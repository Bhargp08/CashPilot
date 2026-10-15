import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Agent, AgentInput, Engine } from "@/contracts/interfaces";
import type { BusinessState, Decision, Plan } from "@/contracts/types";
import { addDays, effectiveDate } from "./format";
import { applyUserNote } from "./note";
import { SUBMIT_TOOL, SYSTEM_PROMPT, userMessage, type PromptContext } from "./prompt";
import { explainer, newPlanId, overLimit, planWithRules, PLAN_HORIZON_DAYS, resultingForecast, type PlanIdentity } from "./rules";
import { createSimulator, type Simulator } from "./simulator";

export const DEFAULT_MODEL = "claude-sonnet-5-5";

/** The slice of the SDK this agent uses, so tests can pass a fake. */
export interface MessagesClient {
  messages: { create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> };
}

const currency = z.enum(["USD", "EUR", "GBP", "AUD", "SGD"]);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// Flat shape on the wire (strict tool schemas cannot express the union cleanly); narrowed per action below.
const rawDecision = z.object({
  action: z.enum(["fund", "convert", "defer", "escalate"]),
  obligationId: z.string().min(1).nullable(),
  from: currency.nullable(),
  to: currency.nullable(),
  sellAmount: z.number().int().positive().nullable(),
  newDate: isoDate.nullable(),
  executeOn: isoDate.nullable(),
  question: z.string().min(1).nullable(),
  reason: z.string().min(1),
});

const decisionSchema = rawDecision.transform((d, ctx): Decision => {
  const need = (field: keyof typeof d) => {
    if (d[field] === null) ctx.addIssue({ code: "custom", message: `${d.action} requires ${field}`, path: [field] });
  };
  switch (d.action) {
    case "fund":
      need("obligationId");
      return { action: "fund", obligationId: d.obligationId ?? "", reason: d.reason };
    case "defer":
      need("obligationId");
      need("newDate");
      return { action: "defer", obligationId: d.obligationId ?? "", newDate: d.newDate ?? "", reason: d.reason };
    case "convert":
      need("from");
      need("to");
      need("sellAmount");
      return { action: "convert", from: d.from ?? "USD", to: d.to ?? "USD", sellAmount: d.sellAmount ?? 0, ...(d.executeOn ? { executeOn: d.executeOn } : {}), reason: d.reason };
    case "escalate":
      need("question");
      return { action: "escalate", ...(d.obligationId ? { obligationId: d.obligationId } : {}), question: d.question ?? "", reason: d.reason };
  }
});

export const submitPlanSchema = z.object({ summary: z.string().min(1), decisions: z.array(decisionSchema) });

const nullable = (type: string) => ({ type: [type, "null"] });
export const submitPlanTool: Anthropic.Tool = {
  name: SUBMIT_TOOL,
  description:
    "Submit the treasury plan: at most one decision per obligation (no decision = paid as scheduled), plus any conversions, and a 1-2 sentence summary for the business owner.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["summary", "decisions"],
    properties: {
      summary: { type: "string", description: "Two to four sentences for the owner. Cite ids and amounts from the data only." },
      decisions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["action", "obligationId", "from", "to", "sellAmount", "newDate", "executeOn", "question", "reason"],
          properties: {
            action: { type: "string", enum: ["fund", "convert", "defer", "escalate"] },
            obligationId: { ...nullable("string"), description: "Required for fund/defer, optional for escalate, null for convert." },
            from: { ...nullable("string"), description: "convert only: currency to sell." },
            to: { ...nullable("string"), description: "convert only: currency to buy." },
            sellAmount: { ...nullable("integer"), description: "convert only: minor units of `from`. Recomputed by the engine." },
            newDate: { ...nullable("string"), description: "defer only: YYYY-MM-DD, after dueDate and no later than deferrableUntil." },
            executeOn: { ...nullable("string"), description: "convert only: YYYY-MM-DD, the day before the money is first needed." },
            question: { ...nullable("string"), description: "escalate only: what the human must decide." },
            reason: { type: "string", description: "One plain-English sentence naming the payee and citing real figures. No ids." },
          },
        },
      },
    },
  },
};

export interface ClaudeAgentOptions extends PlanIdentity {
  client?: MessagesClient;
  model?: string;
  maxTokens?: number;
  /** Called when the agent falls back to rules; defaults to console.warn. */
  onFallback?: (why: string[]) => void;
}

/**
 * LLM agent. Claude proposes decisions through a strict tool call; our code validates them with zod,
 * recomputes conversions, checks them with Engine.validate and the simulator, retries once with the
 * problems fed back, and otherwise falls back to the rules agent.
 */
export class ClaudeAgent implements Agent {
  private readonly client: MessagesClient;
  private readonly model: string;

  constructor(
    private readonly engine: Engine,
    private readonly options: ClaudeAgentOptions = {},
  ) {
    this.client = options.client ?? new Anthropic();
    this.model = options.model ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL;
  }

  async propose(input: AgentInput): Promise<Plan> {
    const reference = planWithRules(this.engine, input, this.options);
    const horizon = PLAN_HORIZON_DAYS;
    const note = applyUserNote(input.state, input.userNote);
    const state = note.state;
    const forecast = note.adjustments.length > 0 ? this.engine.forecast(state, horizon) : input.forecast;
    const sim = createSimulator(state, this.engine, horizon);
    const ctx: PromptContext = {
      state,
      forecast,
      sim,
      userNote: input.userNote,
      noteAdjustments: note.adjustments,
      referencePlan: reference.decisions,
    };

    const messages: Anthropic.MessageParam[] = [{ role: "user", content: userMessage(ctx) }];
    let problems: string[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      let response: Anthropic.Message;
      try {
        response = await this.client.messages.create({
          model: this.model,
          max_tokens: this.options.maxTokens ?? 16000,
          system: SYSTEM_PROMPT,
          tools: [submitPlanTool],
          tool_choice: { type: "auto" },
          messages,
        });
      } catch (err) {
        problems = [`Anthropic API error: ${err instanceof Error ? err.message : String(err)}`];
        break;
      }

      const toolUse = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === SUBMIT_TOOL);
      if (response.stop_reason === "refusal") {
        problems = ["the model declined the request"];
        break;
      }
      problems = toolUse ? [] : [`no ${SUBMIT_TOOL} tool call in the response (stop_reason ${response.stop_reason})`];
      let decisions: Decision[] = [];
      let summary = "";
      if (toolUse) {
        const parsed = submitPlanSchema.safeParse(toolUse.input);
        if (!parsed.success) problems = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`);
        else {
          decisions = this.normalise(state, parsed.data.decisions, sim);
          summary = parsed.data.summary;
          problems = this.check(state, decisions, sim, horizon);
        }
      }
      if (problems.length === 0) {
        return {
          id: this.options.newId?.() ?? newPlanId(),
          createdAt: (this.options.now?.() ?? new Date()).toISOString(),
          decisions,
          summary,
          resultingForecast: resultingForecast(this.engine, state, decisions),
        };
      }

      const feedback = `Your plan was rejected by the deterministic checks. Fix every problem and call ${SUBMIT_TOOL} again:\n- ${problems.join("\n- ")}`;
      messages.push({ role: "assistant", content: response.content });
      messages.push(
        toolUse
          ? { role: "user", content: [{ type: "tool_result", tool_use_id: toolUse.id, is_error: true, content: feedback }] }
          : { role: "user", content: feedback },
      );
    }

    (this.options.onFallback ?? ((why) => console.warn(`[agent] Claude plan rejected, using rules agent: ${why.join("; ")}`)))(problems);
    return reference;
  }

  /** Conversion amounts are the engine's job: replace the model's converts with the deterministic ones and their reasons. */
  private normalise(state: BusinessState, decisions: Decision[], sim: Simulator): Decision[] {
    const rest = decisions.filter((d) => d.action !== "convert");
    const converts = sim.planConversions(rest);
    const all = [...converts, ...rest];
    const explain = explainer(this.engine, state, all, sim);
    return all.map((d) => (d.action === "convert" ? { ...d, reason: explain.reason(d) } : d));
  }

  private check(state: BusinessState, decisions: Decision[], sim: Simulator, horizon: number): string[] {
    const problems: string[] = [...this.engine.validate(state, decisions)];
    const lastDay = addDays(state.asOf, horizon - 1);
    const decided = new Map<string, Decision>();
    for (const d of decisions) if ("obligationId" in d && d.obligationId) decided.set(d.obligationId, d);

    for (const o of state.obligations) {
      const d = decided.get(o.id);
      const inHorizon = effectiveDate(o.dueDate, state.asOf) <= lastDay;
      if (o.needsReview && inHorizon && d?.action !== "escalate") problems.push(`${o.id} (${o.payee}) has needsReview and must be escalated`);
      if (o.category === "payroll" && d?.action === "defer") problems.push(`${o.id} (${o.payee}) is payroll and must never be deferred`);
      if (inHorizon && !d && overLimit(state, o)) problems.push(`${o.id} (${o.payee}) is above policy.escalateAbove and must be escalated`);
      if (d && d.action !== "convert" && !d.reason.toLowerCase().includes(o.payee.toLowerCase())) problems.push(`the reason for ${d.action} ${o.id} must name the payee "${o.payee}"`);
    }

    // What-if check: a priority 3-or-lower payment that is only safe because of an uncertain inflow must be escalated.
    if (problems.length === 0) {
      for (const o of state.obligations) {
        const d = decided.get(o.id);
        if (o.priority > 3 || (d && d.action !== "fund") || effectiveDate(o.dueDate, state.asOf) > lastDay) continue;
        const others = decisions.filter((x) => !("obligationId" in x && x.obligationId === o.id));
        const r = sim.simulate(others, { action: "fund", obligationId: o.id, reason: "" }, { mode: "plan" });
        for (const risk of r.risks) problems.push(`paying ${o.id} (${o.payee}) is unsafe: ${risk.message}`);
      }
    }
    return [...new Set(problems)];
  }
}
