/**
 * Metric #12: Recovery Factor
 * Recovery = Net Profit / Max Drawdown
 */

function getPnl(trade) {
  const val =
    trade.pnl ?? trade.profit ?? trade.realizedPnl ?? trade.income ??
    trade.netProfit ?? trade.realizeProfit ?? trade.realizedProfit;
  const num = Number(val);
  return Number.isFinite(num) ? num : null;
}

function getTime(trade) {
  const val =
    trade.closeTime ?? trade.closedAt ?? trade.createTime ?? trade.openTime ??
    trade.timestamp ?? trade.time;
  const num = Number(val);
  return Number.isFinite(num) ? num : null;
}

function maxDrawdownFromPnls(pnls) {
  let equity = 0;
  let peak = 0;
  let maxDd = 0;

  for (const pnl of pnls) {
    equity += pnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
  }
  return maxDd;
}

export default {
  id: 'recoveryFactor',
  label: 'Recovery',
  compute(trades) {
    const normalized = trades
      .map(t => ({ pnl: getPnl(t), ts: getTime(t) }))
      .filter(x => x.pnl !== null);

    if (!normalized.length) {
      return { value: null, display: 'N/A', status: 'neutral', sub: 'No PnL fields' };
    }

    const hasTs = normalized.some(x => x.ts !== null);
    if (hasTs) {
      normalized.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
    }

    const pnls = normalized.map(x => x.pnl);
    const net = pnls.reduce((a, b) => a + b, 0);
    const maxDd = maxDrawdownFromPnls(pnls);

    if (maxDd === 0) {
      if (net > 0) {
        return { value: Infinity, display: 'inf', status: 'positive', sub: 'No drawdown' };
      }
      return { value: null, display: 'N/A', status: 'neutral', sub: 'No drawdown' };
    }

    const recovery = net / maxDd;
    const sign = recovery >= 0 ? '+' : '';

    return {
      value: recovery,
      display: `${sign}${recovery.toFixed(2)}`,
      status: recovery > 0 ? 'positive' : recovery < 0 ? 'negative' : 'neutral',
      sub: `Net ${net.toFixed(2)} / MDD ${maxDd.toFixed(2)}`,
    };
  },
};
