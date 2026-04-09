/**
 * Metric #23: Volatility of returns (std dev of trade PnL)
 */

function getPnl(trade) {
  const val =
    trade.pnl ?? trade.profit ?? trade.realizedPnl ?? trade.income ??
    trade.netProfit ?? trade.realizeProfit ?? trade.realizedProfit;
  const num = Number(val);
  return Number.isFinite(num) ? num : null;
}

function sampleStdDev(values) {
  const n = values.length;
  if (n < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (n - 1);
  return Math.sqrt(variance);
}

export default {
  id: 'pnlVolatility',
  label: 'Volatility',
  compute(trades) {
    const values = trades.map(getPnl).filter(v => v !== null);
    if (!values.length) {
      return { value: null, display: 'N/A', status: 'neutral', sub: 'No PnL fields' };
    }

    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const std = sampleStdDev(values);
    const cv = mean !== 0 ? Math.abs(std / mean) : null;

    return {
      value: std,
      display: `${std.toFixed(2)} USDT`,
      status: 'neutral',
      sub: cv === null ? 'CV N/A' : `CV ${(cv * 100).toFixed(1)}%`,
    };
  },
};
