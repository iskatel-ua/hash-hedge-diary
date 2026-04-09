# Firefox vs Chrome - Миграция и синхронизация

## Файлы общие для обеих версий

Эти файлы идентичны и могут быть синхронизированы между версиями:

✅ Content scripts:
- `content/auth-extractor.js` (только замена `chrome.*` на `browser.*`)
- `content/trade-fetcher.js` (только замена `chrome.*` на `browser.*`)

✅ Pop-up UI:
- `popup/popup.html`
- `popup/popup.css` 

⚠️ Pop-up JavaScript:
- `popup/popup.js` - требует замены `chrome.*` на `browser.*`

## Файлы отличаются

❌ `manifest.json`:
- **Chrome**: использует MV3, `"service_worker": "background/service-worker.js"`
- **Firefox**: использует обычный script `"scripts": ["background/background.js"]`

❌ Background скрипт:
- **Chrome**: `background/service-worker.js` (использует ES modules, async/await)
- **Firefox**: `background/background.js` (обычный скрипт, без ES modules)

## Стратегия синхронизации

### Для контент скриптов

Создайте при необходимости скрипт для автосинхронизации:

```bash
#!/bin/bash
# sync-content-to-firefox.sh

for file in auth-extractor.js trade-fetcher.js; do
  cp "plugins/chrome/content/$file" "plugins/firefox/content/$file"
  # Замена chrome.* на browser.*
  sed -i 's/chrome\./browser./g' "plugins/firefox/content/$file"
done
```

### Для popup UI

Content и CSS можно синхронизировать напрямую. JavaScript требует замены API:

```bash
#!/bin/bash
# sync-popup-to-firefox.sh

# HTML и CSS — без изменений
cp plugins/chrome/popup/popup.html plugins/firefox/popup/
cp plugins/chrome/popup/popup.css plugins/firefox/popup/

# JS — требует замены API
cp plugins/chrome/popup/popup.js plugins/firefox/popup/popup.js
sed -i 's/chrome\./browser./g' plugins/firefox/popup/popup.js
```

### Для background скрипта

Требует коплной переработки — нельзя синхронизировать автоматически.

## API отличия

### chrome.* vs browser.*

| Chrome | Firefox | Примечание |
|--------|---------|-----------|
| `chrome.runtime.sendMessage()` | `browser.runtime.sendMessage()` | Идентично функционально |
| `chrome.storage.session` | `browser.storage.session` | Используется в MV3 |
| `chrome.storage.local` | `browser.storage.local` | Поддерживается обеими |
| `chrome.webRequest` | ❌ Не поддерживается | Используйте `webRequest` в manifest |
| `chrome.action` | `browser.action` | Для popup и badge |
| `chrome.tabs` | `browser.tabs` | Управление вкладками |
| `chrome.scripting` | ❌ Не поддерживается | Используйте content scripts |

### ServiceWorker vs Background Script

| Chrome | Firefox | Решение |
|--------|---------|---------|
| ES modules: `import` | Обычные скрипты | Используйте `browser.runtime.getURL()` для ресурсов |
| Persistent storage | Per-session хранилище | Используйте `browser.storage.local` |
| WebSocket | WebSocket | Поддерживается обеими |
| Top-level await | await вне async | Оборните в async IIFE |

## Версионирование

### Chrome
```json
"version": "1.0.0"
```

### Firefox

```json
"version": "1.0.0",
"browser_specific_settings": {
  "gecko": {
    "id": "hash-hedge-diary@iskatel-ua.github.io",
    "strict_min_version": "109.0"
  }
}
```

Версия должна быть идентична для обеих версий для согласованности.

## Инструкция для разработки

1. **Делайте изменения в Chrome версии** как основной версии
2. **Тестируйте в Chrome** 
3. **Синхронизируйте меньшие части в Firefox**:
   - Content scripts (с заменой API)
   - Popup UI (с заменой API)
4. **Переработайте background** если необходимо для Firefox
5. **Тестируйте в Firefox** через `about:debugging`

## Проверка миграции

Используйте этот чек-лист при обновлении Firefox версии:

- [ ] `manifest.json` актуален
- [ ] Content scripts обновлены и используют `browser.*`
- [ ] Popup HTML и CSS идентичны Chrome
- [ ] Popup JS обновлен и использует `browser.*`
- [ ] Background script совместим с Firefox (no ES modules)
- [ ] Иконки и изображения скопированы
- [ ] Версия совпадает с Chrome
- [ ] Протестировано в Firefox 109+

## Полезные команды

```bash
# Проверить все использования chrome.*
grep -r "chrome\." plugins/firefox/

# Заменить все chrome.* на browser.*
find plugins/firefox -type f -name "*.js" -exec sed -i 's/chrome\./browser./g' {} \;

# Создать архив для публикации
zip -r hash-hedge-diary-firefox-1.0.0.xpi \
  plugins/firefox/manifest.json \
  plugins/firefox/background/ \
  plugins/firefox/content/ \
  plugins/firefox/popup/ \
  plugins/firefox/assets/
```
