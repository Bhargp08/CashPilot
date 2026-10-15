import type { BusinessState, Inflow } from "@/contracts/types";
import { addDays, day } from "./format";

export interface NoteAdjustment {
  inflowId: string;
  /** Owner-facing, e.g. "Wholesale Customer Payment moved 5 days later, to Day 11 (Nov 12)". */
  description: string;
}

export interface AppliedNote {
  state: BusinessState;
  adjustments: NoteAdjustment[];
  /** True when the note had text but no recognisable what-if. */
  unparsed: boolean;
}

const GENERIC = new Set(["payment", "payments", "payout", "payouts", "from", "the", "and", "inc", "corp", "ltd", "llc", "gmbh", "co"]);

/**
 * Turns a what-if note into a modified COPY of the state, so the engine (not the LLM) recomputes every number.
 * Understands, per clause: "<payer words> ... N days late", "delay <payer> by N days", "<payer> ... delayed N days",
 * and "<payer> doesn't / won't / never pays". A late clause that names no payer applies to the least certain inflow.
 */
export function applyUserNote(state: BusinessState, note: string | undefined): AppliedNote {
  if (!note?.trim()) return { state, adjustments: [], unparsed: false };
  const next = structuredClone(state);
  const adjustments: NoteAdjustment[] = [];
  const touched = new Set<string>();

  for (const clause of note.toLowerCase().split(/[.;\n]|,|\band\b/)) {
    const days = Number(
      clause.match(/(\d+)\s*(?:business\s+)?days?\s+(?:late|later|behind)/)?.[1] ??
        clause.match(/delay(?:ed)?\s+[^\d]*?(?:by\s+)?(\d+)\s*days?/)?.[1] ??
        NaN,
    );
    const missing = /(?:doesn'?t|does not|won'?t|will not|never|fails? to)\s+pay|no payment|not arrive|doesn'?t arrive|never arrives/.test(clause);
    if (Number.isNaN(days) && !missing) continue;

    const named = next.inflows.filter((i) => !touched.has(i.id) && mentions(clause, i));
    const leastCertain = (list: Inflow[]) => [...list].sort((a, b) => a.confidence - b.confidence || a.expectedDate.localeCompare(b.expectedDate))[0];
    const target = leastCertain(named) ?? leastCertain(next.inflows.filter((i) => !touched.has(i.id)));
    if (!target) continue;
    touched.add(target.id);

    if (!Number.isNaN(days)) {
      target.expectedDate = addDays(target.expectedDate, days);
      adjustments.push({ inflowId: target.id, description: `${target.payer} moved ${days} days later, to ${day(target.expectedDate, state.asOf)}` });
    } else {
      next.inflows = next.inflows.filter((i) => i.id !== target.id);
      adjustments.push({ inflowId: target.id, description: `${target.payer} assumed not to arrive` });
    }
  }

  return { state: adjustments.length > 0 ? next : state, adjustments, unparsed: adjustments.length === 0 };
}

function mentions(clause: string, inflow: Inflow): boolean {
  const words = inflow.payer.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !GENERIC.has(w));
  return clause.includes(inflow.id.toLowerCase()) || words.some((w) => new RegExp(`\\b${w}`).test(clause));
}
