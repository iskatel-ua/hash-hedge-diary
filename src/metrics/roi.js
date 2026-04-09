/**
 * Metric #8: ROI
 * ROI = totalPnL / totalMargin * 100
 */

function getPnl(trade) {
  const val =
    trade.pnl ?? trade.profit ?? trade.realizedPnl ?? trade.income ??
    trade.netProfit ?? trade.realizeProfit ?? trade.realizedProfit;
  const num = Number(val);
  return Number.isFinite(num) ? num : null;
}

function getMargin(trade) {
  const val =
    trade.margin ?? trade.usedMargin ?? trade.marginUsed ?? trade.initialMargin ??
    trade.cost ?? trade.positionMargin ?? trade.notional;
  const num = Number(val);
  return Number.isFinite(num) ? num : null;
}

export default {
  id: 'roi',
  label: 'ROI',
  compute(trades) {
    const pnls = trades.map(getPnl).filter(v => v !== null);
    const margins = trades.map(getMargin).filter(v => v !== null && v > 0);

    if (!pnls.length || !margins.length) {
      return { value: null, display: 'N/A', status: 'neutral', sub: 'No margin fields' };
    }

    const totalPnl = pnls.reduce((a, b) => a + b, 0);
    const totalMargin = margins.reduce((a, b) => a + b, 0);
    if (!totalMargin) {
      return { value: null, display: 'N/A', status: 'neutral', sub: 'Zero margin' };
    }

    const roi = (totalPnl / totalMargin) * 100;
    const sign = roi >= 0 ? '+' : '';

    return {
      value: roi,
      display: `${sign}${roi.toFixed(2)}%`,
      status: roi > 0 ? 'positive' : roi < 0 ? 'negative' : 'neutral',
      sub: `PnL ${totalPnl.toFixed(2)} / Margin ${totalMargin.toFixed(2)}`,
    };
  },
};
