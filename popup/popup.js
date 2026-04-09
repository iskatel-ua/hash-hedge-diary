/* global chrome */
'use strict';

const LOCALE_STORAGE_KEY = 'hhd_locale';
let locale = getInitialLocale();
let lastRenderState = null;
let lastUpdatedAt = null;

const I18N = {
  en: {
    title: 'Hash Hedge Diary',
    initialising: 'Initialising…',
    loading: 'Loading…',
    updated: 'Updated',
    error: 'Error',
    refresh: 'Refresh',
    tradesWord: 'trades',
    noResponse: 'No response from background. Extension may need reloading.',
    unknownError: 'Unknown error',
    noMessage: 'No error message',
    helpTitle: 'Metric help',
    helpButton: 'Open metric help',
    switchLangTitle: 'Switch language',
    switchedTo: 'Language',
    dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    metricLabels: {
      winRate: 'Win Rate',
      directionCount: 'Direction Split',
      averagePnl: 'Avg PnL',
      medianPnl: 'Median PnL',
      roi: 'ROI',
      recoveryFactor: 'Recovery',
      bestDays: 'Best Days',
      avgHoldTime: 'Avg Hold Time',
    },
    metricHelp: {
      winRate: 'Share of profitable trades. Formula: wins / total trades * 100%.',
      directionCount: 'Number of trades by direction: LONG vs SHORT.',
      averagePnl: 'Mean profit/loss per trade in USDT.',
      medianPnl: 'Middle PnL value after sorting trades by PnL; less sensitive to outliers.',
      roi: 'Return on used margin. Formula: total PnL / total margin * 100%.',
      recoveryFactor: 'How efficiently strategy recovers drawdowns. Formula: net profit / max drawdown.',
      bestDays: 'Win rate % grouped by day of week (UTC). Shows which weekdays are most profitable and which ones to avoid.',
      avgHoldTime: 'Average time a position is held open. Sub-line shows the shortest and longest individual trades.',
    },
  },
  ru: {
    title: 'Hash Hedge Diary',
    initialising: 'Инициализация…',
    loading: 'Загрузка…',
    updated: 'Обновлено',
    error: 'Ошибка',
    refresh: 'Обновить',
    tradesWord: 'сделок',
    noResponse: 'Нет ответа от background. Возможно, нужно перезагрузить расширение.',
    unknownError: 'Неизвестная ошибка',
    noMessage: 'Нет текста ошибки',
    helpTitle: 'Справка по метрике',
    helpButton: 'Открыть справку по метрике',
    switchLangTitle: 'Переключить язык',
    switchedTo: 'Язык',
    dow: ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'],
    metricLabels: {
      winRate: 'Винрейт',
      directionCount: 'Распределение направлений',
      averagePnl: 'Средний PnL',
      medianPnl: 'Медиана PnL',
      roi: 'ROI',
      recoveryFactor: 'Восстановление',
      bestDays: 'Лучшие дни',
      avgHoldTime: 'Ср. время в сделке',
    },
    metricHelp: {
      winRate: 'Доля прибыльных сделок. Формула: выигрыши / все сделки * 100%.',
      directionCount: 'Количество сделок по направлениям: LONG и SHORT.',
      averagePnl: 'Средний результат (прибыль/убыток) на одну сделку в USDT.',
      medianPnl: 'Среднее по позиции значение PnL после сортировки; менее чувствительно к выбросам.',
      roi: 'Доходность на использованную маржу. Формула: суммарный PnL / суммарная маржа * 100%.',
      recoveryFactor: 'Насколько стратегия восстанавливается после просадок. Формула: чистая прибыль / макс. просадка.',
      bestDays: 'Винрейт % по дням недели (UTC). Показывает, в какие дни лучше торговать, а какие стоит исключить.',
      avgHoldTime: 'Среднее время удержания позиции. Нижняя строка показывает минимальную и максимальную длительность отдельных сделок.',
    },
  },
};

function getInitialLocale() {
  try {
    const saved = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (saved === 'ru' || saved === 'en') return saved;
  } catch (_) {}
  return detectLocale();
}

function detectLocale() {
  const lang =
    (typeof chrome !== 'undefined' && chrome.i18n && chrome.i18n.getUILanguage
      ? chrome.i18n.getUILanguage()
      : navigator.language) || 'en';
  return String(lang).toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

function persistLocale() {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch (_) {}
}

function toggleLocale() {
  locale = locale === 'ru' ? 'en' : 'ru';
  persistLocale();
  applyStaticTexts();

  if (lastRenderState) {
    renderMetrics(lastRenderState.metrics, lastRenderState.filteredCount, lastRenderState.rawCount);
  }

  if (lastUpdatedAt) {
    setStatus('ok', `${t('updated')} ${lastUpdatedAt.toLocaleTimeString()}`);
  } else {
    setStatus('ok', `${t('switchedTo')} ${locale.toUpperCase()}`);
  }
}

function t(key) {
  const local = I18N[locale] || I18N.en;
  return local[key] ?? I18N.en[key] ?? key;
}

function metricLabel(id, fallback) {
  const local = I18N[locale] || I18N.en;
  return local.metricLabels?.[id] || fallback;
}

function metricHelp(id) {
  const local = I18N[locale] || I18N.en;
  return local.metricHelp?.[id] || '';
}

// ── DOM references ────────────────────────────────────────────────
const statusDot  = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const errorMsg   = document.getElementById('errorMsg');
const metricsGrid = document.getElementById('metricsGrid');
const btnRefresh  = document.getElementById('btnRefresh');
const tradeCount  = document.getElementById('tradeCount');
const headerTitle = document.querySelector('.header__title');
const btnLang = document.getElementById('btnLang');

// ── Status helpers ─────────────────────────────────────────────────
function setStatus(state, text) {
  statusDot.className  = `status-dot ${state}`;
  statusText.textContent = text;
}

function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.classList.add('visible');
}
function hideError() {
  errorMsg.classList.remove('visible');
}

// ── Metric card rendering ──────────────────────────────────────────

/**
 * Some metric cards should span both columns.
 * Add metric IDs here if they need a wide layout.
 */
const WIDE_METRICS = new Set([]);

function applyStaticTexts() {
  document.documentElement.lang = locale;
  document.title = t('title');
  if (headerTitle) headerTitle.textContent = t('title');
  btnRefresh.textContent = `↻ ${t('refresh')}`;
  btnLang.textContent = locale.toUpperCase();
  btnLang.title = t('switchLangTitle');
  btnLang.classList.toggle('btn-lang--ru', locale === 'ru');
  btnLang.classList.toggle('btn-lang--en', locale === 'en');
  setStatus('loading', t('initialising'));
}

function renderMetrics(metrics, filteredCount, rawCount) {
  lastRenderState = { metrics, filteredCount, rawCount };
  metricsGrid.innerHTML = '';

  for (const m of metrics) {
    const card = document.createElement('div');
    card.className = 'metric-card' + (WIDE_METRICS.has(m.id) ? ' metric-card--wide' : '');
    card.dataset.metricId = m.id;

    const header = document.createElement('div');
    header.className = 'metric-card__header';

    const label = document.createElement('div');
    label.className = 'metric-card__label';
    label.textContent = metricLabel(m.id, m.label);

    const helpBtn = document.createElement('button');
    helpBtn.type = 'button';
    helpBtn.className = 'metric-help-btn';
    helpBtn.textContent = '?';
    helpBtn.title = t('helpTitle');
    helpBtn.setAttribute('aria-label', t('helpButton'));

    header.appendChild(label);
    header.appendChild(helpBtn);

    const value = document.createElement('div');
    value.className = `metric-card__value ${m.status}`;
    value.textContent = m.display;

    if (!m.bars) {
      card.appendChild(header);
    }

    const content = document.createElement('div');
    content.className = 'metric-card__content';

    if (m.bars) {
      // Bar-chart render (e.g. bestDays)
      const maxPct = Math.max(...m.bars.map(b => b.pct ?? 0)) || 1;
      const dowLabels = I18N[locale].dow;
      const chart = document.createElement('div');
      chart.className = 'dow-chart';
      for (const bar of m.bars) {
        const row = document.createElement('div');
        row.className = 'dow-chart__row';
        const lbl = document.createElement('span');
        lbl.className = 'dow-chart__label';
        lbl.textContent = dowLabels[bar.dow];
        const track = document.createElement('div');
        track.className = 'dow-chart__track';
        const fill = document.createElement('div');
        fill.className = 'dow-chart__fill' + (bar.pct !== null ? '' : ' dow-chart__fill--empty');
        fill.style.width = bar.pct !== null ? `${(bar.pct / maxPct) * 100}%` : '0%';
        const pctLbl = document.createElement('span');
        pctLbl.className = 'dow-chart__pct';
        pctLbl.textContent = bar.pct !== null ? `${Math.round(bar.pct)}%` : '—';
        track.appendChild(fill);
        row.appendChild(lbl);
        row.appendChild(track);
        row.appendChild(pctLbl);
        chart.appendChild(row);
      }
      content.appendChild(chart);
    } else {
      content.appendChild(value);
      if (m.sub) {
        const sub = document.createElement('div');
        sub.className = 'metric-card__sub';
        sub.textContent = m.sub;
        content.appendChild(sub);
      }
    }

    card.appendChild(content);

    const helpText = metricHelp(m.id);
    if (helpText) {
      const help = document.createElement('div');
      help.className = 'metric-card__help';
      help.textContent = helpText;
      card.appendChild(help);

      helpBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();

        const currentlyOpen = card.classList.contains('metric-card--help-open');
        for (const el of metricsGrid.querySelectorAll('.metric-card--help-open')) {
          el.classList.remove('metric-card--help-open');
        }
        if (!currentlyOpen) {
          card.classList.add('metric-card--help-open');
        }
      });
    } else {
      helpBtn.style.visibility = 'hidden';
      helpBtn.setAttribute('aria-hidden', 'true');
    }

    metricsGrid.appendChild(card);
  }

  // Trade count in footer
  if (filteredCount !== rawCount) {
    tradeCount.textContent = `${filteredCount} / ${rawCount} ${t('tradesWord')}`;
  } else {
    tradeCount.textContent = `${rawCount} ${t('tradesWord')}`;
  }
}

// ── Main load ──────────────────────────────────────────────────────
async function loadData(activeFilters = {}) {
  hideError();
  setStatus('loading', t('loading'));
  btnRefresh.disabled = true;

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'FETCH_TRADES',
      filters: activeFilters,
      locale,
    });

    if (!response) {
      throw new Error(t('noResponse'));
    }
    if (!response.ok) {
      throw new Error(response.error || t('unknownError'));
    }

    renderMetrics(response.metrics, response.filteredCount, response.tradeCount);
    lastUpdatedAt = new Date();
    setStatus('ok', `${t('updated')} ${lastUpdatedAt.toLocaleTimeString()}`);
  } catch (e) {
    setStatus('error', t('error'));
    showError(e?.message || t('noMessage'));
  } finally {
    btnRefresh.disabled = false;
  }
}

// ── Boot ───────────────────────────────────────────────────────────
applyStaticTexts();
btnLang.addEventListener('click', toggleLocale);
btnRefresh.addEventListener('click', () => loadData());
document.addEventListener('DOMContentLoaded', () => loadData());
