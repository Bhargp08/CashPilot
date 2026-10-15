"use client";

import { useMemo, useState } from "react";
import type { BusinessState } from "@/contracts/types";
import { fundingOptions } from "@/engine";
import { money, shortDate } from "../lib/format";

interface Props {
  state: BusinessState;
  need: number; // gap to the reserve floor after the current plan, minor units
  needBy: string;
  amount: number;
  by: string;
  setTarget: (amount: number, by: string) => void;
  transfers: Record<string, number>;
  onTransfer: (assetId: string, amount: number | null) => void;
  chips: { label: string; amount: number; by: string }[];
  lowestAfter: number;
}

export default function MovePage({ state, need, needBy, amount, by, setTarget, transfers, onTransfer, chips, lowestAfter }: Props) {
  const cur = state.policy.reserveFloor.currency;
  const [draft, setDraft] = useState(String(Math.round(amount / 100)));
  const a = useMemo(() => fundingOptions(state, amount, by), [state, amount, by]);
  const inMix = new Set(a.mix.map((o) => o.assetId));
  const allAdded = a.mix.length > 0 && a.mix.every((o) => transfers[o.assetId] === o.amount);
  const quick = [...(need > 0 ? [{ label: `Cover the ${money(need, cur)} gap`, amount: need, by: needBy }] : []), ...chips];

  function commit(v: string) {
    const n = Math.max(0, Math.round(Number(v.replace(/[^0-9.]/g, "")) * 100));
    setTarget(n, by);
  }

  return (
    <div className="page">
      <section className="hero">
        <div className="hero-label">Money to move into your {cur} account</div>
        <div className="amount-in">
          <span>{cur === "USD" ? "$" : ""}</span>
          <input
            inputMode="numeric"
            aria-label="Amount to move"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => commit(draft)}
            onKeyDown={(e) => e.key === "Enter" && (e.currentTarget.blur())}
          />
        </div>
        <div className="hero-delta"><span className="hero-when">needed by {shortDate(by)}</span></div>
        <div className="chips left">
          {quick.map((q) => (
            <button key={q.label} className="chip" onClick={() => { setDraft(String(Math.round(q.amount / 100))); setTarget(q.amount, q.by); }}>{q.label}</button>
          ))}
        </div>
      </section>

      {amount === 0 ? (
        <p className="empty">Nothing needs funding right now. Enter an amount, or pick one above, to see where the money could come from.</p>
      ) : (
        <>
          <section className="mixcard" aria-label="Recommended mix">
            <div className="mix-head">
              <div>
                <div className="hero-label">Cheapest way to get {money(amount, cur)}</div>
                <div className="mix-main">
                  {a.mix.map((o) => `${money(o.amount, cur)} from ${o.name}`).join(" + ") || "Not enough in your other accounts"}
                </div>
                <div className="why">
                  Total cost {money(a.mixCost, cur)}
                  {a.mix.length > 0 && ` · arrives by ${shortDate(a.mix.reduce((m, o) => (o.arrivesBy > m ? o.arrivesBy : m), a.mix[0].arrivesBy))}`}
                  {!a.mixCoversNeed && ` · still ${money(amount - a.mix.reduce((s, o) => s + o.amount, 0), cur)} short`}
                </div>
                <div className="why">Lowest {cur} balance with your plan and transfers: {money(lowestAfter, cur)}</div>
              </div>
              <button
                className={`btn ${allAdded ? "" : "primary"}`}
                onClick={() => a.mix.forEach((o) => onTransfer(o.assetId, allAdded ? null : o.amount))}
                disabled={a.mix.length === 0}
              >
                {allAdded ? "Remove from plan" : "Add to plan"}
              </button>
            </div>
          </section>

          <section aria-label="All sources">
            <h2>Every option</h2>
            <ul className="list">
              {a.options.map((o) => {
                const added = transfers[o.assetId] === o.amount;
                return (
                  <li key={o.assetId}>
                    <div className="row static opt">
                      <span className="ico" style={{ background: o.restricted ? "var(--escalate)" : "var(--surface)", color: o.restricted ? "var(--on-ink)" : "var(--ink)" }}>{o.name[0]}</span>
                      <span className="r-main">
                        <b>{o.name}</b>
                        <small>
                          Move {money(o.amount, cur)} · arrives {shortDate(o.arrivesBy)} · cost {money(o.cost, cur)}
                        </small>
                        <small className="why">{o.costNote}</small>
                      </span>
                      <span className="r-end">
                        {inMix.has(o.assetId) && <span className="tag" style={{ ["--c" as string]: "var(--up)" }}>Recommended</span>}
                        {!o.inTime && <span className="tag" style={{ ["--c" as string]: "var(--down)" }}>Arrives too late</span>}
                        {o.restricted && <span className="tag" style={{ ["--c" as string]: "var(--escalate)" }}>Last resort</span>}
                        {!o.coversNeed && <span className="tag" style={{ ["--c" as string]: "var(--muted)" }}>Covers part</span>}
                        <button className="btn small" onClick={() => onTransfer(o.assetId, added ? null : o.amount)}>{added ? "Added · Undo" : "Add"}</button>
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        </>
      )}

      <p className="note">
        These are proposals. Nothing moves until you approve it, and retirement money is only suggested when nothing else can cover the gap in time.
      </p>
    </div>
  );
}
