import type { BusinessState, Inflow } from "@/contracts/types";
import { addDays } from "./format";

export interface NoteAdjustment {
  inflowId: string;
  description: string;
}

export interface AppliedNote {
  state: BusinessState;
  adjustments: NoteAdjustment[];
  /** True when the note had text but no recognisable what-if pattern. */
  unparsed: boolean;
}

/**
 * Turns a user what-if note into a modified copy of the state, so the engine (not the LLM)
 * recomputes every number. Recognised forms, matched against inflow payer or id:
 *   "Acme pays 5 days late", "Acme is 3 days late", "delay Globex by 7 days",
 *   "Acme doesn't pay", "Globex never pays", "no payment from Acme".
 */
export function applyUserNote(state: BusinessState, note: string | undefined): AppliedNote {
  if (!note?.trim()) return { state, adjustments: [], unparsed: false };
  const next = structuredClone(state);
  const adjustments: NoteAdjustment[] = [];
  const text = note.toLowerCase();

  for (const inflow of [...next.inflows]) {
    const names = nameVariants(inflow);
    const name = names.find((n) => text.includes(n));
    if (!name) continue;
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    const late =
      text.match(new RegExp(`${esc}[^.;,]*?(\\d+)\\s*(?:business\\s+)?days?\\s+late`)) ??
      text.match(new RegExp(`delay\\s+${esc}[^.;,]*?by\\s+(\\d+)\\s*days?`)) ??
      text.match(new RegExp(`${esc}[^.;,]*?delayed\\s+(?:by\\s+)?(\\d+)\\s*days?`));
    if (late) {
      const days = Number(late[1]);
      const from = inflow.expectedDate;
      inflow.expectedDate = addDays(from, days);
      adjustments.push({ inflowId: inflow.id, description: `${inflow.id} (${inflow.payer}) moved ${days} days late, from ${from} to ${inflow.expectedDate}` });
      continue;
    }

    const missing = new RegExp(`${esc}[^.;,]*?(?:doesn'?t|does not|won'?t|will not|never|fails? to)\\s+pay|no payment from[^.;,]*?${esc}`);
    if (missing.test(text)) {
      next.inflows = next.inflows.filter((i) => i.id !== inflow.id);
      adjustments.push({ inflowId: inflow.id, description: `${inflow.id} (${inflow.payer}) removed: assumed not to arrive in the horizon` });
    }
  }

  return { state: adjustments.length > 0 ? next : state, adjustments, unparsed: adjustments.length === 0 };
}

function nameVariants(inflow: Inflow): string[] {
  const payer = inflow.payer.toLowerCase();
  const first = payer.split(/\s+/)[0];
  return [...new Set([payer, first, inflow.id.toLowerCase(), inflow.id.toLowerCase().replace(/^in_/, "")])].filter((n) => n.length >= 3);
}
