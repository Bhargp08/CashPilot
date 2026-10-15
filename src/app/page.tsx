import { createBank } from "@/bank";
import AppShell from "./components/AppShell";

export const dynamic = "force-dynamic";

export default async function Page() {
  const state = await createBank().getBusinessState();
  return <AppShell state={state} />;
}
