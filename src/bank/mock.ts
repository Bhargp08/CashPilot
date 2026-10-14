import type { BankAdapter, ExecutionResult, FxQuote } from "@/contracts/interfaces";
import type { Balance, BusinessState, Currency, Obligation } from "@/contracts/types";
import { crunchScenario } from "@/scenarios/crunch";
import { convertAmount } from "@/engine/util";

export class MockBank implements BankAdapter {
  private state: BusinessState;
  private paid = new Map<string, string>();
  private n = 0;

  constructor(initial: BusinessState = crunchScenario) {
    this.state = structuredClone(initial);
  }

  async getBalances(): Promise<Balance[]> {
    return structuredClone(this.state.balances);
  }

  async quoteFx(from: Currency, to: Currency, sellAmount: number): Promise<FxQuote> {
    return {
      quoteId: `q_${++this.n}`,
      from,
      to,
      sellAmount,
      buyAmount: convertAmount(this.state, sellAmount, from, to),
      rate: convertAmount(this.state, 1_000_000, from, to) / 1_000_000,
      spreadBps: 20,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
  }

  async convert(q: FxQuote): Promise<ExecutionResult> {
    const src = this.state.balances.find((b) => b.currency === q.from);
    if (!src || src.available < q.sellAmount) return { ok: false, error: "insufficient funds" };
    let dst = this.state.balances.find((b) => b.currency === q.to);
    if (!dst) {
      dst = { accountId: `acc_${q.to.toLowerCase()}`, currency: q.to, available: 0 };
      this.state.balances.push(dst);
    }
    src.available -= q.sellAmount;
    dst.available += q.buyAmount;
    return { ok: true, ref: `conv_${q.quoteId}` };
  }

  async payObligation(o: Obligation): Promise<ExecutionResult> {
    const prior = this.paid.get(o.id);
    if (prior) return { ok: true, ref: prior };
    const acct = this.state.balances.find((b) => b.currency === o.currency);
    if (!acct || acct.available < o.amount) return { ok: false, error: "insufficient funds" };
    acct.available -= o.amount;
    const ref = `pay_${o.id}`;
    this.paid.set(o.id, ref);
    this.state.obligations = this.state.obligations.filter((x) => x.id !== o.id);
    return { ok: true, ref };
  }

  async getBusinessState(): Promise<BusinessState> {
    return structuredClone(this.state);
  }
}
