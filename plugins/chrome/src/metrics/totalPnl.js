/**
 * Metric: Total PNL
 * Sum of realized profit/loss across all trades (in USDT).
 */

function getPnl(trade) {
  const val =
    trade.pnl ?? trade.profit ?? trade.realizedPnl ?? trade.income ??
    trade.netProfit ?? trade.realizeProfit ?? trade.realizedProfit;
  return val !== undefined && val !== null ? Number(val) : 0;
}

export default {
  id:    'totalPnl',
  label: 'Total PNL',
  compute(trades) {
    if (!trades.length) return { value: 0, display: '—', status: 'neutral', sub: 'No trades' };

    const sum  = trades.reduce((acc, t) => acc + getPnl(t), 0);
    const sign = sum >= 0 ? '+' : '';

    return {
      value:   sum,
      display: `${sign}${sum.toFixed(2)} USDT`,
      status:  sum > 0 ? 'positive' : sum < 0 ? 'negative' : 'neutral',
      sub:     `across ${trades.length} trades`,
    };
  },
};
