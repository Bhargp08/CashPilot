"use client";

import { useState } from "react";
import type { Decision } from "@/contracts/types";
import { convertAmount } from "@/engine/util";
import { dayLabel, money, shortDate } from "../lib/format";
import { ctxAttrs, ctxKey, openAsk } from "../lib/ctx";
import { useStore } from "../lib/store";
import { priorityTag, uiAction, type UiAction } from "../lib/types";
import AssetsPage from "./AssetsPage";
import MovePage from "./MovePage";

const TONE: Record<UiAction, string> = { FUND: "var(--green)", CONVERT: "var(--blue)", DEFER: "var(--yellow)", ESCALATE: "var(--red)" };

export function Badge({ action, ctx }: { action: UiAction; ctx?: { id: string; label: string } }) {
  return (
    <span className="badge" style={{ ["--c" as string]: TONE[action] }} {...(ctx ? ctxAttrs({ type: "decision", ...ctx }) : {})}>
      {action}
    </span>
  );
}

export default function ControlCenter() {
  const { s, d, setTab, setMoveTarget, setTransfer, dismissNotice, undo } = useStore();
  const base = s.base;
  const cur = base.policy.reserveFloor.currency;
  const asks = [...d.state.decisions].filter((x) => x.decision.action === "convert" || x.decision.action === "escalate");

  const cc = s.moveTarget ?? (d.need.need > 0 ? { amount: d.need.need, by: d.need.by } : { amount: 0, by: base.asOf });
  const askChips = d.state.decisions
    .filter((x) => x.decision.action === "escalate")
    .map((x) => base.obligations.find((o) => o.id === (x.decision as { obligationId?: string }).obligationId))
    .filter((o): o is NonNullable<typeof o> => !!o)
    .map((o) => ({ label: `Pay ${o.payee} on time`, amount: convertAmount(base, o.amount, o.currency, cur), by: o.dueDate }));

  return (
    <section className="panel left" aria-label="Control center">
      <div className="panel-head">
        <h2>Control center</h2>
        <div className="tabs" role="tablist">
          {(["payments", "assets", "move"] as const).map((t) => (
            <button key={t} role="tab" aria-selected={s.tab === t} className={s.tab === t ? "on" : ""} onClick={() => setTab(t)}>
              {t === "payments" ? "Payments" : t === "assets" ? "Assets" : "Move money"}
              {t === "move" && d.need.need > 0 && <i className="dot-badge" aria-label="needs attention" />}
            </button>
          ))}
        </div>
      </div>

      {s.notice && (
        <div className="notice" role="alert">
          {s.notice}
          <button className="link" onClick={dismissNotice}>Dismiss</button>
        </div>
      )}

      <div className="scroll">
        {s.tab === "assets" && <AssetsPage state={base} onMove={() => setTab("move")} />}
        {s.tab === "move" && (
          <MovePage
            key={`${cc.amount}-${cc.by}`}
            state={base}
            need={d.need.need}
            needBy={d.need.by}
            amount={cc.amount}
            by={cc.by}
            setTarget={setMoveTarget}
            transfers={s.transfers}
            onTransfer={setTransfer}
            chips={askChips}
            lowestAfter={Math.min(...d.usdPlan)}
          />
        )}
        {s.tab === "payments" && (
          <>
            <div className="balances">
              {base.balances.map((b) => (
                <div key={b.accountId} className={`card bal ${s.highlight === ctxKey({ type: "account", id: b.accountId, label: "" }) ? "hot" : ""}`} {...ctxAttrs({ type: "account", id: b.accountId, label: `${b.currency} account ${money(b.available, b.currency)}` })} data-ctx-key={`account:${b.accountId}`}>
                  <div className="muted">{b.currency} account{b.currency === "EUR" ? ` · €1 = $${d.fx.toFixed(2)}` : ""}</div>
                  <div className="num">{money(b.available, b.currency)}</div>
                </div>
              ))}
            </div>
            <div className="combined muted">Combined total: <b>{money(d.combinedUsd, "USD")} USD</b></div>

            <h3>Needs approval <span className="count">{d.pending.length}</span></h3>
            {asks.length === 0 && <p className="muted">Nothing is waiting for you.</p>}
            <div className="stack">
              {asks.map((x) => <ApprovalCard key={x.id} id={x.id} />)}
            </div>

            <h3>Upcoming payments</h3>
            <ul className="rows">
              {[...d.rows.map((r) => ({ t: "out" as const, date: r.dueDate, r })), ...d.inflows.map((i) => ({ t: "in" as const, date: i.expectedDate, i }))]
                .sort((a, b) => a.date.localeCompare(b.date))
                .map((it) => (it.t === "out" ? <PaymentRow key={it.r.ob.id} id={it.r.ob.id} /> : <InflowRow key={it.i.id} id={it.i.id} />))}
            </ul>

            <h3>Completed</h3>
            <ul className="rows">
              {s.completed.map((c) => {
                const key = `completed:${c.id}`;
                return (
                  <li key={c.id} className={`row-item ${s.highlight === key ? "hot" : ""}`} {...ctxAttrs({ type: "completed", id: c.id, label: `${c.obligation.payee} ${money(c.obligation.amount, c.obligation.currency)}` })}>
                    <div className="grow">
                      <b>{c.obligation.payee}</b>
                      <div className="muted small">
                        {money(c.obligation.amount, c.obligation.currency)} · {c.executedDay === 0 ? "yesterday" : "today"}{c.undone ? " · undone, back in Upcoming" : " · completed"}
                      </div>
                    </div>
                    <button className="btn small" disabled={c.undone} onClick={() => undo(c.id)}>{c.undone ? "Undone" : "Undo"}</button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}

function ApprovalCard({ id }: { id: string }) {
  const { s, d, approve, reject, reopen } = useStore();
  const x = d.state.decisions.find((y) => y.id === id)!;
  const dec: Decision = x.decision;
  const action = uiAction(dec);
  const ob = "obligationId" in dec ? s.base.obligations.find((o) => o.id === dec.obligationId) : undefined;
  const key = `decision:${x.id}`;
  const ctx = { type: "decision" as const, id: x.id, label: `${action}: ${ob?.payee ?? "currency conversion"}` };
  const landed = dec.action === "convert" ? Math.round(dec.sellAmount * d.fx) : 0;

  return (
    <article className={`card ask ${x.status === "REJECTED" ? "rejected" : ""} ${s.highlight === key ? "hot" : ""}`} style={{ ["--c" as string]: TONE[action] }} {...ctxAttrs(ctx)}>
      <div className="ask-top">
        <Badge action={action} />
        <b>{dec.action === "convert" ? `${dec.from} to ${dec.to} for payroll` : ob?.payee}</b>
        <button className="link ask-ai" onClick={(e) => openAsk(e.currentTarget, ctx)}>Ask AI</button>
      </div>
      <div className="muted small">
        {dec.action === "convert"
          ? `${money(dec.sellAmount, dec.from)} to ${money(landed, dec.to)} · ${dec.executeOn ? dayLabel(dec.executeOn) : "today"}`
          : `${ob ? money(ob.amount, ob.currency) : ""} · due ${ob ? dayLabel(ob.dueDate) : ""}`}
      </div>
      <div className="reason">{dec.reason}</div>
      {x.status === "PENDING" ? (
        <div className="btns">
          <button className="btn go" onClick={() => approve(x.id)}>Approve</button>
          <button className="btn" onClick={() => reject(x.id)}>Reject</button>
        </div>
      ) : (
        <div className="done">
          <span style={{ color: x.status === "APPROVED" ? "var(--green)" : "var(--red)" }}>
            {x.status === "APPROVED"
              ? dec.action === "convert" ? `Approved · ${money(landed, dec.to)} lands in the ${dec.to} account ${dec.executeOn ? dayLabel(dec.executeOn) : "today"}` : "Approved · it will be paid on its due date"
              : "Rejected by you · the payment stays scheduled and the forecast no longer counts this"}
          </span>
          <button className="link" onClick={() => reopen(x.id)}>Undo</button>
        </div>
      )}
    </article>
  );
}

function PaymentRow({ id }: { id: string }) {
  const { s, d, approve, reject, deferPayment, fundNow } = useStore();
  const [open, setOpen] = useState(false);
  const r = d.rows.find((x) => x.ob.id === id)!;
  const { ob } = r;
  const action = r.decision ? uiAction(r.decision.decision) : null;
  const key = `payment:${ob.id}`;
  const ctx = { type: "payment" as const, id: ob.id, label: `${ob.payee} ${money(ob.amount, ob.currency)} due ${dayLabel(r.dueDate)}` };
  const label = { UPCOMING: "Upcoming", NEEDS_APPROVAL: "Needs approval", APPROVED: "Approved", REJECTED: "Rejected", DEFERRED: "Deferred" }[r.status];
  const pending = r.decision && r.decision.status === "PENDING";

  return (
    <li className={`row-item ${s.highlight === key ? "hot" : ""} ${s.context?.id === ob.id ? "sel" : ""}`} {...ctxAttrs(ctx)}>
      <div className="grow">
        <b>{ob.payee}</b>
        <div className="muted small">
          {dayLabel(r.dueDate)} · {ob.category[0].toUpperCase() + ob.category.slice(1)} · {priorityTag(ob.priority)} · {label}
          {r.status === "DEFERRED" && ` (was ${shortDate(ob.dueDate)})`}
        </div>
        {r.note && <div className="muted small">{r.note}</div>}
        <div className="row-actions">
          {pending ? (
            <>
              <button className="btn small go" onClick={() => approve(r.decision!.id)}>Approve</button>
              <button className="btn small" onClick={() => reject(r.decision!.id)}>Reject</button>
            </>
          ) : (
            <>
              <button className="btn small" onClick={() => setOpen((v) => !v)} aria-expanded={open}>Defer</button>
              <button className="btn small" onClick={() => fundNow(ob.id)}>Fund now</button>
            </>
          )}
          {open && !pending && [3, 7, 14].map((n) => (
            <button key={n} className="chip" onClick={() => { deferPayment(ob.id, n); setOpen(false); }}>+{n} days</button>
          ))}
        </div>
      </div>
      <div className="amt-col">
        {action && <Badge action={action} ctx={{ id: r.decision!.id, label: `${action}: ${ob.payee}` }} />}
        <b className="amt">{money(ob.amount, ob.currency)}</b>
      </div>
    </li>
  );
}

function InflowRow({ id }: { id: string }) {
  const { s, d } = useStore();
  const i = d.inflows.find((x) => x.id === id)!;
  const key = `inflow:${i.id}`;
  return (
    <li className={`row-item inflow ${s.highlight === key ? "hot" : ""} ${s.context?.id === i.id ? "sel" : ""}`} {...ctxAttrs({ type: "inflow", id: i.id, label: `${i.payer} ${money(i.amount, i.currency)} expected ${dayLabel(i.expectedDate)}` })}>
      <div className="grow">
        <b>{i.payer}</b>
        <div className="muted small">Expected {dayLabel(i.expectedDate)} · inflow{i.confidence < 0.8 ? " · may slip" : ""}</div>
      </div>
      <b className="amt up">+{money(i.amount, i.currency)}</b>
    </li>
  );
}
