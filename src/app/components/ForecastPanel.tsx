"use client";

import { useMemo, useRef, useState } from "react";
import { dayNumber } from "@/scenarios/crunch";
import { ctxAttrs, ctxKey } from "../lib/ctx";
import { dayLabel, money, signed } from "../lib/format";
import { useStore } from "../lib/store";

const W = 760;
const H = 300;
const M = { l: 58, r: 16, t: 22, b: 34 };

interface Tip { x: number; y: number; title: string; lines: string[]; color: string }

export default function ForecastPanel() {
  const { s, d, setContext, flash } = useStore();
  const wrap = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const base = s.base;
  const cur = base.policy.reserveFloor.currency;
  const floor = base.policy.reserveFloor.amount;
  const n = d.dates.length;

  const g = useMemo(() => {
    const vals = [...d.usdNo, ...d.usdPlan, 0, floor];
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const pad = (hi - lo) * 0.08;
    const mn = lo - pad;
    const mx = hi + pad;
    const x = (i: number) => M.l + (i * (W - M.l - M.r)) / (n - 1);
    const y = (v: number) => M.t + ((mx - v) * (H - M.t - M.b)) / (mx - mn);
    const step = [1000, 2000, 5000, 10000].map((v) => v * 100).find((v) => (mx - mn) / v <= 6) ?? 1_000_000;
    const ticks: number[] = [];
    for (let v = Math.ceil(mn / step) * step; v <= mx; v += step) ticks.push(v);
    return { x, y, ticks, mn };
  }, [d.usdNo, d.usdPlan, floor, n]);

  const path = (arr: number[]) => arr.map((v, i) => `${i ? "L" : "M"}${g.x(i).toFixed(1)} ${g.y(v).toFixed(1)}`).join(" ");
  const colW = (W - M.l - M.r) / (n - 1);
  const zeroY = g.y(0);

  const markers = useMemo(() => {
    const out: { key: string; i: number; kind: "out" | "in" | "convert"; ctx: Parameters<typeof ctxAttrs>[0]; title: string; lines: string[]; color: string; dy: number }[] = [];
    const above: Record<number, number> = {};
    const below: Record<number, number> = {};
    d.withPlan.days.forEach((day, i) => {
      for (const e of day.events) {
        if (e.refId.startsWith("conv_") || e.refId.startsWith("xfer_")) continue;
        if (e.kind === "obligation") {
          const r = d.rows.find((x) => x.ob.id === e.refId);
          if (!r) continue;
          const k = (below[i] = (below[i] ?? 0) + 1) - 1;
          out.push({ key: e.refId, i, kind: "out", dy: 12 + k * 13, color: "#FFFFFF", title: r.ob.payee, lines: [`${money(r.ob.amount, r.ob.currency)} · ${dayLabel(day.date)}`, r.decision ? `Decision: ${r.decision.decision.action.toUpperCase()}` : "No decision yet"], ctx: { type: "payment", id: r.ob.id, label: `${r.ob.payee} ${money(r.ob.amount, r.ob.currency)}` } });
        } else {
          const inf = d.inflows.find((x) => x.id === e.refId);
          if (!inf) continue;
          const k = (above[i] = (above[i] ?? 0) + 1) - 1;
          out.push({ key: e.refId, i, kind: "in", dy: -(12 + k * 13), color: "var(--green)", title: inf.payer, lines: [`+${money(inf.amount, inf.currency)} · ${dayLabel(day.date)}`, `${Math.round(inf.confidence * 100)}% likely`], ctx: { type: "inflow", id: inf.id, label: `${inf.payer} ${money(inf.amount, inf.currency)}` } });
        }
      }
    });
    for (const x of d.state.decisions) {
      if (x.status === "REJECTED" || x.decision.action !== "convert") continue;
      const i = Math.max(0, d.dates.indexOf(x.decision.executeOn ?? base.asOf));
      out.push({ key: x.id, i, kind: "convert", dy: -14, color: "var(--blue)", title: `Convert ${x.decision.from} to ${x.decision.to}`, lines: [`${money(x.decision.sellAmount, x.decision.from)} · ${dayLabel(d.dates[i])}`, x.status === "PENDING" ? "Waiting for approval" : "Approved"], ctx: { type: "decision", id: x.id, label: `CONVERT ${x.decision.from} to ${x.decision.to}` } });
    }
    return out;
  }, [d, base.asOf]);

  function show(e: React.MouseEvent, t: Omit<Tip, "x" | "y">) {
    const r = wrap.current!.getBoundingClientRect();
    setTip({ ...t, x: e.clientX - r.left, y: e.clientY - r.top });
  }

  const sm = d.summary;
  const selectedDay = s.context?.type === "graphDay" ? d.dates.indexOf(s.context.id) : -1;

  return (
    <section className="panel forecast" aria-label="Forecast">
      <div className="panel-head">
        <h2>Forecast · next {n} days</h2>
        <div className="legend">
          <span><i style={{ background: "var(--red)" }} /> If you pay everything as scheduled</span>
          <span><i style={{ background: "var(--green)" }} /> With CashPilot&rsquo;s plan</span>
        </div>
      </div>
      <div className="muted small chart-sub">{cur} account · projected end-of-day balance</div>

      <div className="chart-wrap" ref={wrap} onMouseLeave={() => setTip(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} className="fc" role="img" aria-label={`${cur} balance forecast with and without the plan`}>
          {g.ticks.map((t) => (
            <g key={t}>
              <line x1={M.l} x2={W - M.r} y1={g.y(t)} y2={g.y(t)} className="grid" />
              <text x={M.l - 8} y={g.y(t) + 4} textAnchor="end" className="tick">{money(t, cur)}</text>
            </g>
          ))}
          {g.mn < 0 && <rect x={M.l} y={zeroY} width={W - M.l - M.r} height={H - M.b - zeroY} className="below" />}
          <line x1={M.l} x2={W - M.r} y1={zeroY} y2={zeroY} className="zero" />
          <text x={M.l + 4} y={zeroY - 4} className="tick">$0</text>
          <line x1={M.l} x2={W - M.r} y1={g.y(floor)} y2={g.y(floor)} className="floor" />
          <text x={M.l + 4} y={g.y(floor) - 5} className="floor-label">Reserve floor {money(floor, cur)}</text>

          {selectedDay >= 0 && <rect x={g.x(selectedDay) - colW / 2} y={M.t} width={colW} height={H - M.t - M.b} className="day-sel" />}

          <path d={path(d.usdNo)} className="line-no" style={{ d: `path("${path(d.usdNo)}")` }} />
          <path d={path(d.usdPlan)} className="line-plan" style={{ d: `path("${path(d.usdPlan)}")` }} />

          {[0, 3, 6, 9, 13].map((i) => (
            <text key={i} x={g.x(i)} y={H - 10} textAnchor="middle" className="tick">Day {dayNumber(d.dates[i])}</text>
          ))}

          {d.dates.map((date, i) => {
            const c = { type: "graphDay" as const, id: date, label: dayLabel(date) };
            return (
              <rect
                key={date}
                x={g.x(i) - colW / 2}
                y={M.t}
                width={colW}
                height={H - M.t - M.b}
                className={`day-hit ${s.highlight === ctxKey(c) ? "hot-svg" : ""}`}
                {...ctxAttrs(c)}
                onClick={() => { setContext(c); flash(ctxKey(c)); }}
                onMouseMove={(e) => show(e, { title: dayLabel(date), color: "var(--green)", lines: [`With plan ${signed(d.usdPlan[i], cur)}`, `As scheduled ${signed(d.usdNo[i], cur)}`] })}
              />
            );
          })}

          {markers.map((m) => (
            <g
              key={m.key}
              className={`mk ${s.highlight === ctxKey(m.ctx) ? "hot-svg" : ""}`}
              transform={`translate(${g.x(m.i)} ${g.y(d.usdPlan[m.i]) + m.dy})`}
              {...ctxAttrs(m.ctx)}
              onClick={(e) => { e.stopPropagation(); setContext(m.ctx); flash(ctxKey(m.ctx)); }}
              onMouseMove={(e) => show(e, { title: m.title, lines: m.lines, color: m.color })}
            >
              <circle r="9" fill="transparent" />
              <circle r={m.kind === "convert" ? 6.5 : 5.5} fill={m.color} className="mk-dot" />
            </g>
          ))}
        </svg>
        {tip && (
          <div className="tip" style={{ left: Math.min(tip.x + 14, (wrap.current?.clientWidth ?? 600) - 190), top: tip.y + 12, borderColor: tip.color }}>
            <b>{tip.title}</b>
            {tip.lines.map((l) => <div key={l}>{l}</div>)}
          </div>
        )}
      </div>

      <div className="strip3">
        <div className="stat bad">
          <div className="muted small">Predicted shortfall</div>
          <b>{sm.shortfallDay == null ? "None" : `Day ${sm.shortfallDay} · ${signed(sm.shortfallValue ?? 0, cur)}`}</b>
        </div>
        <div className="stat good">
          <div className="muted small">Shortfall avoided by plan</div>
          <b>{money(sm.avoided, cur)}</b>
        </div>
        <div className="stat">
          <div className="muted small">Lowest balance (plan)</div>
          <b>{signed(sm.lowestPlan, cur)} <span className="muted small">Day {sm.lowestPlanDay}</span></b>
        </div>
      </div>
    </section>
  );
}
