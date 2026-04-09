/**
 * Metric: Win Rate
 * wins / total trades * 100
 * Win is determined by: explicit result field → fallback to pnl > 0
 */

function getPnl(trade) {
  const val =
    trade.pnl ?? trade.profit ?? trade.realizedPnl ?? trade.income ??
    trade.netProfit ?? trade.realizeProfit ?? trade.realizedProfit;
  return val !== undefined && val !== null ? Number(val) : null;
}

function isWin(trade) {
  const result = trade.result ?? trade.tradeResult ?? trade.status ?? trade.tradeStatus;
  if (typeof result === 'string') {
    const s = result.toLowerCase();
    if (s === 'win' || s === 'profit' || s === 'success') return true;
    if (s === 'loss' || s === 'lose' || s === 'fail')     return false;
  }
  // Fall back to PNL sign
  const pnl = getPnl(trade);
  if (pnl !== null) return pnl > 0;
  return false;
}

export default {
  id:    'winRate',
  label: 'Win Rate',
  compute(trades) {
    if (!trades.length) return { value: 0, display: '—', status: 'neutral', sub: 'No trades' };

    const wins   = trades.filter(isWin).length;
    const losses = trades.length - wins;
    const rate   = (wins / trades.length) * 100;

    return {
      value:   rate,
      display: `${rate.toFixed(2)}%`,
      status:  rate >= 50 ? 'positive' : 'negative',
      sub:     `${wins} W / ${losses} L`,
    };
  },
};
