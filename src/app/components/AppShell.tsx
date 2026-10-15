"use client";

import type { BusinessState } from "@/contracts/types";
import { StoreProvider } from "../lib/store";
import AskAnywhere from "./AskAnywhere";
import ControlCenter from "./ControlCenter";
import Copilot from "./Copilot";
import ForecastPanel from "./ForecastPanel";
import TopBar from "./TopBar";

export default function AppShell({ state }: { state: BusinessState }) {
  return (
    <StoreProvider base={state}>
      <div className="app">
        <TopBar />
        <div className="layout">
          <ControlCenter />
          <div className="right">
            <ForecastPanel />
            <Copilot />
          </div>
        </div>
        <AskAnywhere />
      </div>
    </StoreProvider>
  );
}
