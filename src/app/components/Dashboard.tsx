"use client";

import { useState } from "react";
import type { AuditEntry, BusinessState, Decision, Forecast, Plan } from "@/contracts/types";
import { money, shortDate } from "../lib/format";
import Timeline, { VerbGlyph, type Marker, type Verb } from "./Timeline";

interface Props {
  state: BusinessState;
  before: Forecast;
  plan: Plan;
  audit: AuditEntry[];
  violations: string[];
}

const VERB_LABEL: Record<Verb, string> = { fund: "Pay", convert: "Convert", defer: "Move", escalate: "Your call" };

export default function Dashboard({ state, before, plan, audit, violations }: Props) {
  const [showPlan, setShowPlan] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [resolved, setResolved] = useState<Record<string, "approved" | "rejected">>({});

  const floorCur = state.policy.reserveFloor.currency;
  const ob = (id?: string) => state.obligations.find((o) => o.id === id);

  const items = plan.decisions.map((d, i) => {
        const o = "obligationId" in d ? ob(d.obligationId) : undefined;
        let title = "";
        let date: string = state.asOf;
        if (d.action === "fund") {
          title = `Pay ${o?.payee} ${o ? money(o.amount, o.currency) : ""}`;
          date = o?.dueDate ?? date;
        } else if (d.action === "convert") {
          title = `Convert ${money(d.sellAmount, d.from)} to ${d.to}`;
        } else if (d.action === "defer") {
          title = `Move ${o?.payee} to ${shortDate(d.newDate)}`;
          date = d.newDate;
        } else {
          title = `Ask you about ${o?.payee ?? "this payment"}`;
          date = o?.dueDate ?? date;
        }
        return { id: `d${i}`, i, d, title, date, verb: d.action as Verb, o };
      });

  const markers: Marker[] = items.map((x) => ({ id: x.id, date: x.date, verb: x.verb, label: x.title }));
  const first = before.shortfalls[0];
  const escalations = items.filter((x) => x.verb === "escalate");
  const counts = (v: Verb) => items.filter((x) => x.verb === v).length;
  const open = escalations.filter((e) => !resolved[e.id]).length;

  return (
    <main className="shell">
      <header className="top">
        <div className="brand">CashPilot</div>
        <div className="asof">Demo business · cash as of {shortDate(state.asOf)}</div>
      </header>

      <section className="verdict">
        <h1>
          {first
            ? `${money(first.gap, first.currency)} short on ${shortDate(first.date)}: ${ob(first.blockedObligationIds[0])?.payee ?? "a bill"} can't be paid from the ${first.currency} account${first.coveredByOtherCurrencies ? ", but the money exists in another currency." : "."}`
            : "Cash covers every payment in the next 14 days."}
        </h1>
        <p>
          The plan converts {counts("convert")} balance, pays {counts("fund")} bill, moves {counts("defer")} to later dates and needs
          your decision on {counts("escalate")}.
        </p>
        {violations.length > 0 && (
          <p className="alert" role="alert">
            This plan breaks your policy: {violations.join(" ")}
          </p>
        )}
      </section>

      <section className="chart" aria-label="Cash timeline">
        <div className="chart-head">
          <h2>Next 14 days</h2>
          <label className="toggle">
            <input type="checkbox" checked={showPlan} onChange={(e) => setShowPlan(e.target.checked)} />
            Show the plan
          </label>
        </div>
        <Timeline
          currency={floorCur}
          floor={state.policy.reserveFloor.amount}
          before={before.days}
          after={plan.resultingForecast.days}
          markers={markers}
          selectedId={selected}
          onSelect={setSelected}
          showPlan={showPlan}
        />
      </section>

      <div className="cols">
        <section aria-label="Plan">
          <h2>What CashPilot will do</h2>
          <ol className="steps">
            {items
              .filter((x) => x.verb !== "escalate")
              .map((x) => {
                const a = audit[x.i];
                return (
                  <li key={x.id} className={`step ${selected === x.id ? "on" : ""}`} style={{ ["--c" as string]: `var(--${x.verb})` }} onClick={() => setSelected(selected === x.id ? null : x.id)}>
                    <div className="step-head">
                      <VerbGlyph verb={x.verb} />
                      <span className="verb">{VERB_LABEL[x.verb]}</span>
                      <span className="when">{shortDate(x.date)}</span>
                    </div>
                    <div className="step-title">{x.title}</div>
                    <p>{x.d.reason}</p>
                    <details onClick={(e) => e.stopPropagation()}>
                      <summary>What this is based on</summary>
                      <ul className="based">
                        {a.basedOn.obligationIds.map((id) => <li key={id}>Bill: {ob(id)?.payee}</li>)}
                        {a.basedOn.balanceAccountIds.map((id) => <li key={id}>Account: {id.replace("acc_", "").toUpperCase()}</li>)}
                        {a.basedOn.policyRules.map((r) => <li key={r}>Policy: {r}</li>)}
                        {a.policyViolations.length === 0 && <li>Passes all policy checks</li>}
                      </ul>
                    </details>
                  </li>
                );
              })}
          </ol>
        </section>

        <section aria-label="Needs your decision">
          <h2>
            Needs your call {open > 0 && <span className="count">{open}</span>}
          </h2>
          {escalations.length === 0 && <p className="empty">Nothing needs a human right now.</p>}
          <ul className="asks">
            {escalations.map((x) => {
              const d = x.d as Extract<Decision, { action: "escalate" }>;
              const r = resolved[x.id];
              return (
                <li key={x.id} className={`ask ${selected === x.id ? "on" : ""}`} onClick={() => setSelected(selected === x.id ? null : x.id)}>
                  <div className="step-head">
                    <VerbGlyph verb="escalate" />
                    <span className="verb">{x.o?.payee}</span>
                    <span className="when">{x.o ? money(x.o.amount, x.o.currency) : ""} due {x.o ? shortDate(x.o.dueDate) : ""}</span>
                  </div>
                  <div className="step-title">{d.question}</div>
                  <p>{d.reason}</p>
                  {r ? (
                    <div className="resolved">
                      {r === "approved" ? "Approved. This will be paid when the payment step is connected." : "Rejected. This stays unpaid."}{" "}
                      <button className="link" onClick={(e) => { e.stopPropagation(); setResolved((s) => { const n = { ...s }; delete n[x.id]; return n; }); }}>
                        Undo
                      </button>
                    </div>
                  ) : (
                    <div className="actions">
                      <button className="btn" onClick={(e) => { e.stopPropagation(); setResolved((s) => ({ ...s, [x.id]: "approved" })); }}>Approve payment</button>
                      <button className="btn ghost" onClick={(e) => { e.stopPropagation(); setResolved((s) => ({ ...s, [x.id]: "rejected" })); }}>Reject</button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>

          <h2 className="policy-h">Your rules</h2>
          <dl className="policy">
            <div><dt>Keep at least</dt><dd>{money(state.policy.reserveFloor.amount, state.policy.reserveFloor.currency)} in {state.policy.reserveFloor.currency}</dd></div>
            <div><dt>Never move</dt><dd>{state.policy.neverAutoDefer.join(", ")}</dd></div>
            <div><dt>Ask me above</dt><dd>{money(state.policy.escalateAbove.amount, state.policy.escalateAbove.currency)}</dd></div>
            <div><dt>Max currency fee</dt><dd>{(state.policy.maxFxSpreadBps / 100).toFixed(2)}%</dd></div>
          </dl>
        </section>
      </div>
    </main>
  );
}
