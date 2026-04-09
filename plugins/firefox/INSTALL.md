# Установка Firefox расширения

## Быстрый старт

### 1. Подготовка
```bash
cd plugins/firefox
# Убедитесь что все иконки и изображения скопированы (уже сделано)
ls -la assets/icons/
ls -la assets/images/
```

### 2. Загрузка в Firefox (временно)

#### Способ 1: Через about:debugging
1. Откройте Firefox
2. Введите в адресной строке: `about:debugging`
3. Нажмите на вкладку "This Firefox" (должна быть слева)
4. Нажмите кнопку "Load Temporary Add-on"
5. Перейдите в папку `plugins/firebase/`
6. Выберите файл `manifest.json`
7. Нажмите "Open"

Расширение загрузится и будет доступно для тестирования. **Особенность**: при перезагрузке браузера временное расширение будет удалено.

#### Способ 2: Создание профиля для разработки
```bash
# Windows
"C:\Program Files\Mozilla Firefox\firefox.exe" -profile "dev-profile" -no-remote

# macOS
/Applications/Firefox.app/Contents/MacOS/firefox -profile ~/firefox-dev -no-remote

# Linux
firefox -profile ~/firefox-dev -no-remote
```

Затем повторите шаги 2-6 выше в новом профиле.

### 3. Тестирование

1. Перейдите на https://hashhedge.com
2. Авторизуйтесь
3. Откройте страницу истории торгов
4. Кликните на иконку расширения в верхнем правом углу
5. Должно открыться popup с метриками

## Отладка

### Просмотр логов background script
1. Откройте `about:debugging`
2. Найдите "Hash Hedge Diary" в списке расширений
3. Нажмите "Inspect"
4. Перейдите на вкладку "Console"
5. Вы увидите все логи из `background.js`

### Отладка popup
1. Правый клик на иконку расширения
2. Выберите "Inspect Popup"
3. Откроется devtools для popup окна

### Проверка сообщений между скриптами
В Console попробуйте:
```javascript
browser.runtime.sendMessage({ type: 'GET_AUTH' })
  .then(response => console.log('Response:', response))
  .catch(err => console.error('Error:', err));
```

## Сборка для публикации в Firefox Add-ons

### Требования:
- Подписанный XPI файл
- Privacy Policy
- Описание расширения

### Инструкции:
1. Создайте ZIP архив с содержимым папки:
   ```bash
   zip -r hash-hedge-diary.zip \
     manifest.json \
     background/ \
     content/ \
     popup/ \
     assets/
   ```

2. Переименуйте в `.xpi`:
   ```bash
   mv hash-hedge-diary.zip hash-hedge-diary.xpi
   ```

3. Загрузите на https://addons.mozilla.org/firefox/developers/

## Типичные проблемы

### "Does not have permission to communicate with this document"
**Решение**: Content scripts могут общаться с background только через `browser.runtime.*`

### "Cannot find browser object"
**Решение**: Убедитесь что используется `browser.*` а не `chrome.*`

### Token не сохраняется
**Решение**: 
- Очистите storage в `about:debugging` → expand → Storage
- Пересвежите страницу hashhedge.com
- Проверьте Console в background script

### Popup не открывается
1. Проверьте что `popup.html` указан правильно в manifest
2. Проверьте Console (F12) на ошибки JavaScript
3. Проверьте background script Console на ошибки

## Полезные ссылки

- [MDN WebExtensions API](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions)
- [Firefox about:debugging](about:debugging)
- [Firefox Add-ons Development Hub](https://addons.mozilla.org/firefox/developers/)
