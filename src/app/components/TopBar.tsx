"use client";

import type { Currency } from "@/contracts/types";
import { money } from "../lib/format";

export type Page = "overview" | "assets" | "move";

interface Chip {
  id: string;
  label: string;
  value: number;
}

interface Props {
  page: Page;
  onPage: (p: Page) => void;
  cash: number;
  chips: Chip[];
  currency: Currency;
  moveBadge: number;
  asOf: string;
}

const NAV: { id: Page; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "assets", label: "Assets" },
  { id: "move", label: "Move money" },
];

export default function TopBar({ page, onPage, cash, chips, currency, moveBadge, asOf }: Props) {
  return (
    <header className="topbar">
      <div className="topbar-row">
        <div className="brand">CashPilot</div>
        <nav className="nav" aria-label="Pages">
          {NAV.map((n) => (
            <button key={n.id} className={page === n.id ? "on" : ""} aria-current={page === n.id ? "page" : undefined} onClick={() => onPage(n.id)}>
              {n.label}
              {n.id === "move" && moveBadge > 0 && <span className="dot-badge" aria-label="needs attention" />}
            </button>
          ))}
        </nav>
        <div className="asof">Demo business · {asOf}</div>
      </div>
      <div className="strip" role="list" aria-label="Your money">
        <button role="listitem" className="strip-chip" onClick={() => onPage("overview")}>
          <span>Business cash</span>
          <b>{money(cash, currency)}</b>
        </button>
        {chips.map((c) => (
          <button key={c.id} role="listitem" className="strip-chip" onClick={() => onPage("assets")}>
            <span>{c.label}</span>
            <b>{money(c.value, currency)}</b>
          </button>
        ))}
      </div>
    </header>
  );
}
