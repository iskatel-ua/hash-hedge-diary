/**
 * Metric #4: Average PnL per trade
 */

function getPnl(trade) {
  const val =
    trade.pnl ?? trade.profit ?? trade.realizedPnl ?? trade.income ??
    trade.netProfit ?? trade.realizeProfit ?? trade.realizedProfit;
  const num = Number(val);
  return Number.isFinite(num) ? num : null;
}

export default {
  id: 'averagePnl',
  label: 'Avg PnL',
  compute(trades) {
    const values = trades.map(getPnl).filter(v => v !== null);
    if (!values.length) {
      return { value: null, display: 'N/A', status: 'neutral', sub: 'No PnL fields' };
    }

    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const sign = avg >= 0 ? '+' : '';
    return {
      value: avg,
      display: `${sign}${avg.toFixed(2)} USDT`,
      status: avg > 0 ? 'positive' : avg < 0 ? 'negative' : 'neutral',
      sub: `${values.length} trades`,
    };
  },
};
