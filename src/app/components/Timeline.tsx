"use client";

import { useMemo, useState } from "react";
import type { Currency, DailyPosition, IsoDate } from "@/contracts/types";
import { money, shortDate, weekday } from "../lib/format";

export type Verb = "fund" | "convert" | "defer" | "escalate";

export interface Marker {
  id: string;
  date: IsoDate;
  verb: Verb;
  label: string;
}

interface Props {
  currency: Currency;
  floor: number;
  before: DailyPosition[];
  after: DailyPosition[];
  markers: Marker[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  showPlan: boolean;
}

const W = 960;
const H = 300;
const PAD = { l: 64, r: 20, t: 16, b: 30 };
const LANE_H = 22;

export function VerbGlyph({ verb, size = 12 }: { verb: Verb; size?: number }) {
  const c = `var(--${verb})`;
  const s = size;
  return (
    <svg width={s} height={s} viewBox="0 0 12 12" aria-hidden>
      {verb === "fund" && <circle cx="6" cy="6" r="5" fill={c} />}
      {verb === "convert" && <path d="M6 .5 11.5 6 6 11.5.5 6z" fill={c} />}
      {verb === "defer" && <path d="M1 2h10L6 11z" fill={c} />}
      {verb === "escalate" && <rect x="1" y="1" width="10" height="10" rx="1" fill={c} />}
    </svg>
  );
}

export default function Timeline({ currency, floor, before, after, markers, selectedId, onSelect, showPlan }: Props) {
  const firstShort = before.find((d) => (d.balances[currency] ?? 0) < 0)?.date ?? null;
  const [hover, setHover] = useState<number | null>(null);
  const n = before.length;

  const { x, y, min, max } = useMemo(() => {
    const vals = [...before, ...after].map((d) => d.balances[currency] ?? 0).concat([0, floor]);
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const pad = (hi - lo) * 0.08;
    const mn = lo - pad;
    const mx = hi + pad;
    return {
      min: mn,
      max: mx,
      x: (i: number) => PAD.l + (i * (W - PAD.l - PAD.r)) / Math.max(n - 1, 1),
      y: (v: number) => PAD.t + ((mx - v) * (H - PAD.t - PAD.b)) / (mx - mn),
    };
  }, [before, after, currency, floor, n]);

  const path = (days: DailyPosition[]) =>
    days.map((d, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)} ${y(d.balances[currency] ?? 0).toFixed(1)}`).join(" ");

  const ticks = useMemo(() => {
    const span = max - min;
    const raw = span / 5;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
    const out: number[] = [];
    for (let v = Math.ceil(min / step) * step; v <= max; v += step) out.push(v);
    return out;
  }, [min, max]);

  const lanes = useMemo(() => {
    const perDate: Record<string, number> = {};
    return markers.map((m) => {
      const lane = perDate[m.date] ?? 0;
      perDate[m.date] = lane + 1;
      return { ...m, lane };
    });
  }, [markers]);
  const laneCount = Math.max(1, ...lanes.map((m) => m.lane + 1));
  const totalH = H + laneCount * LANE_H + 8;

  const idx = hover ?? Math.max(0, before.findIndex((d) => d.date === firstShort));
  const dayB = before[idx];
  const dayA = after[idx];
  const eventsToday = dayB?.events ?? [];

  function onMove(e: React.PointerEvent<SVGRectElement>) {
    const box = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * (W - PAD.l - PAD.r);
    setHover(Math.min(n - 1, Math.max(0, Math.round((px / (W - PAD.l - PAD.r)) * (n - 1)))));
  }

  const zeroY = y(0);
  const belowId = "below-zero";

  return (
    <div className="timeline">
      <div className="readout" aria-live="polite">
        <div>
          <div className="readout-date">
            {weekday(dayB.date)}, {shortDate(dayB.date)}
          </div>
          <div className="readout-note">{eventsToday.length ? `${eventsToday.length} scheduled item${eventsToday.length > 1 ? "s" : ""} today` : "Nothing scheduled"}</div>
        </div>
        <dl className="readout-figs">
          <div>
            <dt>{currency} with no action</dt>
            <dd className={(dayB.balances[currency] ?? 0) < 0 ? "neg" : ""}>{money(dayB.balances[currency] ?? 0, currency)}</dd>
          </div>
          {showPlan && (
            <div>
              <dt>{currency} with the plan</dt>
              <dd>{money(dayA.balances[currency] ?? 0, currency)}</dd>
            </div>
          )}
        </dl>
      </div>

      <svg viewBox={`0 0 ${W} ${totalH}`} role="img" aria-label={`${currency} balance over the next ${n} days, with and without the plan`}>
        <defs>
          <clipPath id={belowId}>
            <rect x={PAD.l} y={zeroY} width={W - PAD.l - PAD.r} height={Math.max(0, H - PAD.b - zeroY)} />
          </clipPath>
        </defs>

        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} className={t === 0 ? "zero" : "grid"} />
            <text x={PAD.l - 8} y={y(t) + 4} textAnchor="end" className="tick">
              {money(t, currency)}
            </text>
          </g>
        ))}

        <path d={`${path(before)} L${x(n - 1)} ${zeroY} L${x(0)} ${zeroY}Z`} className="shortfall-fill" clipPath={`url(#${belowId})`} />

        <line x1={PAD.l} x2={W - PAD.r} y1={y(floor)} y2={y(floor)} className="floor" />
        <text x={W - PAD.r} y={y(floor) - 5} textAnchor="end" className="floor-label">
          Reserve floor {money(floor, currency)}
        </text>

        <path d={path(before)} className="line-before" />
        {showPlan && <path d={path(after)} className="line-after" />}

        {before.map((d, i) => (
          <text key={d.date} x={x(i)} y={H - 8} textAnchor="middle" className={`tick ${i === idx ? "tick-on" : ""}`}>
            {n > 10 && i % 2 === 1 ? "" : shortDate(d.date)}
          </text>
        ))}

        <line x1={x(idx)} x2={x(idx)} y1={PAD.t} y2={H - PAD.b} className="cursor" />
        <circle cx={x(idx)} cy={y(dayB.balances[currency] ?? 0)} r="4" className="dot-before" />
        {showPlan && <circle cx={x(idx)} cy={y(dayA.balances[currency] ?? 0)} r="4.5" className="dot-after" />}

        {showPlan &&
          lanes.map((m) => {
            const i = before.findIndex((d) => d.date === m.date);
            if (i < 0) return null;
            const cx = x(i);
            const cy = H + 4 + m.lane * LANE_H + LANE_H / 2;
            return (
              <g
                key={m.id}
                transform={`translate(${cx - 8} ${cy - 8})`}
                className={`marker ${selectedId === m.id ? "marker-on" : ""}`}
                tabIndex={0}
                role="button"
                aria-label={m.label}
                onClick={() => onSelect(selectedId === m.id ? null : m.id)}
                onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onSelect(selectedId === m.id ? null : m.id)}
                onMouseEnter={() => setHover(i)}
              >
                <rect x="-4" y="-4" width="24" height="24" fill="transparent" />
                <g transform="scale(1.35)">
                  <VerbGlyph verb={m.verb} size={12} />
                </g>
                <title>{m.label}</title>
              </g>
            );
          })}

        <rect x={PAD.l} y={PAD.t} width={W - PAD.l - PAD.r} height={H - PAD.t - PAD.b} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
      </svg>

      <div className="legend">
        <span><i className="swatch swatch-before" /> {currency} with no action</span>
        {showPlan && <span><i className="swatch swatch-after" /> {currency} with the plan</span>}
        <span><i className="swatch swatch-short" /> Cash short</span>
      </div>
    </div>
  );
}
