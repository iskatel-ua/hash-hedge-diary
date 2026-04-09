/**
 * Metric: Best Days
 * Groups trades by day of week (UTC), computes win rate % per day.
 * Helps identify which weekdays to trade and which to avoid.
 */

// Mon=1..Sat=6,Sun=0 → display order Mon–Sun
const MON_FIRST = [1, 2, 3, 4, 5, 6, 0];

function getDow(trade) {
  const raw =
    trade.updatedDate ?? trade.closeTime ?? trade.updateTime ?? trade.tradeTime ??
    trade.ctime ?? trade.createTime ?? trade.updateAt ?? trade.time;
  if (raw == null) return null;
  const ts = Number(raw);
  const d = Number.isFinite(ts) && ts > 1e10
    ? new Date(ts)
    : Number.isFinite(ts) && ts > 1e6
      ? new Date(ts * 1000)
      : new Date(raw);
  return isNaN(d.getTime()) ? null : d.getUTCDay(); // 0=Sun
}

export default {
  id: 'bestDays',
  label: 'Best Days',
  compute(trades) {
    const stats = Array.from({ length: 7 }, () => ({ total: 0, wins: 0 }));

    for (const trade of trades) {
      const dow = getDow(trade);
      if (dow === null) continue;
      const pnl = Number(trade.netProfit ?? trade.pnl ?? trade.profit ?? trade.realizedPnl ?? 0);
      if (!Number.isFinite(pnl)) continue;
      stats[dow].total++;
      if (pnl > 0) stats[dow].wins++;
    }

    const active = stats
      .map((s, i) => ({ dow: i, ...s, wr: s.total > 0 ? s.wins / s.total * 100 : null }))
      .filter(s => s.wr !== null);

    if (!active.length) {
      return { value: null, display: 'N/A', status: 'neutral', sub: 'No data' };
    }

    const sorted = [...active].sort((a, b) => b.wr - a.wr);
    const best  = sorted[0];
    const worst = sorted[sorted.length - 1];

    // Build bars: Mon→Sun order, store dow index for locale-aware label in popup
    const bars = MON_FIRST.map(i => ({
      dow: i,
      pct: stats[i].total > 0 ? stats[i].wins / stats[i].total * 100 : null,
    }));

    const status = worst.wr < 35 ? 'negative' : best.wr > 65 ? 'positive' : 'neutral';

    return {
      value: best.wr,
      display: `${Math.round(best.wr)}%`,
      status,
      sub: null,
      bars,
    };
  },
};

