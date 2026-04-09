/**
 * Firefox Content script — observes and captures trade details from HashHedge pages
 * Sends captured data to background script for storage and processing
 */
(function () {
  'use strict';

  /**
   * Parse trade data from DOM elements if available
   * This is a placeholder; adapt to actual HashHedge page structure
   */
  function captureTradeData() {
    const trades = [];
    
    // Example: look for trade rows in a table or list
    const tradeElements = document.querySelectorAll('[data-trade-id], .trade-row, .trade-item');
    
    tradeElements.forEach((element) => {
      try {
        const trade = {
          id: element.getAttribute('data-trade-id') || element.textContent.slice(0, 20),
          pnl: element.querySelector('.pnl, [data-pnl]')?.textContent || '0',
          direction: element.querySelector('.direction, [data-direction]')?.textContent?.toUpperCase() || 'UNKNOWN',
          date: element.querySelector('.date, [data-date]')?.textContent || new Date().toISOString(),
        };
        trades.push(trade);
      } catch (err) {
        console.debug('[HashHedge] Error parsing trade:', err);
      }
    });

    return trades;
  }

  // Listen for trade updates and periodically sync
  // This can be enhanced based on HashHedge's actual page structure
  if (window.location.hostname.includes('hashhedge.com')) {
    console.debug('[HashHedge] Trade fetcher script active');

    // Optionally observe DOM changes for new trades
    const observer = new MutationObserver(() => {
      const trades = captureTradeData();
      if (trades.length > 0) {
        browser.runtime.sendMessage({
          type: 'TRADES_UPDATED',
          trades: trades,
        }).catch(err => {
          console.debug('[HashHedge] Error sending trades:', err);
        });
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }
})();
