# CashPilot: rules for every LLM working in this repo

Adaptive treasury controller for the Airwallex Agentic Banking Hackathon (Kit 01). It forecasts cash, finds shortfalls, and decides to fund / convert / defer / escalate, with a human in the loop.

## Ground rules
- `src/contracts/` is the shared contract. Do not edit it on your branch. Need a change? Say so in your PR description and ask Bharg.
- Stay inside your own folder (table below). Cross-folder imports go through `src/contracts/` only.
- Money is integer minor units. Dates are `YYYY-MM-DD`. No floats for money.
- The LLM never invents financial numbers. All math lives in `src/engine/` (pure, unit-tested).
- Every plan must pass `Engine.validate` before anything executes. Escalated items never auto-execute.
- Secrets live in `.env.local` only. Never commit or print keys. Default to `BANK_MODE=mock`.
- One branch per workstream, PR into `main`. Keep `npm run build` and `npm run lint` green.

## Workstreams
| Branch | Folder | Owner | Deliverable |
|---|---|---|---|
| `feat/engine` | `src/engine/`, `src/bank/mock.ts` | Bharg (Claude Code) | `Engine` (forecast, applyDecisions, validate, buildAudit) with tests, plus the mock `BankAdapter` serving `crunchScenario` |
| `feat/agent` | `src/agent/` | Jai (Claude Code) | `Agent`: Claude structured-output decisions with an offline rules fallback, executor, escalation queue |
| `feat/ui` | `src/app/` | TBD once engine + agent land | Dashboard, timeline, decision cards, escalation approve/reject, on mock data |
| later | `src/bank/airwallex.ts` | Codex, later | Real Airwallex sandbox adapter behind the same `BankAdapter` interface |

## Seed data
`src/scenarios/crunch.ts` is the demo scenario (about $18k vs about $32k due in 72 hours). Use it for tests and the mock adapter.
