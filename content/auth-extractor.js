/**
 * Content script — runs on hashhedge.com pages.
 * Searches localStorage and sessionStorage for an auth token
 * and forwards it to the background service worker.
 */
(function () {
  'use strict';

  // Common key names used by trading platforms for auth tokens
  const TOKEN_KEYS = [
    'token', 'access_token', 'auth_token', 'Authorization',
    'jwt', 'bearer_token', 'authToken', 'userToken',
    'api_token', 'accessToken', 'apiToken', 'user_token',
    'loginToken', 'login_token', 'Auth', 'AUTH_TOKEN',
  ];

  function tryParseToken(raw) {
    if (!raw || raw.length < 10) return null;
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'string') return parsed;
      // Unwrap common wrapper shapes
      return parsed.token ?? parsed.access_token ?? parsed.accessToken ?? null;
    } catch (_) {
      return raw; // raw string — treat as token directly
    }
  }

  function extractToken() {
    for (const store of [localStorage, sessionStorage]) {
      for (const key of TOKEN_KEYS) {
        let raw;
        try { raw = store.getItem(key); } catch (_) { continue; }
        const token = tryParseToken(raw);
        if (token) return token;
      }
    }
    return null;
  }

  const token = extractToken();
  if (token) {
    chrome.runtime.sendMessage({ type: 'STORE_TOKEN', token }, () => {
      if (chrome.runtime.lastError) {
        console.debug('[HashHedge] sendMessage error:', chrome.runtime.lastError.message);
      } else {
        console.debug('[HashHedge] Auth token stored in background');
      }
    });
  } else {
    console.debug('[HashHedge] No auth token found — will fall back to cookies');
  }
})();
