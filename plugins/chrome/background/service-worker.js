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
const STOP_PROFIT_LOSS_ADD_URL = 'https://cb.hashhedge.com/v1/cfd/stop/profit/loss/add';
const STOP_PROFIT_LOSS_UPDATE_URL = 'https://cb.hashhedge.com/v1/cfd/stop/profit/loss/update';
const TRADE_CACHE_STORAGE_KEY = 'tradeDataCacheV1';
const SLTP_SETTINGS_STORAGE_KEY = 'hhd_sltp_settings';
const AUTO_SLTP_SEEN_AT_STORAGE_KEY = 'hhd_auto_sltp_seen_at_v1';
const BACKGROUND_REFRESH_ALARM = 'hashhedge-refresh-default';
const AUTO_SLTP_CHECK_ALARM = 'hashhedge-auto-sltp-check';
const AUTO_SLTP_CHECK_INTERVAL_MINUTES = 1;
const AUTO_SLTP_TRIGGER_DELAY_MS = 3 * 60_000;
const DEFAULT_FILTERS = {};
const DEFAULT_SLTP_SETTINGS = Object.freeze({
  slPercent: 1,
  tpPercent: 1,
  autoApplyEnabled: false,
});
const publicInstrumentsCache = {
  fetchedAt: 0,
  byKey: null,
  pending: null,
};
let tradeDataCache = null;
let sltpSettings = { ...DEFAULT_SLTP_SETTINGS };
let autoSltpCheckInProgress = null;
let autoSltpSeenAtCache = null;
const tradeDataRequests = new Map();

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasAuthHeaders(headers) {
  return !!headers && Object.keys(headers).length > 0;
}

function clampPercent(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

function normalizeSltpSettings(value) {
  return {
    slPercent: clampPercent(value?.slPercent, 1, 15, DEFAULT_SLTP_SETTINGS.slPercent),
    tpPercent: clampPercent(value?.tpPercent, 1, 50, DEFAULT_SLTP_SETTINGS.tpPercent),
    autoApplyEnabled: Boolean(value?.autoApplyEnabled),
  };
}

async function loadSltpSettings() {
  const stored = await chrome.storage.local.get(SLTP_SETTINGS_STORAGE_KEY);
  sltpSettings = normalizeSltpSettings(stored[SLTP_SETTINGS_STORAGE_KEY]);
  return sltpSettings;
}

async function persistSltpSettings(nextSettings) {
  sltpSettings = normalizeSltpSettings(nextSettings);
  await chrome.storage.local.set({
    [SLTP_SETTINGS_STORAGE_KEY]: sltpSettings,
  });
  return sltpSettings;
}

async function loadAutoSltpSeenAtMap() {
  if (autoSltpSeenAtCache) {
    return autoSltpSeenAtCache;
  }

  const stored = await chrome.storage.local.get(AUTO_SLTP_SEEN_AT_STORAGE_KEY);
  autoSltpSeenAtCache = stored[AUTO_SLTP_SEEN_AT_STORAGE_KEY] || {};
  return autoSltpSeenAtCache;
}

async function persistAutoSltpSeenAtMap() {
  if (!autoSltpSeenAtCache) {
    return;
  }

  await chrome.storage.local.set({
    [AUTO_SLTP_SEEN_AT_STORAGE_KEY]: autoSltpSeenAtCache,
  });
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

async function getAlarmInfo(alarmName) {
  return await new Promise((resolve) => {
    chrome.alarms.get(alarmName, (alarm) => {
      resolve(alarm || null);
    });
  });
}

async function getRefreshAlarmInfo() {
  return await getAlarmInfo(BACKGROUND_REFRESH_ALARM);
}

async function getRefreshStatus() {
  const [alarm, defaultCacheEntry] = await Promise.all([
    getRefreshAlarmInfo(),
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
      pricePrecision: Number(match.pricePrecision),
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

    case 'GET_REFRESH_STATUS':
      getRefreshStatus().then(sendResponse);
      return true;

    case 'UPSERT_POSITION_SLTP':
      upsertPositionStopProfitLoss(msg.payload, Boolean(msg.hasExistingStops), msg.locale).then(sendResponse);
      return true;

    case 'SETTINGS_UPDATED':
      persistSltpSettings(msg.settings)
        .then(async (settings) => {
          await syncAutoSltpAlarm();
          if (settings.autoApplyEnabled) {
            void runAutoSltpCheck('settings-updated');
          }
          sendResponse({ ok: true, settings });
        })
        .catch((error) => {
          sendResponse({ ok: false, error: error?.message || t(msg.locale, 'unknownError') });
        });
      return true;

    default:
      break;
  }
});

function createJsonHeaders(headers) {
  return {
    ...headers,
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
  };
}

async function parseResponseBody(response) {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (_) {
    return text;
  }
}

function collectErrorDetails(value, sink = new Set(), depth = 0) {
  if (!value || depth > 3) {
    return sink;
  }

  if (typeof value === 'string') {
    const text = value.trim();
    if (text) {
      sink.add(text);
    }
    return sink;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectErrorDetails(item, sink, depth + 1);
    }
    return sink;
  }

  if (typeof value === 'object') {
    const field = value.field || value.fields || value.parameter || value.param || value.name || value.key;
    const message = value.message || value.msg || value.error || value.reason || value.description;

    if (field && message) {
      sink.add(`${field}: ${message}`);
    } else if (field) {
      sink.add(String(field));
    } else if (message) {
      sink.add(String(message));
    }

    for (const key of ['details', 'errors', 'errorFields', 'fieldErrors', 'violations', 'data']) {
      if (key in value) {
        collectErrorDetails(value[key], sink, depth + 1);
      }
    }
  }

  return sink;
}

function getResponseErrorMessage(body, fallback) {
  if (!body) {
    return fallback;
  }

  if (typeof body === 'string') {
    return body;
  }

  const baseMessage = body.message || body.msg || body.error || body.data?.message || fallback;
  const code = body.code ?? body.status ?? body.errorCode;
  const details = [...collectErrorDetails(body)].filter((entry) => entry !== baseMessage);
  const parts = [baseMessage];

  if (code !== undefined && code !== null && code !== '') {
    parts.push(`code: ${code}`);
  }

  if (details.length) {
    parts.push(`details: ${details.join('; ')}`);
  }

  return parts.join(' | ');
}

function isExplicitApiFailure(body) {
  if (!body || typeof body !== 'object') {
    return false;
  }

  if (body.success === false || body.ok === false) {
    return true;
  }

  const code = Number(body.code);
  return Number.isFinite(code) && code !== 0 && code !== 200;
}

function hasStopsConfigured(position) {
  const sl = Number(position?.stopLossPrice);
  const tp = Number(position?.stopProfitPrice);
  return (Number.isFinite(sl) && sl > 0) || (Number.isFinite(tp) && tp > 0);
}

function findOpenPositionForPayload(positions, payload) {
  if (!Array.isArray(positions) || !positions.length) {
    return null;
  }

  const candidates = new Set([
    payload?.positionId,
    payload?.idStr,
    payload?.id,
    payload?.allStopId,
  ].filter((value) => value !== null && value !== undefined && String(value).trim() !== '').map((value) => String(value).trim()));

  if (!candidates.size) {
    return null;
  }

  for (const position of positions) {
    const positionKeys = [
      position?.positionId,
      position?.idStr,
      position?.id,
      position?.allStopId,
    ]
      .filter((value) => value !== null && value !== undefined && String(value).trim() !== '')
      .map((value) => String(value).trim());

    if (positionKeys.some((key) => candidates.has(key))) {
      return position;
    }
  }

  return null;
}

async function upsertPositionStopProfitLoss(payload, hasExistingStops, locale) {
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

    const fetchOpenPositions = async (requestHeaders) => {
      const response = await fetch(OPEN_POSITIONS_URL, {
        credentials: 'include',
        headers: requestHeaders,
      });

      let positions = [];
      if (response.ok) {
        positions = extractOpenPositions(await response.json());
      }

      return { response, positions };
    };

    let openPositionsResult = await fetchOpenPositions(headers);

    if (openPositionsResult.response.status === 401 || openPositionsResult.response.status === 403) {
      headers = await refreshAuthContext(false);
      if (hasAuthHeaders(headers)) {
        openPositionsResult = await fetchOpenPositions(headers);
      }
    }

    if (!openPositionsResult.response.ok) {
      return {
        ok: false,
        error: t(locale, 'apiAuthHint', openPositionsResult.response.status, openPositionsResult.response.statusText),
      };
    }

    const matchedPosition = findOpenPositionForPayload(openPositionsResult.positions, payload);
    if (!matchedPosition) {
      return {
        ok: false,
        error: 'Position was not found in fresh open positions list',
      };
    }

    const resolvedHasExistingStops = hasStopsConfigured(matchedPosition);

    const endpoint = resolvedHasExistingStops ? STOP_PROFIT_LOSS_UPDATE_URL : STOP_PROFIT_LOSS_ADD_URL;
    const resolvedPositionId = String(
      matchedPosition?.positionId ?? matchedPosition?.idStr ?? payload?.positionId ?? payload?.idStr ?? ''
    ).trim();
    const resolvedStopId = String(
      matchedPosition?.id ?? matchedPosition?.allStopId ?? payload?.id ?? payload?.allStopId ?? ''
    ).trim();

    if (resolvedHasExistingStops && !resolvedStopId) {
      return {
        ok: false,
        error: 'Update requires id (allStopId)',
      };
    }

    if (!resolvedHasExistingStops && !resolvedPositionId) {
      return {
        ok: false,
        error: 'Add requires positionId (idStr)',
      };
    }

    const requestPayload = {
      instrument: payload?.instrument,
      stopType: payload?.stopType,
      stopProfitWorkingType: payload?.stopProfitWorkingType,
      stopLossWorkingType: payload?.stopLossWorkingType,
      stopProfitWorkingPrice: payload?.stopProfitWorkingPrice,
      stopProfitTriggerPrice: payload?.stopProfitTriggerPrice,
      stopProfitTriggerType: payload?.stopProfitTriggerType,
      stopLossWorkingPrice: payload?.stopLossWorkingPrice,
      stopLossTriggerPrice: payload?.stopLossTriggerPrice,
      stopLossTriggerType: payload?.stopLossTriggerType,
      ...(resolvedHasExistingStops ? { id: resolvedStopId } : { positionId: resolvedPositionId }),
    };

    const executeRequest = async (requestHeaders) => {
      const response = await fetch(endpoint, {
        method: 'POST',
        credentials: 'include',
        headers: createJsonHeaders(requestHeaders),
        body: JSON.stringify(requestPayload),
      });

      const body = await parseResponseBody(response);
      return { response, body };
    };

    let result = await executeRequest(headers);

    if (result.response.status === 401 || result.response.status === 403) {
      headers = await refreshAuthContext(false);
      if (hasAuthHeaders(headers)) {
        result = await executeRequest(headers);
      }
    }

    if (!result.response.ok) {
      console.warn('[HashHedge] SL/TP request failed:', {
        endpoint,
        status: result.response.status,
        payload: requestPayload,
        body: result.body,
      });
      return {
        ok: false,
        error: getResponseErrorMessage(
          result.body,
          t(locale, 'apiAuthHint', result.response.status, result.response.statusText)
        ),
      };
    }

    if (isExplicitApiFailure(result.body)) {
      console.warn('[HashHedge] SL/TP request returned API error:', {
        endpoint,
        payload: requestPayload,
        body: result.body,
      });
      return {
        ok: false,
        error: getResponseErrorMessage(result.body, t(locale, 'unknownError')),
      };
    }

    void refreshDefaultTradeData('stop-profit-loss-upsert');

    return {
      ok: true,
      data: result.body,
      endpoint,
    };
  } catch (error) {
    return {
      ok: false,
      error: error?.message || t(locale, 'unknownError'),
    };
  }
}

function countDecimals(value) {
  if (value === null || value === undefined || value === '') return 0;
  const str = String(value).trim();
  if (!str || str.includes('e') || str.includes('E')) return 0;
  const dotIndex = str.indexOf('.');
  return dotIndex >= 0 ? str.length - dotIndex - 1 : 0;
}

function getPricePrecision(position) {
  const instrumentPrecision = Number(position?.pricePrecision);
  if (Number.isFinite(instrumentPrecision) && instrumentPrecision >= 0) {
    return Math.min(10, Math.max(0, Math.floor(instrumentPrecision)));
  }

  const precision = Math.max(
    countDecimals(position?.openPrice),
    countDecimals(position?.stopLossPrice),
    countDecimals(position?.stopProfitPrice),
    countDecimals(position?.currentPrice),
    countDecimals(position?.markPrice),
    countDecimals(position?.lastPrice),
    2
  );
  return Math.min(8, precision);
}

function formatRequestPrice(value, precision) {
  return value.toFixed(precision).replace(/\.?0+$/, '');
}

function getTickSize(precision) {
  if (!Number.isFinite(precision) || precision <= 0) {
    return 1;
  }
  return 1 / (10 ** precision);
}

function getPositionCurrentPrice(position) {
  const candidates = [
    position?.currentPrice,
    position?.markPrice,
    position?.lastPrice,
  ];

  for (const value of candidates) {
    const price = Number(value);
    if (Number.isFinite(price) && price > 0) {
      return price;
    }
  }

  return null;
}

function normalizeStopsForRange(direction, stopLossPrice, stopProfitPrice, referencePrice, precision) {
  const tick = getTickSize(precision);
  const roundedReference = Number(referencePrice.toFixed(precision));
  let sl = Number(stopLossPrice.toFixed(precision));
  let tp = Number(stopProfitPrice.toFixed(precision));

  if (direction === 'short') {
    if (!(sl > roundedReference)) {
      sl = Number((roundedReference + tick).toFixed(precision));
    }
    if (!(tp < roundedReference)) {
      tp = Number((Math.max(tick, roundedReference - tick)).toFixed(precision));
    }
  } else {
    if (!(sl < roundedReference)) {
      sl = Number((Math.max(tick, roundedReference - tick)).toFixed(precision));
    }
    if (!(tp > roundedReference)) {
      tp = Number((roundedReference + tick).toFixed(precision));
    }
  }

  return { stopLossPrice: sl, stopProfitPrice: tp };
}

function getPositionId(position) {
  const candidate = position?.positionId ?? position?.idStr;
  if (candidate === null || candidate === undefined || candidate === '') {
    return null;
  }
  return String(candidate);
}

function getStopId(position) {
  const candidate = position?.allStopId ?? position?.id;
  if (candidate === null || candidate === undefined || candidate === '') {
    return null;
  }
  return String(candidate);
}

function getPositionCreatedAtMs(position) {
  const candidates = [
    position?.createdDate,
    position?.createTime,
    position?.openTime,
    position?.ctime,
    position?.time,
  ];

  for (const raw of candidates) {
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0) {
      return value;
    }
  }

  return null;
}

function getAutoSltpPositionKey(position) {
  return [
    String(position?.positionId ?? position?.idStr ?? ''),
    String(position?.instrument ?? '').toUpperCase(),
    String(position?.direction ?? '').toLowerCase(),
  ].join('|');
}

function buildDefaultStopsPayload(position, settings) {
  const openPrice = Number(position?.openPrice);
  const direction = String(position?.direction || '').toLowerCase();
  const positionId = getPositionId(position);
  const stopId = getStopId(position);

  if (!Number.isFinite(openPrice) || openPrice <= 0) {
    return null;
  }

  if (!positionId) {
    return null;
  }

  const precision = getPricePrecision(position);
  const isShort = direction === 'short';
  const slMultiplier = isShort
    ? 1 + settings.slPercent / 100
    : 1 - settings.slPercent / 100;
  const tpMultiplier = isShort
    ? 1 - settings.tpPercent / 100
    : 1 + settings.tpPercent / 100;
  const referencePrice = getPositionCurrentPrice(position) || openPrice;
  const normalizedStops = normalizeStopsForRange(
    direction,
    openPrice * slMultiplier,
    openPrice * tpMultiplier,
    referencePrice,
    precision
  );
  const stopLossPrice = normalizedStops.stopLossPrice;
  const stopProfitPrice = normalizedStops.stopProfitPrice;

  return {
    payload: {
      instrument: String(position?.instrument || '').toUpperCase(),
      stopType: 1,
      stopProfitWorkingType: 'CONTRACT_PRICE',
      stopLossWorkingType: 'CONTRACT_PRICE',
      stopProfitWorkingPrice: formatRequestPrice(stopProfitPrice, precision),
      stopProfitTriggerPrice: '',
      stopProfitTriggerType: 'MARKET',
      stopLossWorkingPrice: formatRequestPrice(stopLossPrice, precision),
      stopLossTriggerPrice: '',
      stopLossTriggerType: 'MARKET',
      id: stopId,
      allStopId: stopId,
      positionId,
      idStr: positionId,
    },
    hasExistingStops: hasStopsConfigured(position),
  };
}

async function fetchOpenPositionsForAutoCheck() {
  let headers = await getAuthHeaders();

  if (!hasAuthHeaders(headers)) {
    headers = await refreshAuthContext(true);
  }

  if (!hasAuthHeaders(headers)) {
    return [];
  }

  const doFetch = async (requestHeaders) => {
    const response = await fetch(OPEN_POSITIONS_URL, {
      credentials: 'include',
      headers: requestHeaders,
    });

    if (!response.ok) {
      return { response, positions: [] };
    }

    let positions = extractOpenPositions(await response.json());
    const instrumentsByKey = await getPublicInstrumentsMap().catch(() => null);
    positions = enrichOpenPositionsWithPrices(positions, instrumentsByKey);
    return { response, positions };
  };

  let result = await doFetch(headers);
  if (result.response.status === 401 || result.response.status === 403) {
    headers = await refreshAuthContext(false);
    if (hasAuthHeaders(headers)) {
      result = await doFetch(headers);
    }
  }

  return result.positions || [];
}

async function applyAutoStopsIfNeeded(reason = 'unknown') {
  const settings = normalizeSltpSettings(sltpSettings);
  if (!settings.autoApplyEnabled) {
    return;
  }

  const now = Date.now();
  const positions = await fetchOpenPositionsForAutoCheck();
  const seenMap = await loadAutoSltpSeenAtMap();
  const activeKeys = new Set();
  let seenMapChanged = false;

  for (const position of positions) {
    const key = getAutoSltpPositionKey(position);
    if (!key || key === '||') {
      continue;
    }
    activeKeys.add(key);

    const hasSl = Number(position?.stopLossPrice) > 0;
    if (hasSl) {
      if (key in seenMap) {
        delete seenMap[key];
        seenMapChanged = true;
      }
      continue;
    }

    const createdAt = getPositionCreatedAtMs(position);
    const fallbackSeenAt = Number(seenMap[key]);
    const referenceTime = Number.isFinite(createdAt) && createdAt > 0
      ? createdAt
      : (Number.isFinite(fallbackSeenAt) && fallbackSeenAt > 0 ? fallbackSeenAt : now);

    if (!Number.isFinite(fallbackSeenAt) || fallbackSeenAt <= 0) {
      seenMap[key] = now;
      seenMapChanged = true;
    }

    if (now - referenceTime < AUTO_SLTP_TRIGGER_DELAY_MS) {
      continue;
    }

    const request = buildDefaultStopsPayload(position, settings);
    if (!request) {
      continue;
    }

    const result = await upsertPositionStopProfitLoss(request.payload, request.hasExistingStops, 'en');
    if (!result?.ok) {
      console.warn(`[HashHedge] Auto SL/TP apply failed (${reason}):`, result?.error || 'unknown');
      continue;
    }

    if (key in seenMap) {
      delete seenMap[key];
      seenMapChanged = true;
    }
  }

  for (const key of Object.keys(seenMap)) {
    if (!activeKeys.has(key)) {
      delete seenMap[key];
      seenMapChanged = true;
    }
  }

  if (seenMapChanged) {
    await persistAutoSltpSeenAtMap();
  }
}

async function runAutoSltpCheck(reason) {
  if (autoSltpCheckInProgress) {
    return await autoSltpCheckInProgress;
  }

  autoSltpCheckInProgress = applyAutoStopsIfNeeded(reason)
    .catch((error) => {
      console.warn('[HashHedge] Auto SL/TP check failed:', error);
    })
    .finally(() => {
      autoSltpCheckInProgress = null;
    });

  return await autoSltpCheckInProgress;
}

async function syncAutoSltpAlarm() {
  const alarm = await getAlarmInfo(AUTO_SLTP_CHECK_ALARM);
  if (sltpSettings.autoApplyEnabled) {
    if (!alarm) {
      chrome.alarms.create(AUTO_SLTP_CHECK_ALARM, {
        periodInMinutes: AUTO_SLTP_CHECK_INTERVAL_MINUTES,
      });
    }
    return;
  }

  if (alarm) {
    await chrome.alarms.clear(AUTO_SLTP_CHECK_ALARM);
  }
}

async function initializeSltpSettings() {
  await loadSltpSettings();
  await syncAutoSltpAlarm();
}

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

async function scheduleBackgroundRefresh() {
  const alarm = await getRefreshAlarmInfo();
  if (alarm) {
    return;
  }

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
    return;
  }

  if (alarm.name === AUTO_SLTP_CHECK_ALARM) {
    void runAutoSltpCheck('alarm');
  }
});

chrome.runtime.onInstalled.addListener(() => {
  void initializeSltpSettings();
  void scheduleBackgroundRefresh();
  void refreshDefaultTradeData('install');
});

if (chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(() => {
    void initializeSltpSettings();
    void scheduleBackgroundRefresh();
    void refreshDefaultTradeData('startup');
  });
}

void initializeSltpSettings();
void scheduleBackgroundRefresh();
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
