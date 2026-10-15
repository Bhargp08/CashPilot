"use client";

import { useEffect, useRef, useState } from "react";
import { ASK_EVENT } from "../lib/ctx";
import { useStore } from "../lib/store";
import type { UiContext } from "../lib/types";

interface Anchor { x: number; y: number; context: UiContext }
const OPTIONS = [
  { id: "ask", label: "Ask AI about this", prefill: "" },
  { id: "explain", label: "Explain this", prefill: "Explain this" },
  { id: "whatif", label: "What if this changes?", prefill: "What if this changes?" },
] as const;

export default function AskAnywhere() {
  const { ask } = useStore();
  const [menu, setMenu] = useState<Anchor | null>(null);
  const [composer, setComposer] = useState<(Anchor & { text: string }) | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onDbl = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (!t || t.closest("input, textarea, select, button, a, [contenteditable], .copilot, .ask-layer")) return;
      const el = t.closest("[data-context]");
      if (!el) return;
      try {
        const context = JSON.parse(el.getAttribute("data-context") ?? "") as UiContext;
        window.getSelection()?.removeAllRanges();
        setComposer(null);
        setMenu({ x: e.clientX, y: e.clientY, context });
      } catch {
        /* ignore malformed context */
      }
    };
    const onAsk = (e: Event) => {
      const { x, y, context } = (e as CustomEvent<Anchor>).detail;
      setComposer(null);
      setMenu({ x, y, context });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setMenu(null); setComposer(null); }
    };
    const onDown = (e: MouseEvent) => {
      if (!(e.target as Element).closest(".ask-layer")) { setMenu(null); setComposer(null); }
    };
    document.addEventListener("dblclick", onDbl);
    window.addEventListener(ASK_EVENT, onAsk);
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("dblclick", onDbl);
      window.removeEventListener(ASK_EVENT, onAsk);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, []);

  useEffect(() => { if (composer) input.current?.focus(); }, [composer]);

  const place = (a: Anchor) => ({ left: Math.max(8, Math.min(a.x, window.innerWidth - 300)), top: Math.max(8, Math.min(a.y + 8, window.innerHeight - 190)) });

  function send() {
    if (!composer || !composer.text.trim()) return;
    ask(composer.text.trim(), composer.context);
    setComposer(null);
  }

  return (
    <div className="ask-layer">
      {menu && (
        <div className="ask-menu" ref={box} style={place(menu)} role="menu">
          <div className="ask-ctx">{menu.context.label}</div>
          {OPTIONS.map((o) => (
            <button key={o.id} role="menuitem" onClick={() => { setComposer({ ...menu, text: o.prefill }); setMenu(null); }}>{o.label}</button>
          ))}
        </div>
      )}
      {composer && (
        <form className="ask-composer" style={place(composer)} onSubmit={(e) => { e.preventDefault(); send(); }}>
          <div className="ctx-chip">About: {composer.context.label}</div>
          <input ref={input} value={composer.text} onChange={(e) => setComposer({ ...composer, text: e.target.value })} placeholder="Ask about this…" aria-label="Question about this item" />
          <div className="btns">
            <button type="submit" className="btn go small" disabled={!composer.text.trim()}>Send</button>
            <button type="button" className="btn small" onClick={() => setComposer(null)}>Cancel</button>
          </div>
        </form>
      )}
    </div>
  );
}
