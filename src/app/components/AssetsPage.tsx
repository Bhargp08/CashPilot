"use client";

import type { BusinessState } from "@/contracts/types";
import { convertAmount } from "@/engine/util";
import { money } from "../lib/format";

const GROUPS = [
  { title: "Savings and investments", kinds: ["savings", "treasuries", "brokerage"], color: "var(--convert)" },
  { title: "Retirement", kinds: ["roth_ira"], color: "var(--escalate)" },
] as const;

export default function AssetsPage({ state, onMove }: { state: BusinessState; onMove: () => void }) {
  const base = state.baseCurrency;
  const cash = state.balances.reduce((s, b) => s + convertAmount(state, b.available, b.currency, base), 0);
  const assets = state.otherAssets ?? [];
  const val = (v: number, c: Parameters<typeof convertAmount>[2]) => convertAmount(state, v, c, base);
  const total = cash + assets.reduce((s, a) => s + val(a.value, a.currency), 0);
  const parts = [
    { label: "Business cash", v: cash, color: "var(--up)" },
    ...GROUPS.map((g) => ({ label: g.title, v: assets.filter((a) => (g.kinds as readonly string[]).includes(a.kind)).reduce((s, a) => s + val(a.value, a.currency), 0), color: g.color })),
  ];

  return (
    <div className="page">
      <section className="hero">
        <div className="hero-label">All your money</div>
        <div className="hero-num">{money(total, base)}</div>
        <div className="hero-delta">
          <span className="hero-when">{money(cash, base)} is in the business and ready to spend</span>
        </div>
      </section>

      <div className="alloc" role="img" aria-label="Where your money is">
        {parts.map((p) => (
          <i key={p.label} style={{ width: `${(p.v / total) * 100}%`, background: p.color }} title={`${p.label}: ${money(p.v, base)}`} />
        ))}
      </div>
      <div className="alloc-legend">
        {parts.map((p) => (
          <span key={p.label}><i style={{ background: p.color }} /> {p.label} {Math.round((p.v / total) * 100)}%</span>
        ))}
      </div>

      <section>
        <h2>Business accounts</h2>
        <ul className="list">
          {state.balances.map((b) => (
            <li key={b.accountId}>
              <div className="row static">
                <span className="ico">{b.currency}</span>
                <span className="r-main"><b>{b.currency} account</b><small>Spendable now</small></span>
                <span className="r-end"><b>{money(b.available, b.currency)}</b></span>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {GROUPS.map((g) => {
        const items = assets.filter((a) => (g.kinds as readonly string[]).includes(a.kind));
        if (!items.length) return null;
        return (
          <section key={g.title}>
            <h2>{g.title}</h2>
            <ul className="list">
              {items.map((a) => (
                <li key={a.id}>
                  <div className="row static">
                    <span className="ico" style={{ background: g.color, color: "var(--on-ink)" }}>{a.name[0]}</span>
                    <span className="r-main">
                      <b>{a.name}</b>
                      <small>{a.daysToCash === 1 ? "Next day" : `${a.daysToCash} days`} to reach your account · {a.costNote}</small>
                    </span>
                    <span className="r-end">
                      <b>{money(a.value, a.currency)}</b>
                      {a.restricted && <span className="tag" style={{ ["--c" as string]: "var(--escalate)" }}>Last resort</span>}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      <p className="note">
        CashPilot only reads these balances. It can propose moving money out of them, but nothing moves without your approval.
      </p>
      <button className="btn primary" onClick={onMove}>See ways to move money</button>
    </div>
  );
}
