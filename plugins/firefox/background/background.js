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

// Storage for auth headers
let capturedHeaders = {};
let cachedToken = null;
const AUTH_WAIT_TIMEOUT_MS = 12_000;
const TAB_RELOAD_TIMEOUT_MS = 15_000;
const authStateWaiters = new Set();

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasAuthHeaders(headers) {
  return !!headers && Object.keys(headers).length > 0;
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
  const res = await fetch(API_URL, { credentials: 'include', headers });
  return { res };
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
    handleFetchTrades(request.filters || {}, request.locale).then(sendResponse);
    return true; // Keep channel open for async response
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

async function handleFetchTrades(activeFilters, locale) {
  try {
    let headers = await buildAuthHeaders();

    if (!hasAuthHeaders(headers)) {
      headers = await refreshAuthContext(true);
    }

    if (!hasAuthHeaders(headers)) {
      return { ok: false, error: msg(locale, 'noAuthHeaders') };
    }

    console.debug('[HashHedge] Fetching with headers:', Object.keys(headers));

    let { res } = await fetchTradeResources(headers);

    if (res.status === 401 || res.status === 403) {
      headers = await refreshAuthContext(false);
      if (hasAuthHeaders(headers)) {
        ({ res } = await fetchTradeResources(headers));
      }
    }

    if (res.ok) {
      const data = await res.json();
      const rawTrades = extractTrades(data);
      const metrics = computeAll(rawTrades);
      return { ok: true, metrics, tradeCount: rawTrades.length, filteredCount: rawTrades.length };
    }

    return { ok: false, error: msg(locale, 'apiAuthHint', res.status, res.statusText) };
  } catch (e) {
    console.error('[HashHedge] handleFetchTrades error:', e);
    return { ok: false, error: e?.message || msg(locale, 'unknownError') };
  }
}

console.debug('[HashHedge] Firefox background script loaded');
