import type { BankAdapter } from "@/contracts/interfaces";
import { MockBank } from "./mock";

export function createBank(): BankAdapter {
  if ((process.env.BANK_MODE ?? "mock") !== "mock") {
    throw new Error("Real Airwallex adapter is not implemented yet. Set BANK_MODE=mock.");
  }
  return new MockBank();
}
