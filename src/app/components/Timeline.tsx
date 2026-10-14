"use client";

import { useMemo } from "react";
import type { Currency, IsoDate } from "@/contracts/types";
import { money, shortDate } from "../lib/format";

export type Verb = "fund" | "convert" | "defer" | "escalate";

export interface Marker {
  id: string;
  date: IsoDate;
  verb: Verb;
  label: string;
}

interface Props {
  dates: IsoDate[];
  before: number[];
  after: number[];
  currency: Currency;
  floor: number | null;
  markers: Marker[];
  showPlan: boolean;
  idx: number;
  onHover: (i: number | null) => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

const W = 720;
const H = 240;
const PT = 14;
const PB = 10;
const LANE = 20;

export function VerbGlyph({ verb, size = 12 }: { verb: Verb; size?: number }) {
  const c = `var(--${verb})`;
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden>
      {verb === "fund" && <circle cx="6" cy="6" r="5" fill={c} />}
      {verb === "convert" && <path d="M6 .5 11.5 6 6 11.5.5 6z" fill={c} />}
      {verb === "defer" && <path d="M1 2h10L6 11z" fill={c} />}
      {verb === "escalate" && <rect x="1" y="1" width="10" height="10" rx="1.5" fill={c} />}
    </svg>
  );
}

export default function Timeline({ dates, before, after, currency, floor, markers, showPlan, idx, onHover, selectedId, onSelect }: Props) {
  const n = dates.length;
  const { x, y, zeroY } = useMemo(() => {
    const vals = [...before, ...(showPlan ? after : []), 0, ...(floor != null ? [floor] : [])];
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const pad = (hi - lo) * 0.1 || 1;
    const mn = lo - pad;
    const mx = hi + pad;
    const yy = (v: number) => PT + ((mx - v) * (H - PT - PB)) / (mx - mn);
    return { x: (i: number) => 14 + (i * (W - 28)) / Math.max(n - 1, 1), y: yy, zeroY: yy(0) };
  }, [before, after, floor, showPlan, n]);

  const path = (s: number[]) => s.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const short = before.some((v) => v < 0);

  const lanes = useMemo(() => {
    const per: Record<string, number> = {};
    return markers.map((m) => {
      const lane = per[m.date] ?? 0;
      per[m.date] = lane + 1;
      return { ...m, lane };
    });
  }, [markers]);
  const laneCount = showPlan ? Math.max(1, ...lanes.map((m) => m.lane + 1)) : 0;
  const total = H + (laneCount ? laneCount * LANE + 8 : 0);

  function move(e: React.PointerEvent<SVGRectElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    onHover(Math.min(n - 1, Math.max(0, Math.round(((((e.clientX - r.left) / r.width) * W - 14) / (W - 28)) * (n - 1)))));
  }

  const lead = showPlan ? after : before;

  return (
    <svg className="chart-svg" viewBox={`0 0 ${W} ${total}`} role="img" aria-label={`${currency} balance, next ${n} days`}>
      {short && <line x1="0" x2={W} y1={zeroY} y2={zeroY} className="c-zero" />}
      {short && <text x="2" y={zeroY - 5} className="c-label">{money(0, currency)}</text>}
      {floor != null && (
        <>
          <line x1="0" x2={W} y1={y(floor)} y2={y(floor)} className="c-floor" />
          <text x={W - 2} y={y(floor) - 5} textAnchor="end" className="c-label">
            Reserve {money(floor, currency)}
          </text>
        </>
      )}

      {(!showPlan || short || before.some((v, i) => v !== after[i])) && <path d={path(before)} className={showPlan ? "c-before" : "c-main"} />}
      {showPlan && <path d={path(after)} className="c-main" />}

      <line x1={x(idx)} x2={x(idx)} y1={PT - 6} y2={H - PB} className="c-cursor" />
      <circle cx={x(idx)} cy={y(lead[idx])} r="5" className="c-dot" />
      {showPlan && short && <circle cx={x(idx)} cy={y(before[idx])} r="4" className="c-dot-before" />}

      {showPlan &&
        lanes.map((m) => {
          const i = dates.indexOf(m.date);
          if (i < 0) return null;
          const cy = H + 4 + m.lane * LANE + LANE / 2;
          const on = selectedId === m.id;
          return (
            <g
              key={m.id}
              transform={`translate(${x(i) - 7} ${cy - 7}) scale(1.15)`}
              className={`marker ${on ? "marker-on" : ""}`}
              tabIndex={0}
              role="button"
              aria-label={m.label}
              onClick={() => onSelect(on ? null : m.id)}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onSelect(on ? null : m.id)}
              onMouseEnter={() => onHover(i)}
            >
              <rect x="-5" y="-5" width="22" height="22" rx="6" className="marker-bg" />
              <VerbGlyph verb={m.verb} size={12} />
              <title>{`${shortDate(m.date)}: ${m.label}`}</title>
            </g>
          );
        })}

      <rect x="0" y="0" width={W} height={H} fill="transparent" onPointerMove={move} onPointerLeave={() => onHover(null)} />
    </svg>
  );
}
