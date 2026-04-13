/**
 * Firefox Background Script
 *
 * Auth strategy — webRequest passive capture (primary):
 *   browser.webRequest.onSendHeaders observes every request the PAGE makes to
 *   cb.hashhedge.com. We capture Authorization / x-* / token-like headers and
 *   store them in memory. When the popup requests data we replay those exact
 *   headers — no tab injection, works without page refresh.
 *
 * Fallback: Bearer token from localStorage (via auth-extractor.js content
 *   script) or from cookie jar.
 */

// Simplified version for Firefox compatibility (no ES modules in background)
const API_URL = 'https://cb.hashhedge.com/v1/cfd/trade/finish?page=1&pageSize=1000&rows=1000&contractType=1&quote=usdt&marginCurrency=usdt';
const OPEN_POSITIONS_URL = 'https://cb.hashhedge.com/v1/cfd/app/accountsCountInfo/2?positionModel=1&marginCurrency=usdt';
const PUBLIC_INSTRUMENTS_URL = 'https://cb.hashhedge.com/v1/cfd/public/instruments?quote=all';

// Storage for auth headers
let capturedHeaders = {};
let cachedToken = null;
const PUBLIC_INSTRUMENTS_TTL_MS = 60_000;
const AUTH_WAIT_TIMEOUT_MS = 12_000;
const TAB_RELOAD_TIMEOUT_MS = 15_000;
const BACKGROUND_REFRESH_INTERVAL_MINUTES = 5;
const BACKGROUND_REFRESH_INTERVAL_MS = BACKGROUND_REFRESH_INTERVAL_MINUTES * 60_000;
const TRADE_CACHE_STORAGE_KEY = 'tradeDataCacheV1';
const BACKGROUND_REFRESH_ALARM = 'hashhedge-refresh-default';
const DEFAULT_FILTERS = {};
const authStateWaiters = new Set();
const publicInstrumentsCache = {
  fetchedAt: 0,
  byKey: null,
  pending: null,
};
let tradeDataCache = null;
const tradeDataRequests = new Map();

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasAuthHeaders(headers) {
  return !!headers && Object.keys(headers).length > 0;
}

function stableStringify(value) {
  if (value === null || value === undefined) {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  if (typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${entries.join(',')}}`;
  }

  return JSON.stringify(value);
}

function getCacheKey(activeFilters = DEFAULT_FILTERS) {
  return stableStringify(activeFilters || DEFAULT_FILTERS);
}

async function loadTradeDataCache() {
  if (tradeDataCache) {
    return tradeDataCache;
  }

  const stored = await browser.storage.local.get(TRADE_CACHE_STORAGE_KEY);
  tradeDataCache = stored[TRADE_CACHE_STORAGE_KEY] || {};
  return tradeDataCache;
}

async function persistTradeDataCache() {
  if (!tradeDataCache) {
    return;
  }

  await browser.storage.local.set({
    [TRADE_CACHE_STORAGE_KEY]: tradeDataCache,
  });
}

async function getRefreshStatus() {
  const [alarm, defaultCacheEntry] = await Promise.all([
    browser.alarms.get(BACKGROUND_REFRESH_ALARM),
    getCachedTradeData(DEFAULT_FILTERS),
  ]);

  const lastUpdatedAt = defaultCacheEntry?.fetchedAt || null;
  const nextRefreshAt = alarm?.scheduledTime || (lastUpdatedAt ? lastUpdatedAt + BACKGROUND_REFRESH_INTERVAL_MS : null);

  return {
    ok: true,
    nextRefreshAt,
    lastUpdatedAt,
    refreshIntervalMs: BACKGROUND_REFRESH_INTERVAL_MS,
  };
}

async function getCachedTradeData(activeFilters = DEFAULT_FILTERS) {
  const cache = await loadTradeDataCache();
  return cache[getCacheKey(activeFilters)] || null;
}

async function setCachedTradeData(activeFilters, payload) {
  const cache = await loadTradeDataCache();
  const cacheKey = getCacheKey(activeFilters);
  const entry = {
    fetchedAt: Date.now(),
    payload,
  };

  cache[cacheKey] = entry;
  await persistTradeDataCache();
  return entry;
}

function toSnapshotResponse(entry, options = {}) {
  const { fromCache = false, stale = false, warning } = options;
  return {
    ...entry.payload,
    fromCache,
    stale,
    warning,
    cacheAgeMs: Math.max(0, Date.now() - entry.fetchedAt),
    lastUpdatedAt: entry.fetchedAt,
  };
}

function normalizeRequestOptions(options = {}) {
  const minFreshMs = Number(options.minFreshMs);
  return {
    forceRefresh: Boolean(options.forceRefresh),
    cacheOnly: Boolean(options.cacheOnly),
    minFreshMs: Number.isFinite(minFreshMs) ? Math.max(0, minFreshMs) : 0,
  };
}

async function buildAuthHeaders() {
  if (hasAuthHeaders(capturedHeaders)) {
    return { ...capturedHeaders };
  }

  const token = cachedToken || (await getBearerFromCookies());
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function notifyAuthStateWaiters() {
  for (const waiter of authStateWaiters) {
    waiter();
  }
}

async function waitForAuthHeaders(timeoutMs = AUTH_WAIT_TIMEOUT_MS) {
  const existing = await buildAuthHeaders();
  if (hasAuthHeaders(existing)) {
    return existing;
  }

  return await new Promise((resolve) => {
    let settled = false;

    const finish = (headers = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      authStateWaiters.delete(checkAuthHeaders);
      resolve(headers);
    };

    async function checkAuthHeaders() {
      try {
        const headers = await buildAuthHeaders();
        if (hasAuthHeaders(headers)) {
          finish(headers);
        }
      } catch (error) {
        console.warn('[HashHedge] Failed to re-check auth headers:', error);
      }
    }

    authStateWaiters.add(checkAuthHeaders);
    const timeoutId = setTimeout(() => finish({}), timeoutMs);
    void checkAuthHeaders();
  });
}

async function waitForTabReload(tabId, timeoutMs = TAB_RELOAD_TIMEOUT_MS) {
  return await new Promise((resolve) => {
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      browser.tabs.onUpdated.removeListener(onUpdated);
      resolve(result);
    };

    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === 'complete') {
        finish(true);
      }
    };

    browser.tabs.onUpdated.addListener(onUpdated);
    const timeoutId = setTimeout(() => finish(false), timeoutMs);
  });
}

async function refreshAuthContext(waitForHeaders = false) {
  const reloadedTradeTab = await reloadTradePageTab();

  if (!reloadedTradeTab) {
    return await buildAuthHeaders();
  }

  if (waitForHeaders) {
    return await waitForAuthHeaders();
  }

  await delay(1500);
  return await buildAuthHeaders();
}

async function fetchTradeResources(headers) {
  const [tradesRes, openPositionsRes, publicInstrumentsResult] = await Promise.all([
    fetch(API_URL, { credentials: 'include', headers }),
    fetch(OPEN_POSITIONS_URL, { credentials: 'include', headers }),
    getPublicInstrumentsMap().catch((error) => {
      console.warn('[HashHedge] Public instruments request failed:', error);
      return null;
    }),
  ]);

  return { tradesRes, openPositionsRes, publicInstrumentsResult };
}

function normalizeInstrumentKeys(instrument) {
  const keys = new Set();
  const name = String(instrument?.name || '').trim().toUpperCase();
  const base = String(instrument?.base || '').trim().toUpperCase();
  const symbol = String(instrument?.symbol || '').trim().toUpperCase();

  if (name) keys.add(name);
  if (base) keys.add(base);
  if (symbol) keys.add(symbol);
  return [...keys];
}

function getPositionInstrumentKeys(position) {
  const keys = new Set();
  const instrument = String(position?.instrument || '').trim().toUpperCase();
  const quote = String(position?.quote || 'usdt').trim().toUpperCase();

  if (instrument) {
    keys.add(instrument);
    keys.add(`${instrument}${quote}`);
  }

  return [...keys];
}

async function getPublicInstrumentsMap() {
  const now = Date.now();
  if (publicInstrumentsCache.byKey && now - publicInstrumentsCache.fetchedAt < PUBLIC_INSTRUMENTS_TTL_MS) {
    return publicInstrumentsCache.byKey;
  }

  if (publicInstrumentsCache.pending) {
    return publicInstrumentsCache.pending;
  }

  publicInstrumentsCache.pending = (async () => {
    const response = await fetch(PUBLIC_INSTRUMENTS_URL);
    if (!response.ok) {
      throw new Error(`Public instruments request failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const instruments = extractPublicInstruments(data);
    const byKey = new Map();

    for (const instrument of instruments) {
      for (const key of normalizeInstrumentKeys(instrument)) {
        byKey.set(key, instrument);
      }
    }

    publicInstrumentsCache.byKey = byKey;
    publicInstrumentsCache.fetchedAt = Date.now();
    return byKey;
  })();

  try {
    return await publicInstrumentsCache.pending;
  } finally {
    publicInstrumentsCache.pending = null;
  }
}

function enrichOpenPositionsWithPrices(positions, instrumentsByKey) {
  if (!Array.isArray(positions) || !positions.length || !instrumentsByKey) {
    return Array.isArray(positions) ? positions : [];
  }

  return positions.map((position) => {
    const match = getPositionInstrumentKeys(position)
      .map((key) => instrumentsByKey.get(key))
      .find(Boolean);

    if (!match) {
      return position;
    }

    return {
      ...position,
      currentPrice: match.markPrice ?? match.lastPrice ?? null,
      markPrice: match.markPrice ?? null,
      lastPrice: match.lastPrice ?? null,
    };
  });
}

// ── Passive webRequest header capture ─────────────────────────────────────
// Intercepts requests the PAGE makes to the API and captures auth headers.
browser.webRequest.onSendHeaders.addListener(
  (details) => {
    // Skip requests originating from our own extension
    if (details.originUrl && details.originUrl.startsWith('moz-extension://')) return;
    if (!details.requestHeaders || !details.requestHeaders.length) return;

    const captured = {};
    for (const h of details.requestHeaders) {
      const lower = h.name.toLowerCase();
      // Capture Authorization and any custom x-* headers (common in trading APIs)
      if (
        lower === 'authorization' ||
        lower === 'token' ||
        lower.startsWith('x-') ||
        lower === 'api-key' ||
        lower === 'apikey'
      ) {
        captured[h.name] = h.value;
      }
    }

    if (Object.keys(captured).length) {
      capturedHeaders = captured;
      console.debug('[HashHedge] Captured auth headers from page request:', Object.keys(captured));
      notifyAuthStateWaiters();
    }
  },
  { urls: ['https://cb.hashhedge.com/*'] },
  ['requestHeaders']
);

/**
 * Listen for messages from content scripts and popup
 */
browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'STORE_TOKEN') {
    cachedToken = request.token;
    console.debug('[HashHedge] Token stored:', request.token ? 'OK' : 'EMPTY');
    notifyAuthStateWaiters();
    sendResponse({ success: true });
  }
  
  if (request.type === 'GET_AUTH') {
    sendResponse({ token: cachedToken, headers: capturedHeaders });
  }
  
  if (request.type === 'FETCH_TRADES') {
    handleFetchTrades(request.filters || {}, request.locale, normalizeRequestOptions(request)).then(sendResponse);
    return true; // Keep channel open for async response
  }

  if (request.type === 'GET_REFRESH_STATUS') {
    getRefreshStatus().then(sendResponse);
    return true;
  }
});

/**
 * Extract trades from various API response formats
 */
function extractTrades(data) {
  if (Array.isArray(data)) return data;
  if (data?.data && Array.isArray(data.data)) return data.data;
  if (data?.data?.list && Array.isArray(data.data.list)) return data.data.list;
  if (data?.data?.records && Array.isArray(data.data.records)) return data.data.records;
  if (data?.data?.rows && Array.isArray(data.data.rows)) return data.data.rows;
  if (data?.list && Array.isArray(data.list)) return data.list;
  if (data?.records && Array.isArray(data.records)) return data.records;
  if (data?.rows && Array.isArray(data.rows)) return data.rows;
  throw new Error('Unrecognised API response shape. Raw: ' + JSON.stringify(data).slice(0, 200));
}

function extractOpenPositions(data) {
  const positions =
    data?.data?.userPositions ||
    data?.data?.data?.userPositions ||
    data?.userPositions ||
    data?.result?.userPositions;
  return Array.isArray(positions) ? positions : [];
}

function extractPublicInstruments(data) {
  const instruments =
    data?.data ||
    data?.result?.data ||
    data?.result ||
    data;
  return Array.isArray(instruments) ? instruments : [];
}

// ── Metric helpers (inlined — no ES modules in Firefox background) ─────────

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
    if (s === 'loss' || s === 'lose' || s === 'fail')     return false;
  }
  const pnl = getPnl(trade);
  if (pnl !== null) return pnl > 0;
  return false;
}

function normalizeDirection(trade) {
  const raw = trade.direction ?? trade.side ?? trade.type ?? trade.tradeType ?? trade.orderSide;
  if (raw === null || raw === undefined) return 'UNKNOWN';
  const s = String(raw).toUpperCase();
  if (s === 'LONG'  || s === 'BUY'  || s === '1') return 'LONG';
  if (s === 'SHORT' || s === 'SELL' || s === '2') return 'SHORT';
  return s;
}

function getMargin(trade) {
  const val =
    trade.margin ?? trade.usedMargin ?? trade.marginUsed ?? trade.initialMargin ??
    trade.cost ?? trade.positionMargin ?? trade.notional;
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

function toMs(raw) {
  if (raw == null) return null;
  const ts = Number(raw);
  if (Number.isFinite(ts) && ts > 1e12) return ts;
  if (Number.isFinite(ts) && ts > 1e6)  return ts * 1000;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d.getTime();
}

function getDuration(trade) {
  const open  = toMs(trade.createdDate ?? trade.openTime  ?? trade.createTime ?? trade.ctime  ?? trade.tradeTime);
  const close = toMs(trade.updatedDate ?? trade.closeTime ?? trade.updateTime ?? trade.updateAt ?? trade.time);
  if (open === null || close === null || close <= open) return null;
  return close - open;
}

function fmtDuration(ms) {
  const totalSec = Math.round(ms / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${totalSec}s`;
}

function medianValue(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function maxDrawdownFromPnls(pnls) {
  let equity = 0, peak = 0, maxDd = 0;
  for (const pnl of pnls) {
    equity += pnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
  }
  return maxDd;
}

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
  return isNaN(d.getTime()) ? null : d.getUTCDay();
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

// ── Metric definitions (same as Chrome) ───────────────────────────────────

const _metrics = [
  {
    id: 'winRate', label: 'Win Rate',
    compute(trades) {
      if (!trades.length) return { value: 0, display: '—', status: 'neutral', sub: 'No trades' };
      const wins = trades.filter(isWin).length;
      const losses = trades.length - wins;
      const rate = (wins / trades.length) * 100;
      return {
        value: rate,
        display: `${rate.toFixed(2)}%`,
        status: rate >= 50 ? 'positive' : 'negative',
        sub: `${wins} W / ${losses} L`,
      };
    },
  },
  {
    id: 'hourlyWinRate', label: 'Hourly Win Rate',
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

      const best = active.reduce(
        (acc, cur) => ((cur.rate ?? -Infinity) > (acc.rate ?? -Infinity) ? cur : acc),
        active[0]
      );
      const bestRate = best.rate ?? 50;

      return {
        value: bestRate,
        display: `${formatHour(best.hour)}:00 - ${bestRate.toFixed(1)}%`,
        status: bestRate > 50 ? 'positive' : bestRate < 50 ? 'negative' : 'neutral',
        sub: null,
        bars,
      };
    },
  },
  {
    id: 'directionCount', label: 'Direction Split',
    compute(trades) {
      if (!trades.length) return { value: {}, display: '—', status: 'neutral', sub: 'No trades' };
      const counts = {};
      for (const t of trades) {
        const dir = normalizeDirection(t);
        counts[dir] = (counts[dir] || 0) + 1;
      }
      const long = counts['LONG'] || 0;
      const short = counts['SHORT'] || 0;
      return {
        value: counts,
        display: `${long} ↑ / ${short} ↓`,
        status: 'neutral',
        sub: `Total: ${trades.length}`,
      };
    },
  },
  {
    id: 'averagePnl', label: 'Avg PnL',
    compute(trades) {
      const values = trades.map(getPnl).filter(v => v !== null);
      if (!values.length) return { value: null, display: 'N/A', status: 'neutral', sub: 'No PnL fields' };
      const avg = values.reduce((a, b) => a + b, 0) / values.length;
      const sign = avg >= 0 ? '+' : '';
      return {
        value: avg,
        display: `${sign}${avg.toFixed(2)} USDT`,
        status: avg > 0 ? 'positive' : avg < 0 ? 'negative' : 'neutral',
        sub: `${values.length} trades`,
      };
    },
  },
  {
    id: 'medianPnl', label: 'Median PnL',
    compute(trades) {
      const values = trades.map(getPnl).filter(v => v !== null);
      const med = medianValue(values);
      if (med === null) return { value: null, display: 'N/A', status: 'neutral', sub: 'No PnL fields' };
      const sign = med >= 0 ? '+' : '';
      return {
        value: med,
        display: `${sign}${med.toFixed(2)} USDT`,
        status: med > 0 ? 'positive' : med < 0 ? 'negative' : 'neutral',
        sub: `${values.length} trades`,
      };
    },
  },
  {
    id: 'roi', label: 'ROI',
    compute(trades) {
      const pnls = trades.map(getPnl).filter(v => v !== null);
      const margins = trades.map(getMargin).filter(v => v !== null && v > 0);
      if (!pnls.length || !margins.length) return { value: null, display: 'N/A', status: 'neutral', sub: 'No margin fields' };
      const totalPnl = pnls.reduce((a, b) => a + b, 0);
      const totalMargin = margins.reduce((a, b) => a + b, 0);
      if (!totalMargin) return { value: null, display: 'N/A', status: 'neutral', sub: 'Zero margin' };
      const roi = (totalPnl / totalMargin) * 100;
      const sign = roi >= 0 ? '+' : '';
      return {
        value: roi,
        display: `${sign}${roi.toFixed(2)}%`,
        status: roi > 0 ? 'positive' : roi < 0 ? 'negative' : 'neutral',
        sub: `PnL ${totalPnl.toFixed(2)} / Margin ${totalMargin.toFixed(2)}`,
      };
    },
  },
  {
    id: 'recoveryFactor', label: 'Recovery',
    compute(trades) {
      const normalized = trades
        .map(t => ({ pnl: getPnl(t), ts: getTime(t) }))
        .filter(x => x.pnl !== null);
      if (!normalized.length) return { value: null, display: 'N/A', status: 'neutral', sub: 'No PnL fields' };
      const hasTs = normalized.some(x => x.ts !== null);
      if (hasTs) normalized.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
      const pnls = normalized.map(x => x.pnl);
      const net = pnls.reduce((a, b) => a + b, 0);
      const maxDd = maxDrawdownFromPnls(pnls);
      if (maxDd === 0) {
        if (net > 0) return { value: Infinity, display: 'inf', status: 'positive', sub: 'No drawdown' };
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
  },
  {
    id: 'bestDays', label: 'Best Days',
    compute(trades) {
      const MON_FIRST = [1, 2, 3, 4, 5, 6, 0];
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
      if (!active.length) return { value: null, display: 'N/A', status: 'neutral', sub: 'No data' };
      const sorted = [...active].sort((a, b) => b.wr - a.wr);
      const best = sorted[0];
      const worst = sorted[sorted.length - 1];
      const bars = MON_FIRST.map(i => ({
        dow: i,
        pct: stats[i].total > 0 ? stats[i].wins / stats[i].total * 100 : null,
      }));
      const status = worst.wr < 35 ? 'negative' : best.wr > 65 ? 'positive' : 'neutral';
      return { value: best.wr, display: `${Math.round(best.wr)}%`, status, sub: null, bars };
    },
  },
  {
    id: 'avgHoldTime', label: 'Avg Hold Time',
    compute(trades) {
      const durations = trades.map(getDuration).filter(v => v !== null);
      if (!durations.length) return { value: null, display: 'N/A', status: 'neutral', sub: 'No time fields' };
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
  },
];

function computeAll(trades) {
  return _metrics
    .slice()
    .sort((a, b) => Number(a.id === 'hourlyWinRate') - Number(b.id === 'hourlyWinRate'))
    .map(metric => {
    try {
      const result = metric.compute(trades);
      return {
        id: metric.id,
        label: metric.label,
        value: result.value,
        display: result.display,
        status: result.status ?? 'neutral',
        sub: result.sub ?? null,
        bars: result.bars ?? null,
      };
    } catch (e) {
      console.error(`[Metrics] Error computing "${metric.id}":`, e);
      return {
        id: metric.id, label: metric.label,
        value: null, display: 'N/A', status: 'neutral', sub: null, bars: null,
      };
    }
  });
}

// ── Cookie fallback ───────────────────────────────────────────────────────

async function getBearerFromCookies() {
  const TOKEN_COOKIE_NAMES = [
    'token', 'access_token', 'auth_token', 'jwt', 'authToken',
    'accessToken', 'apiToken', 'api_token', 'userToken', 'loginToken',
  ];
  try {
    const cookies = await browser.cookies.getAll({ domain: 'hashhedge.com' });
    for (const name of TOKEN_COOKIE_NAMES) {
      const c = cookies.find(x => x.name.toLowerCase() === name.toLowerCase());
      if (c && c.value && c.value.length > 10) return c.value;
    }
  } catch (_) {}
  return null;
}

// ── Localised error messages ──────────────────────────────────────────────

const MESSAGES = {
  en: {
    noAuthHeaders:
      'No auth headers captured yet.\nMake sure you are logged in on hashhedge.com and open the trade history page once, then click Refresh.',
    apiAuthHint: (status, text) =>
      `API ${status}: ${text}. Open trade history on hashhedge.com to refresh auth and try again.`,
    unknownError: 'Unknown error',
  },
  ru: {
    noAuthHeaders:
      'Заголовки авторизации пока не перехвачены.\nУбедитесь, что вы вошли на hashhedge.com и один раз открыли страницу истории сделок, затем нажмите Обновить.',
    apiAuthHint: (status, text) =>
      `Ошибка API ${status}: ${text}. Откройте историю сделок на hashhedge.com, чтобы обновить авторизацию, и попробуйте снова.`,
    unknownError: 'Неизвестная ошибка',
  },
};

function getLocale(input) {
  return String(input || '').toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

function msg(locale, key, ...args) {
  const l = getLocale(locale);
  const dict = MESSAGES[l] || MESSAGES.en;
  const m = dict[key] ?? MESSAGES.en[key];
  return typeof m === 'function' ? m(...args) : m;
}

/** Reloads the trade page tab if it exists */
async function reloadTradePageTab() {
  try {
    const tabs = await browser.tabs.query({
      url: ['*://hashhedge.com/client/trade*', '*://*.hashhedge.com/client/trade*']
    });
    
    if (tabs.length > 0) {
      await browser.tabs.reload(tabs[0].id);
      const reloaded = await waitForTabReload(tabs[0].id);
      if (!reloaded) {
        console.warn('[HashHedge] Timed out waiting for trade tab reload');
      }
      console.log('[HashHedge] Reloaded trade page tab');
      return true;
    }
  } catch (e) {
    console.error('[HashHedge] Failed to reload trade tab:', e);
  }
  return false;
}

// ── Core fetch handler ────────────────────────────────────────────────────

async function fetchTradesFromApi(activeFilters, locale) {
  try {
    let headers = await buildAuthHeaders();

    if (!hasAuthHeaders(headers)) {
      headers = await refreshAuthContext(true);
    }

    if (!hasAuthHeaders(headers)) {
      return { ok: false, error: msg(locale, 'noAuthHeaders') };
    }

    console.debug('[HashHedge] Fetching with headers:', Object.keys(headers));

    let { tradesRes, openPositionsRes, publicInstrumentsResult } = await fetchTradeResources(headers);

    if (tradesRes.status === 401 || tradesRes.status === 403) {
      headers = await refreshAuthContext(false);
      if (hasAuthHeaders(headers)) {
        ({ tradesRes, openPositionsRes, publicInstrumentsResult } = await fetchTradeResources(headers));
      }
    }

    if (tradesRes.ok) {
      const data = await tradesRes.json();
      const rawTrades = extractTrades(data);
      const metrics = computeAll(rawTrades);

      let userPositions = [];
      if (openPositionsRes.ok) {
        try {
          userPositions = extractOpenPositions(await openPositionsRes.json());
          userPositions = enrichOpenPositionsWithPrices(userPositions, publicInstrumentsResult);
        } catch (openPositionsError) {
          console.warn('[HashHedge] Failed to parse open positions:', openPositionsError);
        }
      } else {
        console.warn('[HashHedge] Open positions request failed:', openPositionsRes.status, openPositionsRes.statusText);
      }

      return {
        ok: true,
        metrics,
        userPositions,
        openPositions: userPositions,
        tradeCount: rawTrades.length,
        filteredCount: rawTrades.length,
      };
    }

    return { ok: false, error: msg(locale, 'apiAuthHint', tradesRes.status, tradesRes.statusText) };
  } catch (e) {
    console.error('[HashHedge] fetchTradesFromApi error:', e);
    return { ok: false, error: e?.message || msg(locale, 'unknownError') };
  }
}

async function refreshTradeData(activeFilters, locale) {
  const result = await fetchTradesFromApi(activeFilters, locale);
  if (result.ok) {
    const entry = await setCachedTradeData(activeFilters, result);
    return toSnapshotResponse(entry);
  }

  const cachedEntry = await getCachedTradeData(activeFilters);
  if (cachedEntry) {
    console.warn('[HashHedge] Returning stale cached data after refresh failure:', result.error);
    return toSnapshotResponse(cachedEntry, {
      fromCache: true,
      stale: true,
      warning: result.error,
    });
  }

  return result;
}

async function handleFetchTrades(activeFilters, locale, options = {}) {
  const { forceRefresh, cacheOnly, minFreshMs } = normalizeRequestOptions(options);
  const cacheKey = getCacheKey(activeFilters);
  const cachedEntry = await getCachedTradeData(activeFilters);

  if (!forceRefresh && cachedEntry && Date.now() - cachedEntry.fetchedAt <= minFreshMs) {
    return toSnapshotResponse(cachedEntry, { fromCache: true });
  }

  if (cacheOnly) {
    return cachedEntry ? toSnapshotResponse(cachedEntry, { fromCache: true }) : {
      ok: false,
      error: msg(locale, 'unknownError'),
    };
  }

  if (tradeDataRequests.has(cacheKey)) {
    return await tradeDataRequests.get(cacheKey);
  }

  const pendingRequest = refreshTradeData(activeFilters, locale)
    .finally(() => {
      tradeDataRequests.delete(cacheKey);
    });

  tradeDataRequests.set(cacheKey, pendingRequest);
  return await pendingRequest;
}

async function scheduleBackgroundRefresh() {
  const alarm = await browser.alarms.get(BACKGROUND_REFRESH_ALARM);
  if (alarm) {
    return;
  }

  browser.alarms.create(BACKGROUND_REFRESH_ALARM, {
    periodInMinutes: BACKGROUND_REFRESH_INTERVAL_MINUTES,
  });
}

async function refreshDefaultTradeData(reason) {
  const response = await handleFetchTrades(DEFAULT_FILTERS, 'en', {
    minFreshMs: BACKGROUND_REFRESH_INTERVAL_MS,
  });

  if (!response?.ok) {
    console.warn(`[HashHedge] Background refresh failed (${reason}):`, response?.error);
  }
}

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BACKGROUND_REFRESH_ALARM) {
    void refreshDefaultTradeData('alarm');
  }
});

browser.runtime.onInstalled.addListener(() => {
  void scheduleBackgroundRefresh();
  void refreshDefaultTradeData('install');
});

if (browser.runtime.onStartup) {
  browser.runtime.onStartup.addListener(() => {
    void scheduleBackgroundRefresh();
    void refreshDefaultTradeData('startup');
  });
}

void scheduleBackgroundRefresh();
void refreshDefaultTradeData('load');

console.debug('[HashHedge] Firefox background script loaded');
