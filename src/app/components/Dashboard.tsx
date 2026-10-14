"use client";

import { useMemo, useState } from "react";
import type { BusinessState, Currency, Decision, Plan } from "@/contracts/types";
import { engine, neededFunding, transferInflow } from "@/engine";
import { addDays, convertAmount } from "@/engine/util";
import type { Effect } from "../lib/assistant";
import { humanize, money, shortDate } from "../lib/format";
import AssetsPage from "./AssetsPage";
import Chat from "./Chat";
import MovePage from "./MovePage";
import TopBar, { type Page } from "./TopBar";
import Timeline, { VerbGlyph, type Marker, type Verb } from "./Timeline";

type Tab = Currency | "Total";
const HORIZON = 14;

export default function Dashboard({ state: base, plan }: { state: BusinessState; plan: Plan }) {
  const [showPlan, setShowPlan] = useState(true);
  const [tab, setTab] = useState<Tab>(base.policy.reserveFloor.currency);
  const [hover, setHover] = useState<number | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [resolved, setResolved] = useState<Record<string, "approved" | "rejected">>({});
  const [delays, setDelays] = useState<Record<string, number>>({});
  const [page, setPage] = useState<Page>("overview");
  const [transfers, setTransfers] = useState<Record<string, number>>({});
  const [target, setTarget] = useState<{ amount: number; by: string } | null>(null);

  const scenario = useMemo(() => {
    const s = structuredClone(base);
    for (const i of s.inflows) if (delays[i.id]) i.expectedDate = addDays(i.expectedDate, delays[i.id]);
    return s;
  }, [base, delays]);

  const { before, after, violations, need, lowestAfter } = useMemo(() => {
    const planned = plan.decisions.filter((d) => !(d.action === "escalate" && d.obligationId && resolved[d.obligationId] === "approved"));
    const planState = engine.applyDecisions(scenario, planned);
    const withTransfers = {
      ...planState,
      inflows: [...planState.inflows, ...Object.entries(transfers).map(([id, amt]) => transferInflow(scenario, id, amt)).filter((i) => i !== null)],
    };
    const cur = scenario.policy.reserveFloor.currency;
    const afterFc = engine.forecast(withTransfers, HORIZON);
    return {
      before: engine.forecast(scenario, HORIZON),
      after: afterFc,
      violations: engine.validate(scenario, plan.decisions),
      need: neededFunding(scenario, engine.forecast(planState, HORIZON).days),
      lowestAfter: Math.min(...afterFc.days.map((d) => d.balances[cur] ?? 0)),
    };
  }, [scenario, plan, resolved, transfers]);

  const floorCur = base.policy.reserveFloor.currency;
  const currencies = Array.from(new Set(base.balances.map((b) => b.currency)));
  const series = (days: typeof before.days) => days.map((d) => (tab === "Total" ? d.totalInBase : (d.balances[tab] ?? 0)));
  const dates = before.days.map((d) => d.date);
  const b = series(before.days);
  const a = series(after.days);
  const unit: Currency = tab === "Total" ? base.baseCurrency : tab;
  const idx = hover ?? 0;
  const lead = showPlan ? a : b;
  const delta = lead[idx] - lead[0];
  const first = before.shortfalls[0];
  const ob = (id?: string) => scenario.obligations.find((o) => o.id === id) ?? base.obligations.find((o) => o.id === id);

  const decisionOf = (id: string): Decision | undefined => plan.decisions.find((d) => "obligationId" in d && d.obligationId === id);
  const title = (d: Decision) => {
    const o = "obligationId" in d ? ob(d.obligationId) : undefined;
    if (d.action === "convert") return `Convert ${money(d.sellAmount, d.from)} to ${d.to}`;
    if (d.action === "fund") return `Pay ${o?.payee}`;
    if (d.action === "defer") return `Move ${o?.payee} to ${shortDate(d.newDate)}`;
    return `Ask you about ${o?.payee}`;
  };
  const dateOf = (d: Decision) => {
    if (d.action === "convert") return base.asOf;
    if (d.action === "defer") return d.newDate;
    return ob(d.obligationId)?.dueDate ?? base.asOf;
  };
  const markers: Marker[] = plan.decisions.map((d, i) => ({ id: `d${i}`, date: dateOf(d), verb: d.action as Verb, label: title(d) }));
  const markerId = (d: Decision) => `d${plan.decisions.indexOf(d)}`;

  const rows = [
    ...base.obligations.map((o) => ({ kind: "out" as const, id: o.id, date: o.dueDate, name: o.payee, sub: o.category[0].toUpperCase() + o.category.slice(1), amount: o.amount, cur: o.currency })),
    ...scenario.inflows.map((i) => ({ kind: "in" as const, id: i.id, date: i.expectedDate, name: i.payer, sub: `${Math.round(i.confidence * 100)}% likely${delays[i.id] ? `, ${delays[i.id]} days late` : ""}`, amount: i.amount, cur: i.currency })),
  ].sort((x, y) => x.date.localeCompare(y.date));

  function apply(e: Effect) {
    if (e.type === "reset") setDelays({});
    else if (e.type === "delay") setDelays((d) => ({ ...d, [e.inflowId]: e.days }));
    else if (e.type === "navigate") {
      setPage(e.page);
      if (e.amount != null && e.by) setTarget({ amount: e.amount, by: e.by });
    } else if (e.type === "transfer") {
      setTransfers((t) => ({ ...t, [e.assetId]: e.amount }));
      setTarget({ amount: e.amount, by: e.by });
      setPage("move");
    } else setResolved((r) => ({ ...r, [e.obligationId]: e.status }));
  }

  const asks = plan.decisions.filter((d): d is Extract<Decision, { action: "escalate" }> => d.action === "escalate");
  const pending = asks.filter((d) => d.obligationId && !resolved[d.obligationId]).length;
  const ctx = { state: scenario, baseState: base, plan, resolved };
  const cur0 = base.policy.reserveFloor.currency;
  const askChips = asks
    .map((d) => ob(d.obligationId))
    .filter((o): o is NonNullable<typeof o> => !!o)
    .map((o) => ({ label: `Pay ${o.payee} on time`, amount: convertAmount(base, o.amount, o.currency, cur0), by: o.dueDate }));
  const moveTarget = target ?? (need.need > 0 ? { amount: need.need, by: need.by } : { amount: 0, by: base.asOf });
  const otherAssets = base.otherAssets ?? [];
  const cashTotal = base.balances.reduce((sum, bal) => sum + convertAmount(base, bal.available, bal.currency, base.baseCurrency), 0);
  const chipsTop = [
    { id: "sav", label: "Savings", kinds: ["savings", "treasuries"] },
    { id: "inv", label: "Investments", kinds: ["brokerage"] },
    { id: "ret", label: "Roth IRA", kinds: ["roth_ira"] },
  ]
    .map((g) => ({ id: g.id, label: g.label, value: otherAssets.filter((x) => g.kinds.includes(x.kind)).reduce((sum, x) => sum + convertAmount(base, x.value, x.currency, base.baseCurrency), 0) }))
    .filter((g) => g.value > 0);
  const intro = first
    ? `${money(first.gap, first.currency)} short on ${shortDate(first.date)}. I have a plan: ${plan.summary} ${pending} item${pending === 1 ? "" : "s"} need${pending === 1 ? "s" : ""} your call.`
    : "Cash covers everything in the next 14 days.";

  return (
    <div className="app">
      <TopBar page={page} onPage={setPage} cash={cashTotal} chips={chipsTop} currency={base.baseCurrency} moveBadge={need.need} asOf={shortDate(base.asOf)} />
      <div className="body">
      <main className="main">
        {page === "assets" && <AssetsPage state={scenario} onMove={() => setPage("move")} />}
        {page === "move" && (
          <MovePage
            key={`${moveTarget.amount}-${moveTarget.by}`}
            state={scenario}
            need={need.need}
            needBy={need.by}
            amount={moveTarget.amount}
            by={moveTarget.by}
            setTarget={(amount, by) => setTarget({ amount, by })}
            transfers={transfers}
            onTransfer={(id, amt) => setTransfers((t) => { const n = { ...t }; if (amt == null) delete n[id]; else n[id] = amt; return n; })}
            chips={askChips}
            lowestAfter={lowestAfter}
          />
        )}
        {page === "overview" && (<>
        <section className="hero">
          <div className="hero-label">{tab === "Total" ? `Total cash (${unit})` : `${unit} available`}</div>
          <div className="hero-num">{money(lead[idx], unit)}</div>
          <div className={`hero-delta ${delta < 0 ? "down" : delta > 0 ? "up" : ""}`}>
            {delta === 0 ? "Today" : `${delta < 0 ? "▼" : "▲"} ${money(Math.abs(delta), unit)}`}
            <span className="hero-when"> {idx === 0 ? "" : `by ${shortDate(dates[idx])}`}</span>
          </div>
          {first && (
            <div className={`pill ${showPlan && violations.length === 0 ? "ok" : "bad"}`} role="status">
              {showPlan && violations.length === 0
                ? `Plan covers the ${money(first.gap, first.currency)} gap on ${shortDate(first.date)}`
                : violations.length
                  ? `Plan needs a re-plan: ${humanize(violations[0])}`
                  : `Short ${money(first.gap, first.currency)} on ${shortDate(first.date)} with no action`}
            </div>
          )}
        </section>

        <section className="chart" aria-label="Cash timeline">
          <Timeline
            dates={dates}
            before={b}
            after={a}
            currency={unit}
            floor={tab === floorCur ? base.policy.reserveFloor.amount : null}
            markers={markers}
            showPlan={showPlan}
            idx={idx}
            onHover={setHover}
            selectedId={selected}
            onSelect={setSelected}
          />
          <div className="range">
            <div className="tabs" role="tablist">
              {[...currencies, "Total" as const].map((c) => (
                <button key={c} role="tab" aria-selected={tab === c} className={tab === c ? "on" : ""} onClick={() => setTab(c)}>
                  {c}
                </button>
              ))}
            </div>
            <label className="switch">
              <input type="checkbox" checked={showPlan} onChange={(e) => setShowPlan(e.target.checked)} />
              <span>Show plan</span>
            </label>
          </div>
        </section>

        {need.need > 0 && (
          <button className="banner" onClick={() => setPage("move")}>
            You would be {money(need.need, cur0)} short of your reserve by {shortDate(need.by)}. See ways to move money
          </button>
        )}

        {asks.length > 0 && (
          <section aria-label="Needs approval">
            <h2>Needs your approval {pending > 0 && <span className="count">{pending}</span>}</h2>
            <div className="asks">
              {asks.map((d) => {
                const o = ob(d.obligationId);
                const r = d.obligationId ? resolved[d.obligationId] : undefined;
                return (
                  <article key={d.obligationId} className={`ask ${selected === markerId(d) ? "sel" : ""}`}>
                    <div className="ask-top">
                      <VerbGlyph verb="escalate" />
                      <strong>{o?.payee}</strong>
                      <span className="amt">{o ? money(o.amount, o.currency) : ""}</span>
                    </div>
                    <p className="ask-q">{d.question}</p>
                    <p className="why">{d.reason}</p>
                    {r ? (
                      <div className="done">
                        {r === "approved" ? "Approved" : "Rejected"}
                        <button className="link" onClick={() => setResolved((s) => { const n = { ...s }; delete n[d.obligationId!]; return n; })}>Undo</button>
                      </div>
                    ) : (
                      <div className="btns">
                        <button className="btn primary" onClick={() => setResolved((s) => ({ ...s, [d.obligationId!]: "approved" }))}>Approve payment</button>
                        <button className="btn" onClick={() => setResolved((s) => ({ ...s, [d.obligationId!]: "rejected" }))}>Reject</button>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          </section>
        )}

        <section aria-label="Coming up">
          <h2>Coming up</h2>
          <ul className="list">
            {plan.decisions.filter((d) => d.action === "convert").map((d) => (
              <li key={markerId(d)} className={selected === markerId(d) ? "sel" : ""}>
                <button className="row" onClick={() => setOpen(open === markerId(d) ? null : markerId(d))}>
                  <span className="ico" style={{ background: "var(--convert)" }}><VerbGlyph verb="convert" size={14} /></span>
                  <span className="r-main"><b>{title(d)}</b><small>Runs today</small></span>
                  <span className="tag" style={{ ["--c" as string]: "var(--convert)" }}>Convert</span>
                </button>
                {open === markerId(d) && <p className="why indent">{d.reason}</p>}
              </li>
            ))}
            {rows.map((r) => {
              const d = r.kind === "out" ? decisionOf(r.id) : undefined;
              const res = resolved[r.id];
              const tag = d?.action === "fund" ? "Paid by plan" : d?.action === "defer" ? `Moves to ${shortDate(d.newDate)}` : d?.action === "escalate" ? (res ? (res === "approved" ? "Approved" : "Rejected") : "Needs approval") : r.kind === "in" ? "Expected" : "On schedule";
              const verb = (d?.action ?? null) as Verb | null;
              const mid = d ? markerId(d) : r.id;
              return (
                <li key={r.id} className={selected === mid ? "sel" : ""}>
                  <button className="row" onClick={() => setOpen(open === mid ? null : mid)} aria-expanded={open === mid}>
                    <span className="ico">{r.name[0]}</span>
                    <span className="r-main"><b>{r.name}</b><small>{shortDate(r.date)} · {r.sub}</small></span>
                    <span className="r-end">
                      <b className={r.kind === "in" ? "up" : ""}>{r.kind === "in" ? "+" : ""}{money(r.amount, r.cur)}</b>
                      <span className="tag" style={{ ["--c" as string]: verb ? `var(--${verb})` : "var(--muted)" }}>{tag}</span>
                    </span>
                  </button>
                  {open === mid && d && <p className="why indent">{d.reason}</p>}
                </li>
              );
            })}
          </ul>
        </section>

        <section aria-label="Accounts">
          <h2>Accounts</h2>
          <ul className="list">
            {base.balances.map((x) => (
              <li key={x.accountId}>
                <div className="row static">
                  <span className="ico">{x.currency}</span>
                  <span className="r-main"><b>{x.currency} account</b><small>Available now</small></span>
                  <span className="r-end"><b>{money(x.available, x.currency)}</b></span>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section aria-label="Your rules">
          <h2>Your rules</h2>
          <ul className="list">
            <li><div className="row static"><span className="r-main"><b>Keep at least</b></span><span className="r-end"><b>{money(base.policy.reserveFloor.amount, floorCur)} in {floorCur}</b></span></div></li>
            <li><div className="row static"><span className="r-main"><b>Never move</b></span><span className="r-end"><b>{base.policy.neverAutoDefer.join(", ")}</b></span></div></li>
            <li><div className="row static"><span className="r-main"><b>Ask me above</b></span><span className="r-end"><b>{money(base.policy.escalateAbove.amount, base.policy.escalateAbove.currency)}</b></span></div></li>
            <li><div className="row static"><span className="r-main"><b>Max currency fee</b></span><span className="r-end"><b>{(base.policy.maxFxSpreadBps / 100).toFixed(2)}%</b></span></div></li>
          </ul>
        </section>
        </>)}
      </main>

      <Chat ctx={ctx} onEffect={apply} intro={intro} />
      </div>
    </div>
  );
}
