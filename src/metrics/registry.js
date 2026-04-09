/**
 * Metrics Registry
 * Add new metrics by calling registerMetric() with a metric definition object.
 *
 * Metric shape:
 * {
 *   id:      string          — unique identifier
 *   label:   string          — display label
 *   compute: (trades, filters) => {
 *     value:   any           — raw computed value
 *     display: string        — formatted string for UI
 *     status:  'positive' | 'negative' | 'neutral'
 *     sub:     string|null   — optional subtitle shown below display
 *   }
 * }
 */

const _metrics = [];

export function registerMetric(metric) {
  if (!metric.id || typeof metric.compute !== 'function') {
    throw new Error(`[Metrics] Invalid metric: must have id and compute(). Received: ${JSON.stringify(metric)}`);
  }
  _metrics.push(metric);
}

export function computeAll(trades, filters = {}) {
  return _metrics.map(metric => {
    try {
      const result = metric.compute(trades, filters);
      return {
        id:      metric.id,
        label:   metric.label,
        value:   result.value,
        display: result.display,
        status:  result.status ?? 'neutral',
        sub:     result.sub ?? null,
        bars:    result.bars ?? null,
      };
    } catch (e) {
      console.error(`[Metrics] Error computing "${metric.id}":`, e);
      return {
        id:      metric.id,
        label:   metric.label,
        value:   null,
        display: 'N/A',
        status:  'neutral',
        sub:     null,
      };
    }
  });
}

export function getRegisteredMetrics() {
  return _metrics.map(m => ({ id: m.id, label: m.label }));
}
