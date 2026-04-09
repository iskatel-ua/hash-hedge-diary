/**
 * Firefox Content script — runs on hashhedge.com pages.
 * Searches localStorage and sessionStorage for an auth token
 * and forwards it to the background script.
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
    if (typeof raw !== 'string') return null;
    
    // Check if it looks like it might be JSON
    const trimmed = raw.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[') && !trimmed.startsWith('"')) {
      // Not JSON, treat as raw token
      return raw.length >= 10 ? raw : null;
    }
    
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'string') return parsed;
      // Unwrap common wrapper shapes
      return parsed.token ?? parsed.access_token ?? parsed.accessToken ?? null;
    } catch (_) {
      // If JSON parsing fails, treat original as raw token
      return raw.length >= 10 ? raw : null;
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
    browser.runtime.sendMessage({ type: 'STORE_TOKEN', token }, () => {
      if (browser.runtime.lastError) {
        console.debug('[HashHedge] sendMessage error:', browser.runtime.lastError.message);
      } else {
        console.debug('[HashHedge] Auth token stored in background');
      }
    });
  } else {
    console.debug('[HashHedge] No token found in localStorage/sessionStorage');
  }
})();
