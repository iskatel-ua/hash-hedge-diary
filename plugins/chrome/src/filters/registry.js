/**
 * Filters Registry
 * Add new filters by calling registerFilter() with a filter definition object.
 *
 * Filter shape:
 * {
 *   id:     string          — unique identifier (used as key in activeFilters map)
 *   label:  string          — display label
 *   apply:  (trades, filterValue) => trades   — returns filtered array
 * }
 *
 * Usage:
 *   applyAll(trades, { dateRange: { from: '2024-01-01', to: '2024-12-31' } })
 */

const _filters = [];

export function registerFilter(filter) {
  if (!filter.id || typeof filter.apply !== 'function') {
    throw new Error(`[Filters] Invalid filter: must have id and apply(). Received: ${JSON.stringify(filter)}`);
  }
  _filters.push(filter);
}

export function applyAll(trades, activeFilters = {}) {
  let result = trades;
  for (const filter of _filters) {
    if (activeFilters[filter.id] !== undefined) {
      result = filter.apply(result, activeFilters[filter.id]);
    }
  }
  return result;
}

export function getFilters() {
  return _filters.map(f => ({ id: f.id, label: f.label }));
}
