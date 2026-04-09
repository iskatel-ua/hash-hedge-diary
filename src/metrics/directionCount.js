/**
 * Metric: Direction Count
 * Counts trades split by LONG / SHORT direction.
 * Handles multiple field-name and value conventions used across platforms.
 */

function normalizeDirection(trade) {
  const raw = trade.direction ?? trade.side ?? trade.type ?? trade.tradeType ?? trade.orderSide;
  if (raw === null || raw === undefined) return 'UNKNOWN';
  const s = String(raw).toUpperCase();
  if (s === 'LONG'  || s === 'BUY'  || s === '1') return 'LONG';
  if (s === 'SHORT' || s === 'SELL' || s === '2') return 'SHORT';
  return s; // keep as-is for unexpected values
}

export default {
  id:    'directionCount',
  label: 'Direction Split',
  compute(trades) {
    if (!trades.length) return { value: {}, display: '—', status: 'neutral', sub: 'No trades' };

    const counts = {};
    for (const t of trades) {
      const dir = normalizeDirection(t);
      counts[dir] = (counts[dir] || 0) + 1;
    }

    const long  = counts['LONG']  || 0;
    const short = counts['SHORT'] || 0;
    const other = trades.length - long - short;

    const parts = [];
    if (long)  parts.push(`${long} ↑ LONG`);
    if (short) parts.push(`${short} ↓ SHORT`);
    if (other) parts.push(`${other} OTHER`);

    return {
      value:   counts,
      display: `${long} ↑ / ${short} ↓`,
      status:  'neutral',
      sub:     `Total: ${trades.length}`,
    };
  },
};
