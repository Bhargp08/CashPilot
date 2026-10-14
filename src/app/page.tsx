import { createBank } from "@/bank";
import { engine } from "@/engine";
import Dashboard from "./components/Dashboard";
import { buildDemoPlan } from "./lib/demoPlan";

export const dynamic = "force-dynamic";

export default async function Page() {
  const state = await createBank().getBusinessState();
  const before = engine.forecast(state, 14);
  const plan = buildDemoPlan(state);
  const audit = engine.buildAudit(state, plan);
  const violations = engine.validate(state, plan.decisions);
  return <Dashboard state={state} before={before} plan={plan} audit={audit} violations={violations} />;
}
