import { createBank } from "@/bank";
import Dashboard from "./components/Dashboard";
import { buildDemoPlan } from "./lib/demoPlan";

export const dynamic = "force-dynamic";

export default async function Page() {
  const state = await createBank().getBusinessState();
  return <Dashboard state={state} plan={buildDemoPlan(state)} />;
}
