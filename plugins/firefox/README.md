# Hash Hedge Diary - Firefox Build

Firefox версия расширения Hash Hedge Diary для отслеживания торговой статистики на HashHedge CFD платформе.

## Структура

```
firefox/
├── manifest.json           # WebExtensions manifest для Firefox
├── background/
│   └── background.js       # Фоновый скрипт (вместо service worker)
├── content/
│   ├── auth-extractor.js   # Извлечение токена из localStorage
│   └── trade-fetcher.js    # Перехват данных торгов
├── popup/
│   ├── popup.html          # UI
│   ├── popup.css           # Стили
│   └── popup.js            # Логика popup
├── assets/
│   ├── icons/              # Иконки (16, 48, 128 px)
│   └── images/             # Логотип и изображения
└── README.md               # Этот файл
```

## Отличия Firefox версии от Chrome

1. **Manifest**: использует `scripts` вместо `service_worker` в background - Firefox использует WebExtensions API Manifest V3, но с некоторыми отличиями
2. **API**: `browser.*` вместо `chrome.*` (хотя многие браузеры поддерживают оба)
3. **Browser ID**: добавлен `browser_specific_settings` для Firefox с уникальным ID

## Установка иконок и изображений

Скопируйте файлы из Chrome версии:

```bash
# Иконки (из chrome/assets/icons/)
cp ../chrome/assets/icons/icon16.png ./assets/icons/
cp ../chrome/assets/icons/icon48.png ./assets/icons/
cp ../chrome/assets/icons/icon128.png ./assets/icons/

# Логотип (из chrome/assets/images/)
cp ../chrome/assets/images/logo.png ./assets/images/
```

Или используйте символические ссылки для синхронизации:

```bash
# На Linux/macOS
ln -s ../../chrome/assets/icons ./assets/icons
ln -s ../../chrome/assets/images ./assets/images
```

## Тестирование в Firefox

1. Откройте `about:debugging` в Firefox
2. Нажмите "This Firefox" в левой панели
3. Нажмите "Load Temporary Add-on"
4. Выберите файл `manifest.json` из этой папки
5. Расширение загрузится и будет готово к тестированию

## Сборка для издания в Firefox

1. Архивируйте содержимое папки (кроме `.gitkeep`)
2. Подпишите расширение или загрузите в Firefox Add-ons
3. AMO (addons.mozilla.org) требует:
   - privacy policy
   - исходный код
   - подробное описание

## Различия API и совместимость

### Поддерживаемые API:
- ✅ `browser.runtime.onMessage` / sendMessage
- ✅ `browser.storage.*`
- ✅ `browser.action` (вместо `browser.browserAction`)
- ✅ Fetch API, localStorage, sessionStorage

### Требования минимальной версии Firefox: 109.0

## Отладка

Откройте devtools для background скрипта в `about:debugging`:
1. Кликните на "Inspect" рядом с расширением
2. Перейдите на вкладку "Console" для логов

Для popup-окна: Правый клик на расширении → "Inspect Popup"

## Синхронизация с Chrome версией

Шаги, которые отличаются:
1. `manifest.json` - используйте Firefox версию
2. Scripts с `chrome.*` → преобразованы на `browser.*`
3. Background - используется обычный скрипт вместо service worker

Все остальные файлы (контент скрипты, popup UI) могут быть идентичны.
