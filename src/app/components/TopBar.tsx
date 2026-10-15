"use client";

import { convertAmount } from "@/engine/util";
import { BUSINESS_NAME } from "@/scenarios/crunch";
import { money } from "../lib/format";
import { useStore } from "../lib/store";

const GROUPS = [
  { label: "Savings", kinds: ["savings", "treasuries"] },
  { label: "Investments", kinds: ["brokerage"] },
  { label: "Roth IRA", kinds: ["roth_ira"] },
];

export default function TopBar() {
  const { d, setTab } = useStore();
  const base = d.state.base;
  const chips = GROUPS.map((g) => ({
    label: g.label,
    value: (base.otherAssets ?? []).filter((a) => g.kinds.includes(a.kind)).reduce((s, a) => s + convertAmount(base, a.value, a.currency, base.baseCurrency), 0),
  })).filter((c) => c.value > 0);

  return (
    <header className="topbar">
      <div className="brand">CashPilot</div>
      <div className="biz">{BUSINESS_NAME}</div>
      <div className="sandbox">Airwallex Sandbox · simulated data</div>
      <div className="asset-chips" aria-label="Other assets">
        {chips.map((c) => (
          <button key={c.label} className="asset-chip" onClick={() => setTab("assets")}>
            <span>{c.label}</span>
            <b>{money(c.value, base.baseCurrency)}</b>
          </button>
        ))}
      </div>
      <div className="hint">Double-click anything to ask the AI about it.</div>
    </header>
  );
}
