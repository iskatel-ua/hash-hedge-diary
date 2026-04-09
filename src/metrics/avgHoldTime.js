/**
 * Metric: Average Hold Time
 * Computes mean duration between open and close of each trade.
 * Handles unix-ms, unix-s, and ISO string timestamps.
 */

function toMs(raw) {
  if (raw == null) return null;
  const ts = Number(raw);
  if (Number.isFinite(ts) && ts > 1e12) return ts;           // unix ms
  if (Number.isFinite(ts) && ts > 1e6)  return ts * 1000;   // unix s
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d.getTime();
}

function getDuration(trade) {
  const open  = toMs(trade.createdDate ?? trade.openTime  ?? trade.createTime ?? trade.ctime  ?? trade.tradeTime);
  const close = toMs(trade.updatedDate ?? trade.closeTime ?? trade.updateTime ?? trade.updateAt ?? trade.time);
  if (open === null || close === null || close <= open) return null;
  return close - open; // ms
}

function fmtDuration(ms) {
  const totalSec = Math.round(ms / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (d > 0)          return `${d}d ${h}h ${m}m`;
  if (h > 0)          return `${h}h ${m}m`;
  if (m > 0)          return `${m}m`;
  return `${totalSec}s`;
}

export default {
  id: 'avgHoldTime',
  label: 'Avg Hold Time',
  compute(trades) {
    const durations = trades.map(getDuration).filter(v => v !== null);
    if (!durations.length) {
      return { value: null, display: 'N/A', status: 'neutral', sub: 'No time fields' };
    }

    const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
    const min = Math.min(...durations);
    const max = Math.max(...durations);

    return {
      value: avg,
      display: fmtDuration(avg),
      status: 'neutral',
      sub: `min ${fmtDuration(min)} · max ${fmtDuration(max)}`,
    };
  },
};
