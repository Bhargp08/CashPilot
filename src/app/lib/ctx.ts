import type { UiContext } from "./types";

export const ctxKey = (c: UiContext) => `${c.type}:${c.id}`;

/** Marks an element as something the user can double-click to ask the AI about. */
export function ctxAttrs(c: UiContext) {
  return { "data-context": JSON.stringify(c), "data-ctx-key": ctxKey(c) };
}

export const ASK_EVENT = "cashpilot:ask";

export function openAsk(el: Element, context: UiContext) {
  const r = el.getBoundingClientRect();
  window.dispatchEvent(new CustomEvent(ASK_EVENT, { detail: { x: r.left + r.width / 2, y: r.bottom, context } }));
}
