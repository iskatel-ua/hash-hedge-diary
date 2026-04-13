// @ts-nocheck
/**
 * Background Service Worker (MV3)
 *
 * Auth strategy — webRequest passive capture (primary):
 *   chrome.webRequest.onSendHeaders observes every request the PAGE makes to
 *   cb.hashhedge.com. We capture Authorization / x-* / token-like headers and
 *   store them in chrome.storage.session. When the popup requests data we
 *   replay those exact headers — no tab injection, works without page refresh.
 *
 * Fallback: direct fetch with credentials:'include' + Bearer token from
 *   localStorage (via auth-extractor.js content script) or from cookie jar.
 *
 * To add a metric: import it below and call registerMetric().
 * To add a filter: import it and call registerFilter().
 */

import {
  API_URL,
  OPEN_POSITIONS_URL,
  PUBLIC_INSTRUMENTS_URL,
  extractOpenPositions,
  extractPublicInstruments,
  extractTrades,
} from '../src/api/client.js';
import { registerMetric, computeAll } from '../src/metrics/registry.js';
import { applyAll }       from '../src/filters/registry.js';

// ── Register metrics (order = display order in popup) ──────────────────────
import winRate        from '../src/metrics/winRate.js';
import hourlyWinRate  from '../src/metrics/hourlyWinRate.js';
import directionCount from '../src/metrics/directionCount.js';
import averagePnl     from '../src/metrics/averagePnl.js';
import medianPnl      from '../src/metrics/medianPnl.js';
import roi            from '../src/metrics/roi.js';
import recoveryFactor from '../src/metrics/recoveryFactor.js';
import bestDays       from '../src/metrics/bestDays.js';
import avgHoldTime    from '../src/metrics/avgHoldTime.js';

registerMetric(winRate);
registerMetric(directionCount);
registerMetric(averagePnl);
registerMetric(medianPnl);
registerMetric(roi);
registerMetric(recoveryFactor);
registerMetric(bestDays);
registerMetric(avgHoldTime);
registerMetric(hourlyWinRate);

// ── Register filters (none yet — skeleton is ready in filters/registry.js) ─
// import dateRangeFilter from '../src/filters/dateRange.js';
// registerFilter(dateRangeFilter);

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

function t(locale, key, ...args) {
  const l = getLocale(locale);
  const dict = MESSAGES[l] || MESSAGES.en;
  const msg = dict[key] ?? MESSAGES.en[key];
  return typeof msg === 'function' ? msg(...args) : msg;
}

const PUBLIC_INSTRUMENTS_TTL_MS = 60_000;
const AUTH_WAIT_TIMEOUT_MS = 12_000;
const TAB_RELOAD_TIMEOUT_MS = 15_000;
const BACKGROUND_REFRESH_INTERVAL_MINUTES = 5;
const BACKGROUND_REFRESH_INTERVAL_MS = BACKGROUND_REFRESH_INTERVAL_MINUTES * 60_000;
const TRADE_CACHE_STORAGE_KEY = 'tradeDataCacheV1';
const BACKGROUND_REFRESH_ALARM = 'hashhedge-refresh-default';
const DEFAULT_FILTERS = {};
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

  const stored = await chrome.storage.local.get(TRADE_CACHE_STORAGE_KEY);
  tradeDataCache = stored[TRADE_CACHE_STORAGE_KEY] || {};
  return tradeDataCache;
}

async function persistTradeDataCache() {
  if (!tradeDataCache) {
    return;
  }

  await chrome.storage.local.set({
    [TRADE_CACHE_STORAGE_KEY]: tradeDataCache,
  });
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

async function getAuthHeaders() {
  const session = await chrome.storage.session.get(['capturedHeaders', 'authToken']);

  if (hasAuthHeaders(session.capturedHeaders)) {
    return { ...session.capturedHeaders };
  }

  const token = session.authToken || (await getBearerFromCookies());
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function waitForAuthHeaders(timeoutMs = AUTH_WAIT_TIMEOUT_MS) {
  const existing = await getAuthHeaders();
  if (hasAuthHeaders(existing)) {
    return existing;
  }

  return await new Promise((resolve) => {
    let settled = false;

    const finish = (headers = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      chrome.storage.onChanged.removeListener(onChanged);
      resolve(headers);
    };

    async function checkAuthHeaders() {
      try {
        const headers = await getAuthHeaders();
        if (hasAuthHeaders(headers)) {
          finish(headers);
        }
      } catch (error) {
        console.warn('[HashHedge] Failed to re-check auth headers:', error);
      }
    }

    const onChanged = (_changes, areaName) => {
      if (areaName !== 'session') return;
      void checkAuthHeaders();
    };

    chrome.storage.onChanged.addListener(onChanged);
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
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve(result);
    };

    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === 'complete') {
        finish(true);
      }
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
    const timeoutId = setTimeout(() => finish(false), timeoutMs);
  });
}

async function refreshAuthContext(waitForHeaders = false) {
  const reloadedTradeTab = await reloadTradePageTab();

  if (!reloadedTradeTab) {
    return await getAuthHeaders();
  }

  if (waitForHeaders) {
    return await waitForAuthHeaders();
  }

  await delay(1500);
  return await getAuthHeaders();
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
// Stored in chrome.storage.session so they survive SW restarts.
// Must be registered at top level (not inside async / onInstalled).
chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    // Skip requests originating from our own extension
    if (details.initiator && details.initiator.startsWith('chrome-extension://')) return;
    if (!details.requestHeaders?.length) return;

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
      chrome.storage.session.set({ capturedHeaders: captured });
      console.debug('[HashHedge] Captured auth headers from page request:', Object.keys(captured));
    }
  },
  { urls: ['https://cb.hashhedge.com/*'] },
  ['requestHeaders', 'extraHeaders']
);

// ── Message listener ───────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {
    case 'STORE_TOKEN':
      chrome.storage.session.set({ authToken: msg.token }, () => {
        sendResponse({ ok: true });
      });
      return true; // keep port open for async response

    case 'FETCH_TRADES':
      handleFetchTrades(msg.filters || {}, msg.locale, normalizeRequestOptions(msg)).then(sendResponse);
      return true;

    default:
      break;
  }
});

// ── Core fetch handler ─────────────────────────────────────────────────────

async function fetchTradesFromApi(activeFilters, locale) {
  // ── Build request headers ─────────────────────────────────────────────────
  // Priority: captured webRequest headers > Bearer token from localStorage/cookies
  try {
    let headers = await getAuthHeaders();

    if (!hasAuthHeaders(headers)) {
      headers = await refreshAuthContext(true);
    }

    if (!hasAuthHeaders(headers)) {
      return {
        ok: false,
        error: t(locale, 'noAuthHeaders'),
      };
    }

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
      const trades = applyAll(rawTrades, activeFilters);
      const metrics = computeAll(trades, activeFilters);

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
        filteredCount: trades.length,
      };
    }

    return { ok: false, error: t(locale, 'apiAuthHint', tradesRes.status, tradesRes.statusText) };
  } catch (e) {
    console.error('[HashHedge] fetchTradesFromApi error:', e);
    return { ok: false, error: e?.message || t(locale, 'unknownError') };
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
      error: t(locale, 'unknownError'),
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

function scheduleBackgroundRefresh() {
  chrome.alarms.create(BACKGROUND_REFRESH_ALARM, {
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

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BACKGROUND_REFRESH_ALARM) {
    void refreshDefaultTradeData('alarm');
  }
});

chrome.runtime.onInstalled.addListener(() => {
  scheduleBackgroundRefresh();
  void refreshDefaultTradeData('install');
});

if (chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(() => {
    scheduleBackgroundRefresh();
    void refreshDefaultTradeData('startup');
  });
}

scheduleBackgroundRefresh();
void refreshDefaultTradeData('load');

/** Reloads the trade page tab if it exists */
async function reloadTradePageTab() {
  try {
    const tabs = await chrome.tabs.query({
      url: ['*://hashhedge.com/client/trade*', '*://*.hashhedge.com/client/trade*']
    });
    
    if (tabs.length > 0) {
      await chrome.tabs.reload(tabs[0].id);
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

/** Checks chrome.cookies for common JWT-style token cookie names. */
async function getBearerFromCookies() {
  const TOKEN_COOKIE_NAMES = [
    'token', 'access_token', 'auth_token', 'jwt', 'authToken',
    'accessToken', 'apiToken', 'api_token', 'userToken', 'loginToken',
  ];
  try {
    const cookies = await chrome.cookies.getAll({ domain: 'hashhedge.com' });
    for (const name of TOKEN_COOKIE_NAMES) {
      const c = cookies.find(x => x.name.toLowerCase() === name.toLowerCase());
      if (c?.value && c.value.length > 10) return c.value;
    }
  } catch (_) {}
  return null;
}
