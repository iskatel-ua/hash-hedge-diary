/* global browser */
'use strict';

const LOCALE_STORAGE_KEY = 'hhd_locale';
const ACTIVE_TAB_STORAGE_KEY = 'hhd_active_tab';
const SETTINGS_STORAGE_KEY = 'hhd_sltp_settings';
const SETTINGS_EXPORT_FILENAME = 'hash-hedge-settings.json';
const POPUP_AUTO_REFRESH_MS = 60_000;
const BACKGROUND_REFRESH_INTERVAL_MS = 5 * 60_000;
const POPUP_OPEN_REFRESH_GRACE_MS = 60_000;
const DEFAULT_SLTP_SETTINGS = Object.freeze({
  slPercent: 1,
  tpPercent: 1,
});
let locale = getInitialLocale();
let lastRenderState = null;
let activeTab = getInitialActiveTab();
let sltpSettings = getInitialSltpSettings();
let autoRefreshTimerId = null;
let countdownTimerId = null;
let lastUpdatedAtMs = null;
let nextRefreshAtMs = null;
let refreshStatusSyncInProgress = false;
let selectedPositionContext = null;
let successHideTimerId = null;

const I18N = {
  en: {
    title: 'Hash Hedge Diary',
    donateButton: 'Thank you',
    donateTitle: 'Open support page',
    initialising: 'Initialising…',
    loading: 'Loading…',
    error: 'Error',
    refresh: 'Refresh',
    tradesWord: 'trades',
    tabStats: 'Stats',
    tabOpenDeals: 'Positions',
    tabSettings: 'Settings',
    positionsEmpty: 'No open positions',
    positionsInstrument: 'Instrument',
    positionsVolume: 'Volume',
    positionsState: 'State',
    positionsStops: 'SL / TP',
    positionsRisk: '!',
    positionsNoSl: 'No SL',
    positionsNoTp: 'No TP',
    positionsNoSlTp: 'No SL / TP',
    positionsStopsSet: 'SL and TP set',
    positionsSl: 'SL',
    positionsTp: 'TP',
    positionsNotSet: '—',
    noResponse: 'No response from background. Extension may need reloading.',
    unknownError: 'Unknown error',
    noMessage: 'No error message',
    helpTitle: 'Metric help',
    helpButton: 'Open metric help',
    switchLangTitle: 'Switch language',
    switchedTo: 'Language',
    currentLanguageName: 'English',
    reloadTabButton: 'Reload trade tab',
    reloadTabTitle: 'Reload the HashHedge trade page',
    reloadTabSuccess: 'Trade tab reloaded',
    reloadTabNotFound: 'Trade tab not found',
    reloadTabError: 'Failed to reload trade tab',
    settingsTitle: 'Default SL / TP',
    settingsSl: 'SL',
    settingsTp: 'TP',
    settingsPercentHint: 'Percent from entry price',
    settingsImport: 'Import JSON',
    settingsExport: 'Export JSON',
    settingsSaved: 'Settings saved',
    settingsImported: 'Settings imported',
    settingsExported: 'Settings exported',
    settingsImportError: 'Failed to import settings JSON',
    settingsActionTitle: 'Position action',
    settingsActionButton: 'Set default SL / TP',
    settingsActionSuccess: 'Default SL / TP applied',
    settingsActionMissing: 'Position entry price or id is missing',
    settingsActionMissingPrice: 'Position entry price is missing',
    settingsActionMissingId: 'Position idStr is missing',
    settingsActionFailed: 'Failed to set SL / TP',
    dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    metricLabels: {
      winRate: 'Win Rate',
      hourlyWinRate: 'Hourly Win Rate (open time)',
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
      hourlyWinRate: 'Hourly win rate grouped by trade open hour in your browser local time. Each bar is split into profitable and unprofitable trade share, together making 100%.',
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
    donateButton: 'Thank you',
    donateTitle: 'Открыть страницу поддержки',
    initialising: 'Инициализация…',
    loading: 'Загрузка…',
    error: 'Ошибка',
    refresh: 'Обновить',
    tradesWord: 'сделок',
    tabStats: 'Статистика',
    tabOpenDeals: 'Позиции',
    tabSettings: 'Настройки',
    positionsEmpty: 'Открытых позиций нет',
    positionsInstrument: 'Инстр.',
    positionsVolume: 'Объём',
    positionsState: 'Сост.',
    positionsStops: 'SL / TP',
    positionsRisk: '!',
    positionsNoSl: 'Нет SL',
    positionsNoTp: 'Нет TP',
    positionsNoSlTp: 'Нет SL / TP',
    positionsStopsSet: 'SL и TP установлены',
    positionsSl: 'SL',
    positionsTp: 'TP',
    positionsNotSet: '—',
    noResponse: 'Нет ответа от background. Возможно, нужно перезагрузить расширение.',
    unknownError: 'Неизвестная ошибка',
    noMessage: 'Нет текста ошибки',
    helpTitle: 'Справка по метрике',
    helpButton: 'Открыть справку по метрике',
    switchLangTitle: 'Переключить язык',
    switchedTo: 'Язык',
    currentLanguageName: 'Русский',
    reloadTabButton: 'Перезагрузить таб',
    reloadTabTitle: 'Перезагрузить страницу торговли HashHedge',
    reloadTabSuccess: 'Таб торговли перезагружен',
    reloadTabNotFound: 'Таб торговли не найден',
    reloadTabError: 'Ошибка при перезагрузке таба',
    settingsTitle: 'SL / TP по умолчанию',
    settingsSl: 'SL',
    settingsTp: 'TP',
    settingsPercentHint: 'Процент от цены входа',
    settingsImport: 'Импорт JSON',
    settingsExport: 'Экспорт JSON',
    settingsSaved: 'Настройки сохранены',
    settingsImported: 'Настройки импортированы',
    settingsExported: 'Настройки экспортированы',
    settingsImportError: 'Не удалось импортировать JSON настроек',
    settingsActionTitle: 'Действие по позиции',
    settingsActionButton: 'Задать SL / TP по умолчанию',
    settingsActionSuccess: 'SL / TP по умолчанию применены',
    settingsActionMissing: 'У позиции нет цены входа или id',
    settingsActionMissingPrice: 'У позиции нет цены входа',
    settingsActionMissingId: 'У позиции нет idStr (positionId)',
    settingsActionFailed: 'Не удалось установить SL / TP',
    dow: ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'],
    metricLabels: {
      winRate: 'Винрейт',
      hourlyWinRate: 'Винрейт по часам (время открытия)',
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
      hourlyWinRate: 'Винрейт по часу открытия сделки в локальном времени браузера. Каждый столбец разделён на долю прибыльных и убыточных сделок, вместе они дают 100%.',
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
    (typeof browser !== 'undefined' && browser.i18n && browser.i18n.getUILanguage
      ? browser.i18n.getUILanguage()
      : navigator.language) || 'en';
  return String(lang).toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

function persistLocale() {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch (_) {}
}

function getInitialActiveTab() {
  try {
    const saved = localStorage.getItem(ACTIVE_TAB_STORAGE_KEY);
    if (saved === 'stats' || saved === 'openDeals' || saved === 'settings') {
      return saved;
    }
  } catch (_) {}
  return 'stats';
}

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

function normalizeSltpSettings(value) {
  return {
    slPercent: clampNumber(value?.slPercent, 1, 15, DEFAULT_SLTP_SETTINGS.slPercent),
    tpPercent: clampNumber(value?.tpPercent, 1, 50, DEFAULT_SLTP_SETTINGS.tpPercent),
  };
}

function getInitialSltpSettings() {
  try {
    const saved = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (saved) {
      return normalizeSltpSettings(JSON.parse(saved));
    }
  } catch (_) {}
  return { ...DEFAULT_SLTP_SETTINGS };
}

function persistSltpSettings() {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(sltpSettings));
  } catch (_) {}
}

function persistActiveTab(tabId) {
  try {
    localStorage.setItem(ACTIVE_TAB_STORAGE_KEY, tabId);
  } catch (_) {}
}

function toggleLocale() {
  locale = locale === 'ru' ? 'en' : 'ru';
  persistLocale();
  applyStaticTexts();

  if (lastRenderState) {
    renderMetrics(lastRenderState.metrics, lastRenderState.filteredCount, lastRenderState.rawCount);
    renderOpenPositions(lastRenderState.openPositions || []);
  }

  if (selectedPositionContext) {
    renderPositionActionMenu();
  }

  setStatus('ok', `${t('switchedTo')} ${t('currentLanguageName')}`);
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
const errorMsg   = document.getElementById('errorMsg');
const successMsg = document.getElementById('successMsg');
const metricsGrid = document.getElementById('metricsGrid');
const tabStats = document.getElementById('tabStats');
const tabOpenDeals = document.getElementById('tabOpenDeals');
const tabSettings = document.getElementById('tabSettings');
const tabStatsLabel = document.getElementById('tabStatsLabel');
const tabOpenDealsLabel = document.getElementById('tabOpenDealsLabel');
const tabSettingsLabel = document.getElementById('tabSettingsLabel');
const panelStats = document.getElementById('panelStats');
const panelOpenDeals = document.getElementById('panelOpenDeals');
const panelSettings = document.getElementById('panelSettings');
const openDealsCount = document.getElementById('openDealsCount');
const positionsWrap = document.getElementById('positionsWrap');
const positionsEmpty = document.getElementById('positionsEmpty');
const btnRefresh  = document.getElementById('btnRefresh');
const tradeCount  = document.getElementById('tradeCount');
const headerTitle = document.querySelector('.header__title');
const btnLang = document.getElementById('btnLang');
const btnReloadTab = document.getElementById('btnReloadTab');
const btnDonate = document.getElementById('btnDonate');
const settingsTitle = document.getElementById('settingsTitle');
const slRange = document.getElementById('slRange');
const tpRange = document.getElementById('tpRange');
const slRangeLabel = document.getElementById('slRangeLabel');
const tpRangeLabel = document.getElementById('tpRangeLabel');
const slRangeValue = document.getElementById('slRangeValue');
const tpRangeValue = document.getElementById('tpRangeValue');
const slRangeHint = document.getElementById('slRangeHint');
const tpRangeHint = document.getElementById('tpRangeHint');
const btnExportSettings = document.getElementById('btnExportSettings');
const btnImportSettings = document.getElementById('btnImportSettings');
const settingsImportInput = document.getElementById('settingsImportInput');
const positionActionMenu = document.getElementById('positionActionMenu');
const positionActionTitle = document.getElementById('positionActionTitle');
const positionActionMeta = document.getElementById('positionActionMeta');
const positionActionPrices = document.getElementById('positionActionPrices');
const btnApplyDefaultStops = document.getElementById('btnApplyDefaultStops');

// ── Status helpers ─────────────────────────────────────────────────
function setStatus(state, text) {
  document.body.dataset.state = state;
  if (text) {
    btnRefresh.title = text;
  }
}

function showError(msg) {
  hideSuccess();
  errorMsg.textContent = msg;
  errorMsg.classList.add('visible');
}
function hideError() {
  errorMsg.classList.remove('visible');
}

function showSuccess(msg, timeoutMs = 3000) {
  hideError();
  if (successHideTimerId !== null) {
    clearTimeout(successHideTimerId);
    successHideTimerId = null;
  }

  successMsg.textContent = msg;
  successMsg.classList.add('visible');

  successHideTimerId = setTimeout(() => {
    successMsg.classList.remove('visible');
    successHideTimerId = null;
  }, timeoutMs);
}

function hideSuccess() {
  if (successHideTimerId !== null) {
    clearTimeout(successHideTimerId);
    successHideTimerId = null;
  }
  successMsg.classList.remove('visible');
}

// ── Metric card rendering ──────────────────────────────────────────

const WIDE_METRICS = new Set(['hourlyWinRate']);

function applyStaticTexts() {
  document.documentElement.lang = locale;
  document.title = t('title');
  if (headerTitle) headerTitle.textContent = t('title');
  btnRefresh.setAttribute('aria-label', t('refresh'));
  renderRefreshCountdown();
  btnLang.textContent = locale.toUpperCase();
  btnLang.title = t('switchLangTitle');
  btnLang.classList.toggle('btn-lang--ru', locale === 'ru');
  btnLang.classList.toggle('btn-lang--en', locale === 'en');
  if (btnReloadTab) {
    btnReloadTab.textContent = '↻';
    btnReloadTab.title = t('reloadTabTitle');
    btnReloadTab.setAttribute('aria-label', t('reloadTabTitle'));
  }
  if (btnDonate) {
    btnDonate.textContent = t('donateButton');
    btnDonate.title = t('donateTitle');
    btnDonate.setAttribute('aria-label', t('donateTitle'));
  }
  if (tabStatsLabel) tabStatsLabel.textContent = t('tabStats');
  if (tabOpenDealsLabel) tabOpenDealsLabel.textContent = t('tabOpenDeals');
  if (tabSettingsLabel) tabSettingsLabel.textContent = t('tabSettings');
  if (positionsEmpty) positionsEmpty.textContent = t('positionsEmpty');
  if (settingsTitle) settingsTitle.textContent = t('settingsTitle');
  if (slRangeLabel) slRangeLabel.textContent = t('settingsSl');
  if (tpRangeLabel) tpRangeLabel.textContent = t('settingsTp');
  if (slRangeHint) slRangeHint.textContent = t('settingsPercentHint');
  if (tpRangeHint) tpRangeHint.textContent = t('settingsPercentHint');
  if (btnExportSettings) btnExportSettings.textContent = t('settingsExport');
  if (btnImportSettings) btnImportSettings.textContent = t('settingsImport');
  if (positionActionTitle) positionActionTitle.textContent = t('settingsActionTitle');
  if (btnApplyDefaultStops) btnApplyDefaultStops.textContent = t('settingsActionButton');
  renderSltpSettings();
  setStatus('loading', t('initialising'));
}

function renderSltpSettings() {
  if (slRange) slRange.value = String(sltpSettings.slPercent);
  if (tpRange) tpRange.value = String(sltpSettings.tpPercent);
  if (slRangeValue) slRangeValue.textContent = `${sltpSettings.slPercent}%`;
  if (tpRangeValue) tpRangeValue.textContent = `${sltpSettings.tpPercent}%`;
}

function updateSltpSetting(key, value) {
  sltpSettings = normalizeSltpSettings({
    ...sltpSettings,
    [key]: value,
  });
  persistSltpSettings();
  renderSltpSettings();
  if (selectedPositionContext) {
    renderPositionActionMenu();
  }
  setStatus('ok', t('settingsSaved'));
}

function formatCountdown(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function getRemainingRefreshMs() {
  if (Number.isFinite(nextRefreshAtMs)) {
    return Math.max(0, nextRefreshAtMs - Date.now());
  }

  if (!Number.isFinite(lastUpdatedAtMs)) {
    return BACKGROUND_REFRESH_INTERVAL_MS;
  }

  const elapsed = Date.now() - lastUpdatedAtMs;
  return Math.max(0, BACKGROUND_REFRESH_INTERVAL_MS - elapsed);
}

function renderRefreshCountdown() {
  btnRefresh.textContent = `↻ ${formatCountdown(getRemainingRefreshMs())}`;
}

async function syncRefreshStatus() {
  if (refreshStatusSyncInProgress) {
    return;
  }

  refreshStatusSyncInProgress = true;
  try {
    const response = await browser.runtime.sendMessage({ type: 'GET_REFRESH_STATUS' });
    if (!response?.ok) {
      return;
    }

    const nextRefreshAt = Number(response.nextRefreshAt);
    nextRefreshAtMs = Number.isFinite(nextRefreshAt) ? nextRefreshAt : null;

    const lastUpdatedAt = Number(response.lastUpdatedAt);
    if (Number.isFinite(lastUpdatedAt)) {
      lastUpdatedAtMs = lastUpdatedAt;
    }

    renderRefreshCountdown();
  } catch (_) {
    // Ignore status sync failures; countdown falls back to local estimate.
  } finally {
    refreshStatusSyncInProgress = false;
  }
}

function startRefreshCountdown() {
  if (countdownTimerId !== null) {
    clearInterval(countdownTimerId);
  }

  renderRefreshCountdown();
  countdownTimerId = setInterval(() => {
    renderRefreshCountdown();
    if (getRemainingRefreshMs() <= 0) {
      void syncRefreshStatus();
    }
  }, 1000);
}

function renderMetrics(metrics, filteredCount, rawCount) {
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

    const isHourlyWinRate = m.id === 'hourlyWinRate' && Array.isArray(m.bars);

    if (!m.bars || isHourlyWinRate) {
      card.appendChild(header);
    }

    const content = document.createElement('div');
    content.className = 'metric-card__content';

    if (m.bars && !isHourlyWinRate) {
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
    } else if (isHourlyWinRate) {
      const chart = document.createElement('div');
      chart.className = 'hourly-chart';

      const body = document.createElement('div');
      body.className = 'hourly-chart__body';

      const scale = document.createElement('div');
      scale.className = 'hourly-chart__scale';

      for (const mark of ['100%', '50%', '0%']) {
        const markEl = document.createElement('span');
        markEl.className = 'hourly-chart__scale-label';
        markEl.textContent = mark;
        scale.appendChild(markEl);
      }

      const bars = document.createElement('div');
      bars.className = 'hourly-chart__bars';

      for (const bar of m.bars) {
        const col = document.createElement('div');
        col.className = 'hourly-chart__col';

        const stem = document.createElement('div');
        stem.className = 'hourly-chart__stem';

        if (bar.hasData) {
          const derivedRate = Number.isFinite(Number(bar.rate)) ? Number(bar.rate) : null;
          const winPct = Number.isFinite(Number(bar.winPct))
            ? Number(bar.winPct)
            : derivedRate !== null
              ? derivedRate
              : 0;
          const lossPct = Number.isFinite(Number(bar.lossPct))
            ? Number(bar.lossPct)
            : Math.max(0, 100 - winPct);

          const lossFill = document.createElement('div');
          lossFill.className = 'hourly-chart__fill hourly-chart__fill--loss';
          lossFill.style.height = `${lossPct.toFixed(2)}%`;

          const winFill = document.createElement('div');
          winFill.className = 'hourly-chart__fill hourly-chart__fill--win';
          winFill.style.height = `${winPct.toFixed(2)}%`;

          stem.appendChild(lossFill);
          stem.appendChild(winFill);
        } else {
          col.classList.add('hourly-chart__col--empty');
        }

        const lbl = document.createElement('span');
        lbl.className = 'hourly-chart__label';
        lbl.textContent = bar.hourLabel ?? '--';

        col.appendChild(stem);
        col.appendChild(lbl);

        bars.appendChild(col);
      }

      body.appendChild(scale);
      body.appendChild(bars);
      chart.appendChild(body);
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

function switchTab(tabId) {
  if (tabId !== 'stats' && tabId !== 'openDeals' && tabId !== 'settings') {
    tabId = 'stats';
  }

  activeTab = tabId;
  persistActiveTab(tabId);
  const isStats = tabId === 'stats';
  const isOpenDeals = tabId === 'openDeals';
  const isSettings = tabId === 'settings';
  tabStats.classList.toggle('tab-btn--active', isStats);
  tabOpenDeals.classList.toggle('tab-btn--active', isOpenDeals);
  tabSettings.classList.toggle('tab-btn--active', isSettings);
  tabStats.setAttribute('aria-selected', String(isStats));
  tabOpenDeals.setAttribute('aria-selected', String(isOpenDeals));
  tabSettings.setAttribute('aria-selected', String(isSettings));
  panelStats.classList.toggle('tab-panel--active', isStats);
  panelOpenDeals.classList.toggle('tab-panel--active', isOpenDeals);
  panelSettings.classList.toggle('tab-panel--active', isSettings);
  panelStats.hidden = !isStats;
  panelOpenDeals.hidden = !isOpenDeals;
  panelSettings.hidden = !isSettings;

  if (!isOpenDeals) {
    closePositionActionMenu();
  }
}

function formatCompactUsd(value) {
  const amount = Number(value) || 0;
  const abs = Math.abs(amount);

  if (abs >= 1_000_000_000) return `${trimDecimal(amount / 1_000_000_000)}B`;
  if (abs >= 1_000_000) return `${trimDecimal(amount / 1_000_000)}M`;
  if (abs >= 1_000) return `${trimDecimal(amount / 1_000)}K`;
  return trimDecimal(amount);
}

function trimDecimal(value) {
  const abs = Math.abs(value);
  const fixed = abs >= 100 ? value.toFixed(0) : value.toFixed(1);
  return fixed.replace(/\.0$/, '');
}

function formatSignedPercent(value) {
  const num = Number(value) || 0;
  const sign = num > 0 ? '+' : '';
  return `${sign}${trimDecimal(num)}%`;
}

function formatPositionPercent(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return t('positionsNotSet');

  const sign = num > 0 ? '+' : '';
  return `${sign}${num.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')}%`;
}

function formatPrice(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return t('positionsNotSet');
  return num.toLocaleString(locale === 'ru' ? 'ru-RU' : 'en-US', {
    maximumFractionDigits: 2,
  });
}

function estimateVolumeUsd(position) {
  const baseSize = Number(position?.baseSize);
  const openPrice = Number(position?.openPrice);
  const margin = Number(position?.margin);
  const leverage = Number(position?.leverage) || 1;

  if (Number.isFinite(baseSize) && Number.isFinite(openPrice) && baseSize > 0 && openPrice > 0) {
    return baseSize * openPrice;
  }
  if (Number.isFinite(margin) && margin > 0) {
    return margin * leverage;
  }
  return 0;
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

function getPositionPnlPercent(position) {
  const margin = Number(position?.positionMargin ?? position?.margin);
  const openPrice = Number(position?.openPrice);
  const currentPrice = getPositionCurrentPrice(position);
  const direction = String(position?.direction || '').toLowerCase();
  const directionSign = direction === 'short' ? -1 : direction === 'long' ? 1 : 0;
  const baseSize = Math.abs(Number(position?.baseSize));

  if (
    Number.isFinite(openPrice) &&
    openPrice > 0 &&
    Number.isFinite(currentPrice) &&
    currentPrice > 0 &&
    directionSign &&
    Number.isFinite(baseSize) &&
    baseSize > 0 &&
    Number.isFinite(margin) &&
    margin > 0
  ) {
    const pnl = (currentPrice - openPrice) * baseSize * directionSign;
    return (pnl / margin) * 100;
  }

  const leverage = Number(position?.leverage);
  if (
    Number.isFinite(openPrice) &&
    openPrice > 0 &&
    Number.isFinite(currentPrice) &&
    currentPrice > 0 &&
    directionSign &&
    Number.isFinite(leverage) &&
    leverage > 0
  ) {
    return (((currentPrice - openPrice) / openPrice) * leverage * 100) * directionSign;
  }

  const explicitPnl = Number(position?.profitUnreal);
  if (Number.isFinite(explicitPnl) && Number.isFinite(margin) && margin > 0) {
    return (explicitPnl / margin) * 100;
  }

  return null;
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

function hasExistingStops(position) {
  const sl = Number(position?.stopLossPrice);
  const tp = Number(position?.stopProfitPrice);
  return (Number.isFinite(sl) && sl > 0) || (Number.isFinite(tp) && tp > 0);
}

function buildDefaultStops(position) {
  const openPrice = Number(position?.openPrice);
  const direction = String(position?.direction || '').toLowerCase();
  const positionId = getPositionId(position);
  const stopId = getStopId(position);

  if (!Number.isFinite(openPrice) || openPrice <= 0) {
    throw new Error(t('settingsActionMissingPrice'));
  }

  const precision = getPricePrecision(position);
  const isShort = direction === 'short';
  const slMultiplier = isShort
    ? 1 + sltpSettings.slPercent / 100
    : 1 - sltpSettings.slPercent / 100;
  const tpMultiplier = isShort
    ? 1 - sltpSettings.tpPercent / 100
    : 1 + sltpSettings.tpPercent / 100;
  const stopLossPrice = openPrice * slMultiplier;
  const stopProfitPrice = openPrice * tpMultiplier;

  return {
    positionId,
    stopId,
    stopLossPrice,
    stopProfitPrice,
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
  };
}

function closePositionActionMenu() {
  if (selectedPositionContext?.rowElement) {
    selectedPositionContext.rowElement.classList.remove('pos-row--active');
  }
  selectedPositionContext = null;
  if (positionActionMenu) {
    positionActionMenu.hidden = true;
  }
}

function positionMenuCoords(rowElement) {
  const rect = rowElement.getBoundingClientRect();
  const menuWidth = 240;
  const left = Math.min(window.innerWidth - menuWidth - 12, Math.max(12, rect.left));
  const desiredTop = rect.bottom + 6;
  const top = Math.min(window.innerHeight - 132, Math.max(12, desiredTop));
  return { left, top };
}

function renderPositionActionMenu() {
  if (!selectedPositionContext || !positionActionMenu) {
    return;
  }

  const { position, rowElement } = selectedPositionContext;
  let preview;
  try {
    preview = buildDefaultStops(position);
  } catch (error) {
    closePositionActionMenu();
    showError(error?.message || t('settingsActionMissing'));
    return;
  }
  const coords = positionMenuCoords(rowElement);

  rowElement.classList.add('pos-row--active');
  positionActionMeta.textContent = `${String(position?.instrument || '').toUpperCase()} • ${String(position?.direction || '').toUpperCase()}`;
  positionActionPrices.innerHTML = `<strong>${t('settingsSl')}:</strong> ${formatPrice(preview.stopLossPrice)} (${sltpSettings.slPercent}%)<br><strong>${t('settingsTp')}:</strong> ${formatPrice(preview.stopProfitPrice)} (${sltpSettings.tpPercent}%)`;
  positionActionMenu.style.left = `${coords.left}px`;
  positionActionMenu.style.top = `${coords.top}px`;
  positionActionMenu.hidden = false;
}

function openPositionActionMenu(position, rowElement) {
  if (selectedPositionContext?.rowElement === rowElement && !positionActionMenu.hidden) {
    closePositionActionMenu();
    return;
  }

  if (selectedPositionContext?.rowElement) {
    selectedPositionContext.rowElement.classList.remove('pos-row--active');
  }

  selectedPositionContext = { position, rowElement };
  hideError();
  renderPositionActionMenu();
}

function exportSettings() {
  const blob = new Blob([JSON.stringify(sltpSettings, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = SETTINGS_EXPORT_FILENAME;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  setStatus('ok', t('settingsExported'));
}

async function importSettings(file) {
  const content = await file.text();
  sltpSettings = normalizeSltpSettings(JSON.parse(content));
  persistSltpSettings();
  renderSltpSettings();
  if (selectedPositionContext) {
    renderPositionActionMenu();
  }
  setStatus('ok', t('settingsImported'));
}

async function applyDefaultStopsToSelectedPosition() {
  if (!selectedPositionContext) {
    return;
  }

  const { position } = selectedPositionContext;
  const isUpdate = hasExistingStops(position);
  btnApplyDefaultStops.disabled = true;

  try {
    const request = buildDefaultStops(position);

    if (isUpdate && !request.stopId) {
      throw new Error(t('settingsActionMissing'));
    }

    if (!isUpdate && !request.positionId) {
      throw new Error(t('settingsActionMissingId'));
    }

    const response = await browser.runtime.sendMessage({
      type: 'UPSERT_POSITION_SLTP',
      locale,
      payload: request.payload,
      hasExistingStops: isUpdate,
    });

    if (!response?.ok) {
      throw new Error(response?.error || t('settingsActionFailed'));
    }

    closePositionActionMenu();
    setStatus('ok', t('settingsActionSuccess'));
    showSuccess(t('settingsActionSuccess'));
    await loadData({}, { forceRefresh: true, minFreshMs: 0 });
  } catch (error) {
    setStatus('error', t('settingsActionFailed'));
    showError(error?.message || t('settingsActionFailed'));
  } finally {
    btnApplyDefaultStops.disabled = false;
  }
}

function renderOpenPositions(openPositions) {
  const rows = Array.isArray(openPositions) ? openPositions : [];
  openDealsCount.textContent = String(rows.length);
  closePositionActionMenu();

  if (!rows.length) {
    positionsWrap.innerHTML = '';
    positionsWrap.style.display = 'none';
    positionsEmpty.classList.add('visible');
    return;
  }

  positionsWrap.style.display = 'block';
  positionsEmpty.classList.remove('visible');

  const table = document.createElement('table');
  table.className = 'positions-table';

  table.innerHTML = `
    <colgroup>
      <col style="width:8%">
      <col style="width:26%">
      <col style="width:15%">
      <col style="width:14%">
      <col style="width:27%">
      <col style="width:10%">
    </colgroup>
    <thead>
      <tr>
        <th class="pos-col--direction">⟲</th>
        <th class="pos-col--instrument">${t('positionsInstrument')}</th>
        <th class="pos-col--volume">${t('positionsVolume')}</th>
        <th class="pos-col--state">${t('positionsState')}</th>
        <th class="pos-col--stops">${t('positionsStops')}</th>
        <th class="pos-col--risk">${t('positionsRisk')}</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;

  const tbody = table.querySelector('tbody');
  for (const pos of rows) {
    const sl = Number(pos?.stopLossPrice);
    const tp = Number(pos?.stopProfitPrice);
    const hasSl = Number.isFinite(sl) && sl > 0;
    const hasTp = Number.isFinite(tp) && tp > 0;
    const volume = estimateVolumeUsd(pos);
    const pnlPct = getPositionPnlPercent(pos);
    const pnlStateClass = pnlPct > 0 ? 'pos-state--positive' : pnlPct < 0 ? 'pos-state--negative' : 'pos-state--neutral';
    const pnlDisplay = formatPositionPercent(pnlPct);

    const isRisk = !hasSl || !hasTp;
    const riskClass = !hasSl ? 'pos-risk pos-risk--danger' : (!hasTp ? 'pos-risk pos-risk--warn' : 'pos-risk');
    const riskTitle = !hasSl && !hasTp
      ? t('positionsNoSlTp')
      : !hasSl
        ? t('positionsNoSl')
        : !hasTp
          ? t('positionsNoTp')
          : t('positionsStopsSet');
    const riskMark = isRisk ? '<span class="pos-risk-icon" aria-hidden="true">⚠</span>' : '';

    const direction = String(pos?.direction || '').toLowerCase();
    const isLong = direction === 'long';
    const isShort = direction === 'short';
    const directionClass = isLong
      ? 'pos-direction pos-direction--long'
      : isShort
        ? 'pos-direction pos-direction--short'
        : 'pos-direction';
    const directionArrow = isLong ? '⬆' : isShort ? '⬇' : '•';

    const tr = document.createElement('tr');
    tr.className = 'pos-row--interactive';
    tr.tabIndex = 0;
    tr.innerHTML = `
      <td class="pos-col--direction"><span class="${directionClass}">${directionArrow}</span></td>
      <td class="pos-instrument">${String(pos?.instrument || '').toUpperCase()}</td>
      <td class="pos-volume">${formatCompactUsd(volume)}</td>
      <td class="pos-state ${pnlStateClass}">${pnlDisplay}</td>
      <td class="pos-col--stops">
        <div class="pos-stops">
          <span class="pos-stop-line"><strong>${t('positionsSl')}</strong><em>${formatPrice(sl)}</em></span>
          <span class="pos-stop-line"><strong>${t('positionsTp')}</strong><em>${formatPrice(tp)}</em></span>
        </div>
      </td>
      <td class="pos-col--risk ${riskClass}" title="${riskTitle}" aria-label="${riskTitle}">${riskMark}</td>
    `;
    tr.addEventListener('click', (event) => {
      event.stopPropagation();
      openPositionActionMenu(pos, tr);
    });
    tr.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openPositionActionMenu(pos, tr);
      }
    });
    tbody.appendChild(tr);
  }

  positionsWrap.innerHTML = '';
  positionsWrap.appendChild(table);
}

// ── Reload trade tab helper ───────────────────────────────────────
async function reloadTradeTab() {
  try {
    const tabs = await browser.tabs.query({
      url: ['*://hashhedge.com/client/trade*', '*://*.hashhedge.com/client/trade*']
    });

    if (tabs.length === 0) {
      showError(t('reloadTabNotFound'));
      return;
    }

    // Reload the first matching tab
    await browser.tabs.reload(tabs[0].id);
    setStatus('ok', t('reloadTabSuccess'));
  } catch (error) {
    setStatus('error', t('reloadTabError'));
    showError(error?.message || t('reloadTabError'));
  }
}

// ── Main load ──────────────────────────────────────────────────────
async function loadData(activeFilters = {}, options = {}) {
  const {
    forceRefresh = false,
    minFreshMs = POPUP_OPEN_REFRESH_GRACE_MS,
    cacheOnly = false,
    silent = false,
  } = options;

  if (!silent) {
    hideError();
    setStatus('loading', t('loading'));
    btnRefresh.disabled = true;
  }

  try {
    const response = await browser.runtime.sendMessage({
      type: 'FETCH_TRADES',
      filters: activeFilters,
      locale,
      forceRefresh,
      minFreshMs,
      cacheOnly,
    });

    if (!response) {
      throw new Error(t('noResponse'));
    }
    if (!response.ok) {
      throw new Error(response.error || t('unknownError'));
    }

    renderMetrics(response.metrics, response.filteredCount, response.tradeCount);
    const userPositions = response.userPositions || response.openPositions || [];
    renderOpenPositions(userPositions);
    lastRenderState = {
      metrics: response.metrics,
      openPositions: userPositions,
      filteredCount: response.filteredCount,
      rawCount: response.tradeCount,
    };
    lastUpdatedAtMs = Number(response.lastUpdatedAt);
    if (!Number.isFinite(lastUpdatedAtMs)) {
      lastUpdatedAtMs = Date.now();
    }
    renderRefreshCountdown();
    void syncRefreshStatus();
    setStatus('ok', `${t('refresh')}`);
  } catch (e) {
    if (silent) {
      return;
    }
    setStatus('error', t('error'));
    showError(e?.message || t('noMessage'));
  } finally {
    if (!silent) {
      btnRefresh.disabled = false;
    }
  }
}

function startAutoRefresh() {
  if (autoRefreshTimerId !== null) {
    clearInterval(autoRefreshTimerId);
  }

  autoRefreshTimerId = setInterval(() => {
    if (!document.hidden) {
      void loadData({}, {
        cacheOnly: true,
        minFreshMs: Number.MAX_SAFE_INTEGER,
        silent: true,
      });
    }
  }, POPUP_AUTO_REFRESH_MS);
}

// ── Boot ───────────────────────────────────────────────────────────
applyStaticTexts();
btnLang.addEventListener('click', toggleLocale);
tabStats.addEventListener('click', () => switchTab('stats'));
tabOpenDeals.addEventListener('click', () => switchTab('openDeals'));
tabSettings.addEventListener('click', () => switchTab('settings'));
if (btnReloadTab) {
  btnReloadTab.addEventListener('click', reloadTradeTab);
}
if (slRange) {
  slRange.addEventListener('input', (event) => updateSltpSetting('slPercent', event.target.value));
}
if (tpRange) {
  tpRange.addEventListener('input', (event) => updateSltpSetting('tpPercent', event.target.value));
}
if (btnExportSettings) {
  btnExportSettings.addEventListener('click', exportSettings);
}
if (btnImportSettings && settingsImportInput) {
  btnImportSettings.addEventListener('click', () => settingsImportInput.click());
  settingsImportInput.addEventListener('change', async (event) => {
    const [file] = event.target.files || [];
    if (!file) {
      return;
    }

    try {
      await importSettings(file);
    } catch (error) {
      setStatus('error', t('settingsImportError'));
      showError(error?.message || t('settingsImportError'));
    } finally {
      settingsImportInput.value = '';
    }
  });
}
if (btnApplyDefaultStops) {
  btnApplyDefaultStops.addEventListener('click', (event) => {
    event.stopPropagation();
    void applyDefaultStopsToSelectedPosition();
  });
}
btnRefresh.addEventListener('click', () => loadData({}, { forceRefresh: true, minFreshMs: 0 }));
document.addEventListener('click', (event) => {
  if (positionActionMenu.hidden) {
    return;
  }

  const target = event.target instanceof Element ? event.target : null;

  if (target && positionActionMenu.contains(target)) {
    return;
  }

  if (target && target.closest('.pos-row--interactive')) {
    return;
  }

  closePositionActionMenu();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closePositionActionMenu();
  }
});
document.addEventListener('DOMContentLoaded', () => {
  switchTab(activeTab);
  startRefreshCountdown();
  void syncRefreshStatus();
  void loadData({}, { minFreshMs: POPUP_OPEN_REFRESH_GRACE_MS });
  startAutoRefresh();
});
window.addEventListener('beforeunload', () => {
  if (autoRefreshTimerId !== null) {
    clearInterval(autoRefreshTimerId);
  }
  if (countdownTimerId !== null) {
    clearInterval(countdownTimerId);
  }
});
