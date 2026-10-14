import type { BusinessState, Currency, DailyPosition, Forecast, ForecastEvent, Shortfall } from "@/contracts/types";
import { addDays, convertAmount, effectiveDate } from "./util";

export function forecast(state: BusinessState, horizonDays: number): Forecast {
  const bal: Record<string, number> = {};
  const add = (c: Currency, n: number) => (bal[c] = (bal[c] ?? 0) + n);
  for (const b of state.balances) add(b.currency, b.available);
  for (const o of state.obligations) add(o.currency, 0);
  for (const i of state.inflows) add(i.currency, 0);

  const days: DailyPosition[] = [];
  const shortfalls: Shortfall[] = [];
  const seen = new Set<string>();

  for (let d = 0; d < horizonDays; d++) {
    const date = addDays(state.asOf, d);
    const events: ForecastEvent[] = [];
    const dueToday = state.obligations.filter((o) => effectiveDate(o.dueDate, state.asOf) === date);

    for (const o of dueToday) {
      add(o.currency, -o.amount);
      events.push({ kind: "obligation", refId: o.id, currency: o.currency, signedAmount: -o.amount });
    }
    for (const i of state.inflows) {
      if (effectiveDate(i.expectedDate, state.asOf) !== date) continue;
      add(i.currency, i.amount);
      events.push({ kind: "inflow", refId: i.id, currency: i.currency, signedAmount: i.amount });
    }

    for (const cur of Object.keys(bal) as Currency[]) {
      if (bal[cur] >= 0 || seen.has(cur)) continue;
      seen.add(cur);
      const gap = -bal[cur];
      let spare = 0;
      for (const other of Object.keys(bal) as Currency[]) {
        if (other !== cur && bal[other] > 0) spare += convertAmount(state, bal[other], other, cur);
      }
      shortfalls.push({
        date,
        currency: cur,
        gap,
        coveredByOtherCurrencies: spare >= gap,
        blockedObligationIds: dueToday.filter((o) => o.currency === cur).map((o) => o.id),
      });
    }

    days.push({
      date,
      balances: { ...bal },
      totalInBase: Math.round(
        Object.entries(bal).reduce((s, [c, v]) => s + convertAmount(state, v, c as Currency, state.baseCurrency), 0),
      ),
      events,
    });
  }

  return { horizonDays, days, shortfalls, firstShortfallDate: shortfalls.map((s) => s.date).sort()[0] ?? null };
}
