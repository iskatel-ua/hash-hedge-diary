/**
 * Metric: Hourly Win Rate
 *
 * Buckets trades by local browser hour (based on trade open time) and
 * computes win rate for each hour. Visual axis for UI is 0..100.
 */

function getPnl(trade) {
  const val =
    trade.pnl ?? trade.profit ?? trade.realizedPnl ?? trade.income ??
    trade.netProfit ?? trade.realizeProfit ?? trade.realizedProfit;
  const num = Number(val);
  return Number.isFinite(num) ? num : null;
}

function isWin(trade) {
  const result = trade.result ?? trade.tradeResult ?? trade.status ?? trade.tradeStatus;
  if (typeof result === 'string') {
    const s = result.toLowerCase();
    if (s === 'win' || s === 'profit' || s === 'success') return true;
    if (s === 'loss' || s === 'lose' || s === 'fail') return false;
  }
  const pnl = getPnl(trade);
  if (pnl !== null) return pnl > 0;
  return false;
}

function getOpenHourLocal(trade) {
  const raw = trade.createdDate ?? trade.openTime ?? trade.createTime ?? trade.ctime ?? trade.tradeTime;
  if (raw == null) return null;

  const ts = Number(raw);
  const d = Number.isFinite(ts) && ts > 1e12
    ? new Date(ts)
    : Number.isFinite(ts) && ts > 1e6
      ? new Date(ts * 1000)
      : new Date(raw);

  return isNaN(d.getTime()) ? null : d.getHours();
}

function formatHour(hour) {
  return String(hour).padStart(2, '0');
}

export default {
  id: 'hourlyWinRate',
  label: 'Hourly Win Rate',
  compute(trades) {
    const stats = Array.from({ length: 24 }, () => ({ total: 0, wins: 0 }));

    for (const trade of trades) {
      const hour = getOpenHourLocal(trade);
      if (hour === null) continue;
      stats[hour].total += 1;
      if (isWin(trade)) stats[hour].wins += 1;
    }

    const active = stats
      .map((s, hour) => ({
        hour,
        total: s.total,
        wins: s.wins,
        rate: s.total > 0 ? (s.wins / s.total) * 100 : null,
      }))
      .filter(x => x.rate !== null);

    if (!active.length) {
      return {
        value: null,
        display: 'N/A',
        status: 'neutral',
        sub: 'No time data',
        bars: Array.from({ length: 24 }, (_, hour) => ({
          hour,
          hourLabel: formatHour(hour),
          hasData: false,
          winPct: 0,
          lossPct: 0,
          status: 'neutral',
        })),
      };
    }

    const bars = stats.map((s, hour) => {
      if (s.total === 0) {
        return {
          hour,
          hourLabel: formatHour(hour),
          hasData: false,
          winPct: 0,
          lossPct: 0,
          status: 'neutral',
        };
      }

      const rate = (s.wins / s.total) * 100;
      return {
        hour,
        hourLabel: formatHour(hour),
        hasData: true,
        rate,
        winPct: rate,
        lossPct: 100 - rate,
        status: rate > 50 ? 'positive' : rate < 50 ? 'negative' : 'neutral',
      };
    });

    const best = active.reduce((acc, cur) => (cur.rate > acc.rate ? cur : acc), active[0]);

    return {
      value: best.rate,
      display: `${formatHour(best.hour)}:00 - ${best.rate.toFixed(1)}%`,
      status: best.rate > 50 ? 'positive' : best.rate < 50 ? 'negative' : 'neutral',
      sub: null,
      bars,
    };
  },
};
