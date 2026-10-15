"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from "react";
import type { BusinessState } from "@/contracts/types";
import { addDays } from "@/engine/util";
import { PLAN_LEVEL, violations } from "@/engine/validate";
import { completedSeed, dayDate, seedDecisions } from "@/scenarios/crunch";
import { agent, type AgentReply } from "./agent";
import { derive, type Derived, type PersistedState } from "./derive";
import { humanize, money } from "./format";
import type { ChatMessage, Completed, Tab, UiContext } from "./types";

interface State extends PersistedState {
  chat: ChatMessage[];
  context: UiContext | null;
  highlight: string | null;
  pulse: number;
  tab: Tab;
  moveTarget: { amount: number; by: string } | null;
  notice: string | null;
}

type Action =
  | { type: "approve" | "reject" | "reopen"; id: string }
  | { type: "defer"; obligationId: string; days: number }
  | { type: "fundNow"; obligationId: string }
  | { type: "undo"; id: string }
  | { type: "transfer"; assetId: string; amount: number | null }
  | { type: "tab"; tab: Tab }
  | { type: "moveTarget"; amount: number; by: string }
  | { type: "context"; context: UiContext | null }
  | { type: "user"; text: string; context: UiContext | null }
  | { type: "agent"; reply: AgentReply }
  | { type: "proposal"; id: string; state: "applied" | "dismissed" }
  | { type: "highlight"; key: string | null }
  | { type: "notice"; text: string | null };

let seq = 0;
const nid = (p: string) => `${p}_${++seq}`;

function initial(base: BusinessState): State {
  const completed: Completed[] = completedSeed.map((c) => ({
    id: c.id,
    executedDay: c.executedDay,
    obligation: { id: `ob_${c.id}`, payee: c.payee, category: "supplier", amount: c.amount, currency: c.currency, dueDate: dayDate(3), priority: 3 },
  }));
  const s: State = {
    base,
    decisions: seedDecisions.map((d) => ({ ...d, source: "agent" as const })),
    completed,
    notes: {},
    transfers: {},
    chat: [],
    context: null,
    highlight: null,
    pulse: 0,
    tab: "payments",
    moveTarget: null,
    notice: null,
  };
  s.chat = [{ id: nid("m"), role: "agent", text: agent.opening(derive(s)) }];
  return s;
}

const adjust = (b: BusinessState, currency: string, delta: number): BusinessState => ({
  ...b,
  balances: b.balances.map((x) => (x.currency === currency ? { ...x, available: x.available + delta } : x)),
});

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case "approve":
      return { ...s, notice: null, decisions: s.decisions.map((d) => (d.id === a.id ? { ...d, status: "APPROVED" } : d)) };
    case "reject": {
      const d = s.decisions.find((x) => x.id === a.id);
      const notes = { ...s.notes };
      if (d && "obligationId" in d.decision && d.decision.obligationId) notes[d.decision.obligationId] = "Rejected by you";
      return { ...s, notice: null, notes, decisions: s.decisions.map((x) => (x.id === a.id ? { ...x, status: "REJECTED" } : x)) };
    }
    case "reopen": {
      const d = s.decisions.find((x) => x.id === a.id);
      const notes = { ...s.notes };
      if (d && "obligationId" in d.decision && d.decision.obligationId) delete notes[d.decision.obligationId];
      return { ...s, notice: null, notes, decisions: s.decisions.map((x) => (x.id === a.id ? { ...x, status: "PENDING" } : x)) };
    }
    case "defer": {
      const ob = s.base.obligations.find((o) => o.id === a.obligationId);
      if (!ob) return s;
      const newDate = addDays(ob.dueDate, a.days);
      const decision = { action: "defer" as const, obligationId: ob.id, newDate, reason: `You chose to move this ${a.days} days.` };
      const bad = violations(s.base, [decision]).filter((v) => v.index !== PLAN_LEVEL);
      if (bad.length) return { ...s, notice: `Cannot move ${ob.payee}: ${humanize(bad[0].message)}.` };
      const rest = s.decisions.filter((d) => !("obligationId" in d.decision && d.decision.obligationId === ob.id));
      const notes = { ...s.notes };
      delete notes[ob.id];
      return { ...s, notice: null, notes, decisions: [...rest, { id: nid("d"), decision, status: "APPROVED", source: "user" }] };
    }
    case "fundNow": {
      const ob = s.base.obligations.find((o) => o.id === a.obligationId);
      if (!ob) return s;
      const esc = s.decisions.find((d) => d.status === "PENDING" && "obligationId" in d.decision && d.decision.obligationId === ob.id);
      if (esc) return { ...s, notice: `${ob.payee} needs your approval first.` };
      const have = s.base.balances.find((b) => b.currency === ob.currency)?.available ?? 0;
      if (have < ob.amount) return { ...s, notice: `Not enough in the ${ob.currency} account to pay ${ob.payee} now.` };
      const base = adjust({ ...s.base, obligations: s.base.obligations.filter((o) => o.id !== ob.id) }, ob.currency, -ob.amount);
      const notes = { ...s.notes };
      delete notes[ob.id];
      const next: State = {
        ...s,
        base,
        notice: null,
        notes,
        decisions: s.decisions.filter((d) => !("obligationId" in d.decision && d.decision.obligationId === ob.id)),
        completed: [{ id: nid("done"), obligation: ob, executedDay: 1 }, ...s.completed],
      };
      const low = Math.min(...derive(next).usdPlan);
      const floor = base.policy.reserveFloor;
      if (low < floor.amount) next.notice = `Paid ${ob.payee}, but your ${floor.currency} account now drops to ${money(low, floor.currency)}, below your ${money(floor.amount, floor.currency)} reserve.`;
      return next;
    }
    case "undo": {
      const c = s.completed.find((x) => x.id === a.id);
      if (!c || c.undone) return s;
      const ob = { ...c.obligation, dueDate: c.executedDay === 1 ? c.obligation.dueDate : dayDate(3) };
      const base = adjust({ ...s.base, obligations: [...s.base.obligations, ob] }, ob.currency, ob.amount);
      return { ...s, base, notice: null, notes: { ...s.notes, [ob.id]: "Undone, back in Upcoming" }, completed: s.completed.map((x) => (x.id === a.id ? { ...x, undone: true } : x)) };
    }
    case "transfer": {
      const t = { ...s.transfers };
      if (a.amount == null) delete t[a.assetId];
      else t[a.assetId] = a.amount;
      return { ...s, transfers: t };
    }
    case "tab": return { ...s, tab: a.tab };
    case "moveTarget": return { ...s, moveTarget: { amount: a.amount, by: a.by } };
    case "context": return { ...s, context: a.context };
    case "user":
      return { ...s, pulse: s.pulse + 1, context: a.context, chat: [...s.chat, { id: nid("m"), role: "user", text: a.text, context: a.context ?? undefined }] };
    case "agent":
      return { ...s, pulse: s.pulse + 1, chat: [...s.chat, { id: nid("m"), role: "agent", text: a.reply.text, proposal: a.reply.proposal, proposalState: a.reply.proposal ? "open" : undefined }] };
    case "proposal": return { ...s, chat: s.chat.map((m) => (m.id === a.id ? { ...m, proposalState: a.state } : m)) };
    case "highlight": return { ...s, highlight: a.key };
    case "notice": return { ...s, notice: a.text };
  }
}

interface Store {
  s: State;
  d: Derived;
  approve(id: string): void;
  reject(id: string): void;
  reopen(id: string): void;
  deferPayment(obligationId: string, days: number): void;
  fundNow(obligationId: string): void;
  undo(id: string): void;
  setTransfer(assetId: string, amount: number | null): void;
  setTab(t: Tab): void;
  setMoveTarget(amount: number, by: string): void;
  setContext(c: UiContext | null): void;
  ask(text: string, ctx: UiContext | null): void;
  applyProposal(msgId: string): void;
  dismissProposal(msgId: string): void;
  flash(key: string): void;
  dismissNotice(): void;
}

const Ctx = createContext<Store | null>(null);

export function StoreProvider({ base, children }: { base: BusinessState; children: ReactNode }) {
  const [s, dispatch] = useReducer(reducer, base, initial);
  const ref = useRef(s);
  ref.current = s;
  const d = useMemo(() => derive(s), [s.base, s.decisions, s.completed, s.notes, s.transfers]); // eslint-disable-line react-hooks/exhaustive-deps
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const flash = useCallback((key: string) => {
    dispatch({ type: "highlight", key });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => dispatch({ type: "highlight", key: null }), 2600);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);

  const store = useMemo<Store>(
    () => ({
      s,
      d,
      approve: (id) => dispatch({ type: "approve", id }),
      reject: (id) => dispatch({ type: "reject", id }),
      reopen: (id) => dispatch({ type: "reopen", id }),
      deferPayment: (obligationId, days) => dispatch({ type: "defer", obligationId, days }),
      fundNow: (obligationId) => dispatch({ type: "fundNow", obligationId }),
      undo: (id) => dispatch({ type: "undo", id }),
      setTransfer: (assetId, amount) => dispatch({ type: "transfer", assetId, amount }),
      setTab: (tab) => dispatch({ type: "tab", tab }),
      setMoveTarget: (amount, by) => dispatch({ type: "moveTarget", amount, by }),
      setContext: (context) => dispatch({ type: "context", context }),
      ask: (text, ctx) => {
        dispatch({ type: "user", text, context: ctx });
        if (ctx) flash(`${ctx.type}:${ctx.id}`);
        const reply = agent.answer(text, ctx, derive(ref.current));
        setTimeout(() => dispatch({ type: "agent", reply }), 380);
      },
      applyProposal: (msgId) => {
        const m = ref.current.chat.find((x) => x.id === msgId);
        const p = m?.proposal;
        if (!p) return;
        let confirm = "";
        if (p.kind === "defer") {
          dispatch({ type: "defer", obligationId: p.obligationId, days: p.days });
          confirm = `Done. ${p.label}. The forecast has been updated.`;
        } else {
          dispatch({ type: "transfer", assetId: p.assetId, amount: p.amount });
          confirm = `Added: ${p.label}, about ${money(p.amount, "USD")}. It still needs your approval before any money moves.`;
        }
        dispatch({ type: "proposal", id: msgId, state: "applied" });
        dispatch({ type: "agent", reply: { text: confirm } });
      },
      dismissProposal: (id) => dispatch({ type: "proposal", id, state: "dismissed" }),
      flash,
      dismissNotice: () => dispatch({ type: "notice", text: null }),
    }),
    [s, d, flash],
  );

  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

export function useStore(): Store {
  const v = useContext(Ctx);
  if (!v) throw new Error("useStore must be used inside StoreProvider");
  return v;
}
