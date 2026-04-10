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

import { API_URL, extractTrades } from '../src/api/client.js';
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
      handleFetchTrades(msg.filters || {}, msg.locale).then(sendResponse);
      return true;

    default:
      break;
  }
});

// ── Core fetch handler ─────────────────────────────────────────────────────

async function handleFetchTrades(activeFilters, locale) {
  // ── Build request headers ─────────────────────────────────────────────────
  // Priority: captured webRequest headers > Bearer token from localStorage/cookies
  try {
    const session = await chrome.storage.session.get(['capturedHeaders', 'authToken']);
    const headers = { ...(session.capturedHeaders || {}) };

    // If no captured headers yet, try Bearer token as fallback
    if (!Object.keys(headers).length) {
      const token = session.authToken || (await getBearerFromCookies());
      if (token) headers['Authorization'] = `Bearer ${token}`;
    }

    if (!Object.keys(headers).length) {
      return {
        ok: false,
        error: t(locale, 'noAuthHeaders'),
      };
    }

    const res = await fetch(API_URL, { credentials: 'include', headers });
    if (res.ok) {
      const data      = await res.json();
      const rawTrades = extractTrades(data);
      const trades    = applyAll(rawTrades, activeFilters);
      const metrics   = computeAll(trades, activeFilters);
      return { ok: true, metrics, tradeCount: rawTrades.length, filteredCount: trades.length };
    }

    return { ok: false, error: t(locale, 'apiAuthHint', res.status, res.statusText) };
  } catch (e) {
    console.error('[HashHedge] handleFetchTrades error:', e);
    return { ok: false, error: e?.message || t(locale, 'unknownError') };
  }
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
