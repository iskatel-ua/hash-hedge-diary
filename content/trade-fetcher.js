/**
 * Content script (ISOLATED world) — trade fetch relay.
 *
 * Auth strategy (in order):
 *  1. fetch() from ISOLATED world with credentials:'include'
 *     Content scripts can make cross-origin requests to hosts listed in
 *     host_permissions — cookies for hashhedge.com are included automatically.
 *     Works when the server doesn't check the Origin header strictly.
 *
 *  2. If the server returns 401/403 (Origin check), inject a <script> tag
 *     into the DOM (MAIN world). That script runs with the page's Origin
 *     and session cookies — indistinguishable from a native page request.
 *     Results are returned via window.postMessage with a random nonce.
 */
'use strict';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'DO_FETCH_TRADES') return;
  doFetch(msg.url).then(sendResponse);
  return true; // keep message channel open for async response
});

async function doFetch(url) {
  // ── Attempt 1: ISOLATED world fetch (cross-origin allowed via host_permissions) ──
  try {
    const res = await fetch(url, { credentials: 'include' });
    if (res.ok) {
      const data = await res.json();
      return { data };
    }
    // Only fall through on auth errors — other errors should surface directly
    if (res.status !== 401 && res.status !== 403) {
      return { error: `API ${res.status}: ${res.statusText}` };
    }
    console.debug('[HashHedge] Isolated fetch got', res.status, '— trying MAIN world injection');
  } catch (e) {
    console.debug('[HashHedge] Isolated fetch network error:', e.message, '— trying MAIN world injection');
  }

  // ── Attempt 2: MAIN world via <script> tag (page Origin + cookies) ──────────
  return fetchViaPageContext(url);
}

function fetchViaPageContext(url) {
  return new Promise((resolve) => {
    const nonce  = '__hhd_' + Math.random().toString(36).slice(2) + '_' + Date.now();
    let settled  = false;

    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window.removeEventListener('message', handler);
      resolve(result);
    };

    const timer   = setTimeout(() => done({ error: 'Request timed out after 15 s' }), 15000);
    const handler = (event) => {
      if (event.data?.__hhd_nonce === nonce) done(event.data.result);
    };
    window.addEventListener('message', handler);

    const script = document.createElement('script');
    script.textContent = `(async function () {
  var n = ${JSON.stringify(nonce)};
  var u = ${JSON.stringify(url)};
  try {
    var r = await fetch(u, { credentials: 'include' });
    if (!r.ok) {
      window.postMessage({ __hhd_nonce: n, result: { error: 'API ' + r.status + ': ' + r.statusText } }, '*');
      return;
    }
    var d = await r.json();
    window.postMessage({ __hhd_nonce: n, result: { data: d } }, '*');
  } catch (e) {
    window.postMessage({ __hhd_nonce: n, result: { error: e.message } }, '*');
  }
})();`;
    (document.head || document.documentElement).appendChild(script);
    script.remove();
  });
}
