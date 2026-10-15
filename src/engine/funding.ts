import type { Asset, BusinessState, DailyPosition, FundingAnalysis, FundingOption, Inflow, IsoDate } from "@/contracts/types";
import { addDays, convertAmount } from "./util";

/** How much extra cash the floor currency needs to stay at or above the reserve floor, and by when. */
export function neededFunding(state: BusinessState, days: DailyPosition[]): { need: number; by: IsoDate } {
  const cur = state.policy.reserveFloor.currency;
  const floor = state.policy.reserveFloor.amount;
  let need = 0;
  let by: IsoDate = state.asOf;
  for (const d of days) {
    const b = d.balances[cur] ?? 0;
    if (b < floor && need === 0) by = d.date;
    need = Math.max(need, floor - b);
  }
  return { need: Math.max(0, need), by };
}

export function costFor(asset: Asset, amount: number): number {
  const taxed = Math.max(0, amount - (asset.freeAmount ?? 0));
  return Math.round((taxed * asset.costBps) / 10_000);
}

function optionFor(state: BusinessState, a: Asset, amount: number, needBy: IsoDate, need: number): FundingOption {
  const cost = costFor(a, amount);
  const arrivesBy = addDays(state.asOf, a.daysToCash);
  return {
    assetId: a.id,
    name: a.name,
    kind: a.kind,
    amount,
    cost,
    netArriving: amount - cost,
    arrivesBy,
    inTime: arrivesBy <= needBy,
    coversNeed: amount >= need,
    restricted: !!a.restricted,
    costNote: a.costNote,
  };
}

/** Ranks every source for a funding need and picks the cheapest mix that closes it. Pure and deterministic. */
export function fundingOptions(state: BusinessState, need: number, needBy: IsoDate): FundingAnalysis {
  const cur = state.policy.reserveFloor.currency;
  const assets = (state.otherAssets ?? []).map((a) => ({ a, avail: convertAmount(state, a.value, a.currency, cur) }));

  const options = assets
    .map(({ a, avail }) => optionFor(state, a, Math.min(need, avail), needBy, need))
    .filter((o) => o.amount > 0)
    .sort((x, y) => Number(y.inTime) - Number(x.inTime) || Number(x.restricted) - Number(y.restricted) || x.cost - y.cost || x.arrivesBy.localeCompare(y.arrivesBy));

  // Greedy by cost per dollar moved; retirement money only if nothing else can close the gap.
  const order = [...assets].sort((p, q) => {
    const rate = (x: (typeof assets)[number]) => (x.a.costBps * (1 - (x.a.freeAmount ?? 0) / Math.max(x.avail, 1)));
    return Number(!!p.a.restricted) - Number(!!q.a.restricted) || rate(p) - rate(q) || p.a.daysToCash - q.a.daysToCash;
  });
  const mix: FundingOption[] = [];
  let left = need;
  for (const { a, avail } of order) {
    if (left <= 0) break;
    if (addDays(state.asOf, a.daysToCash) > needBy && !a.restricted) continue;
    const take = Math.min(left, avail);
    if (take <= 0) continue;
    mix.push(optionFor(state, a, take, needBy, take));
    left -= take;
  }
  return {
    currency: cur,
    need,
    needBy,
    options,
    mix,
    mixCost: mix.reduce((s, o) => s + o.cost, 0),
    mixCoversNeed: left <= 0,
  };
}

/** The inflow a transfer produces, so the normal forecast can show its effect. */
export function transferInflow(state: BusinessState, assetId: string, amount: number): Inflow | null {
  const a = state.otherAssets?.find((x) => x.id === assetId);
  if (!a) return null;
  const take = Math.min(amount, convertAmount(state, a.value, a.currency, state.policy.reserveFloor.currency));
  return {
    id: `xfer_${assetId}`,
    payer: `Transfer from ${a.name}`,
    amount: take - costFor(a, take),
    currency: state.policy.reserveFloor.currency,
    expectedDate: addDays(state.asOf, a.daysToCash),
    confidence: 1,
  };
}
