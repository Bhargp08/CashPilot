"use client";

import { useEffect, useRef, useState } from "react";
import { respond, type Ctx, type Effect } from "../lib/assistant";

interface Msg {
  id: number;
  role: "user" | "ai";
  text: string;
  tool?: string;
}

const SUGGESTIONS = ["What if Acme pays 5 days late?", "Why defer rent?", "Approve Kessler", "Reset"];

export default function Chat({ ctx, onEffect, intro }: { ctx: Ctx; onEffect: (e: Effect) => void; intro: string }) {
  const [msgs, setMsgs] = useState<Msg[]>([{ id: 0, role: "ai", text: intro }]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const next = useRef(1);

  useEffect(() => {
    const el = end.current?.parentElement;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs, busy]);

  function send(text: string) {
    const q = text.trim();
    if (!q || busy) return;
    setDraft("");
    setMsgs((m) => [...m, { id: next.current++, role: "user", text: q }]);
    setBusy(true);
    setTimeout(() => {
      const r = respond(q, ctx);
      if (r.effect) onEffect(r.effect);
      setMsgs((m) => [...m, { id: next.current++, role: "ai", text: r.text, tool: r.tool }]);
      setBusy(false);
    }, 450);
  }

  return (
    <aside className="chat" aria-label="CashPilot assistant">
      <div className="chat-head">
        <span className="pulse" aria-hidden />
        <div>
          <div className="chat-title">CashPilot AI</div>
          <div className="chat-sub">Watching your accounts</div>
        </div>
      </div>

      <div className="chat-log" role="log" aria-live="polite">
        {msgs.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            {m.tool && <div className="tool">{m.tool}</div>}
            <div className="bubble">{m.text}</div>
          </div>
        ))}
        {busy && (
          <div className="msg ai">
            <div className="bubble typing" aria-label="CashPilot is working">
              <i /><i /><i />
            </div>
          </div>
        )}
        <div ref={end} />
      </div>

      <div className="chips">
        {SUGGESTIONS.map((s) => (
          <button key={s} className="chip" onClick={() => send(s)} disabled={busy}>
            {s}
          </button>
        ))}
      </div>

      <form className="composer" onSubmit={(e) => { e.preventDefault(); send(draft); }}>
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Ask CashPilot to do something" aria-label="Message CashPilot" />
        <button type="submit" disabled={!draft.trim() || busy} aria-label="Send">
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      </form>
    </aside>
  );
}
