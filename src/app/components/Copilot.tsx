"use client";

import { useEffect, useRef, useState } from "react";
import { agent } from "../lib/agent";
import { useStore } from "../lib/store";

export default function Copilot() {
  const { s, d, ask, setContext, applyProposal, dismissProposal } = useStore();
  const [draft, setDraft] = useState("");
  const log = useRef<HTMLDivElement>(null);
  const [pulsing, setPulsing] = useState(false);

  useEffect(() => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
    if (s.pulse === 0) return;
    setPulsing(true);
    const t = setTimeout(() => setPulsing(false), 900);
    return () => clearTimeout(t);
  }, [s.chat.length, s.pulse]);

  const suggestions = agent.suggestions(d, s.context);

  function send(text: string) {
    const q = text.trim();
    if (!q) return;
    setDraft("");
    ask(q, s.context);
  }

  return (
    <section className={`panel copilot ${pulsing ? "pulse" : ""}`} aria-label="AI copilot">
      <div className="panel-head"><h2>AI Copilot</h2></div>
      <div className="log" ref={log} role="log" aria-live="polite">
        {s.chat.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            {m.context && <div className="ctx-note">About: {m.context.label}</div>}
            <div className="bubble">{m.text}</div>
            {m.proposal && (
              <div className="proposal">
                <div className="muted small">Proposed change</div>
                <b>{m.proposal.label}</b>
                {m.proposalState === "open" ? (
                  <div className="btns">
                    <button className="btn go small" onClick={() => applyProposal(m.id)}>Apply</button>
                    <button className="btn small" onClick={() => dismissProposal(m.id)}>Dismiss</button>
                  </div>
                ) : (
                  <div className="muted small">{m.proposalState === "applied" ? "Applied" : "Dismissed"}</div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="composer-area">
        {s.context && (
          <div className="ctx-chip">
            About: {s.context.label}
            <button aria-label="Clear context" onClick={() => setContext(null)}>×</button>
          </div>
        )}
        <div className="chips">
          {suggestions.map((t) => (
            <button key={t} className="chip" onClick={() => send(t)}>{t}</button>
          ))}
        </div>
        <form className="composer" onSubmit={(e) => { e.preventDefault(); send(draft); }}>
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Ask CashPilot anything…" aria-label="Message CashPilot" />
          <button type="submit" className="btn go" disabled={!draft.trim()}>Send</button>
        </form>
      </div>
    </section>
  );
}
