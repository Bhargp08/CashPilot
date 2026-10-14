import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Agent, AgentInput, Engine } from "@/contracts/interfaces";
import type { BusinessState, Decision, Plan } from "@/contracts/types";
import { addDays } from "./format";
import { applyUserNote } from "./note";
import { SUBMIT_TOOL, SYSTEM_PROMPT, userMessage, type PromptContext } from "./prompt";
import { planWithRules, type PlanIdentity } from "./rules";
import { createSimulator, SIM_HORIZON_DAYS, type Simulator } from "./simulator";

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
      return { action: "convert", from: d.from ?? "USD", to: d.to ?? "USD", sellAmount: d.sellAmount ?? 0, reason: d.reason };
    case "escalate":
      need("question");
      return { action: "escalate", ...(d.obligationId ? { obligationId: d.obligationId } : {}), question: d.question ?? "", reason: d.reason };
  }
});

export const submitPlanSchema = z.object({ summary: z.string().min(1), decisions: z.array(decisionSchema).min(1) });

const nullable = (type: string) => ({ type: [type, "null"] });
export const submitPlanTool: Anthropic.Tool = {
  name: SUBMIT_TOOL,
  description:
    "Submit the treasury plan: one decision per obligation in the forecast horizon, plus any conversions, and a short summary for the business owner.",
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
          required: ["action", "obligationId", "from", "to", "sellAmount", "newDate", "question", "reason"],
          properties: {
            action: { type: "string", enum: ["fund", "convert", "defer", "escalate"] },
            obligationId: { ...nullable("string"), description: "Required for fund/defer, optional for escalate, null for convert." },
            from: { ...nullable("string"), description: "convert only: currency to sell." },
            to: { ...nullable("string"), description: "convert only: currency to buy." },
            sellAmount: { ...nullable("integer"), description: "convert only: minor units of `from`. Recomputed by the engine." },
            newDate: { ...nullable("string"), description: "defer only: YYYY-MM-DD, after dueDate and no later than deferrableUntil." },
            question: { ...nullable("string"), description: "escalate only: what the human must decide." },
            reason: { type: "string", description: "Plain English, citing the obligation id, balance, inflow id or policy rule." },
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
    const horizon = Math.max(input.forecast.horizonDays, SIM_HORIZON_DAYS);
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
      noteUnparsed: note.unparsed,
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
          decisions = this.normalise(parsed.data.decisions, sim);
          summary = parsed.data.summary;
          problems = this.check(state, decisions, sim, horizon);
        }
      }
      if (problems.length === 0) {
        return {
          id: this.options.newId?.() ?? `plan_${crypto.randomUUID().slice(0, 8)}`,
          createdAt: (this.options.now?.() ?? new Date()).toISOString(),
          decisions,
          summary,
          resultingForecast: this.engine.forecast(this.engine.applyDecisions(state, decisions), horizon),
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

  /** Conversion amounts are the engine's job: replace the model's converts with the minimal deterministic ones. */
  private normalise(decisions: Decision[], sim: Simulator): Decision[] {
    const rest = decisions.filter((d) => d.action !== "convert");
    return [...sim.planConversions(rest), ...rest];
  }

  private check(state: BusinessState, decisions: Decision[], sim: Simulator, horizon: number): string[] {
    const problems: string[] = [...this.engine.validate(state, decisions)];
    const lastDay = addDays(state.asOf, horizon - 1);
    const decided = new Map<string, Decision>();
    for (const d of decisions) if ("obligationId" in d && d.obligationId) decided.set(d.obligationId, d);

    for (const o of state.obligations) {
      const due = o.dueDate < state.asOf ? state.asOf : o.dueDate;
      const d = decided.get(o.id);
      if (!d && due <= lastDay) problems.push(`${o.id} has no decision; give exactly one`);
      if (o.needsReview && d && d.action !== "escalate") problems.push(`${o.id} has needsReview and must be escalated`);
      if (o.category === "payroll" && d?.action === "defer") problems.push(`${o.id} is payroll and must never be deferred`);
    }

    for (const d of decisions) {
      if (d.action !== "convert" && "obligationId" in d && d.obligationId && !d.reason.includes(d.obligationId)) {
        problems.push(`the reason for ${d.action} ${d.obligationId} must cite ${d.obligationId}`);
      }
    }

    // What-if check on each payment decision, with every other decision in place.
    if (problems.length === 0) {
      decisions.forEach((d, i) => {
        if (d.action !== "fund" && d.action !== "defer") return;
        const others = decisions.filter((_, j) => j !== i);
        const r = sim.simulate(others, d);
        for (const risk of r.risks) problems.push(`${d.action} ${d.obligationId} is unsafe: ${risk.message}`);
      });
    }
    return [...new Set(problems)];
  }
}
