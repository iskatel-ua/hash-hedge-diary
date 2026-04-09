/**
 * Metric #5: Median PnL
 */

function getPnl(trade) {
  const val =
    trade.pnl ?? trade.profit ?? trade.realizedPnl ?? trade.income ??
    trade.netProfit ?? trade.realizeProfit ?? trade.realizedProfit;
  const num = Number(val);
  return Number.isFinite(num) ? num : null;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

export default {
  id: 'medianPnl',
  label: 'Median PnL',
  compute(trades) {
    const values = trades.map(getPnl).filter(v => v !== null);
    const med = median(values);

    if (med === null) {
      return { value: null, display: 'N/A', status: 'neutral', sub: 'No PnL fields' };
    }

    const sign = med >= 0 ? '+' : '';
    return {
      value: med,
      display: `${sign}${med.toFixed(2)} USDT`,
      status: med > 0 ? 'positive' : med < 0 ? 'negative' : 'neutral',
      sub: `${values.length} trades`,
    };
  },
};
