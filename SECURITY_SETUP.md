# GitHub Actions Security Setup Guide

Это руководство поможет вам настроить автоматическую проверку безопасности через VirusTotal для расширения.

## Что было добавлено

### GitHub Actions Workflows

1. **`virustotal-scan.yml`** — автоматически сканирует расширение при каждом push/PR
   - Загружает архив расширения на VirusTotal
   - Ажидает результатов анализа
   - Добавляет комментарий в PR с результатами
   - Не позволяет merge, если найдены вредоносные сигнатуры

2. **`security-badges.yml`** — генерирует и обновляет SVG badges
   - Создает зелёный badge "passed" после успешной проверки
   - Коммитит badge в репозиторий

### Badges в README

- VirusTotal workflow status badge (синий/зелёный)
- Custom security check badge (зелёный)

## Настройка VirusTotal API

### Шаг 1: Создайте аккаунт VirusTotal

1. Перейдите на [virustotal.com](https://www.virustotal.com/)
2. Зарегистрируйтесь (бесплатно)
3. Подтвердите email

### Шаг 2: Получите API ключ

1. Войдите в аккаунт
2. Перейдите в **User settings** (иконка пользователя)
3. В разделе **API key** скопируйте ваш ключ
   - Он выглядит как длинная строка символов

### Шаг 3: Добавьте API ключ в GitHub

1. Перейдите в ваш репозиторий на GitHub
2. Откройте **Settings → Secrets and variables → Actions**
3. Нажмите **New repository secret**
4. Заполните:
   - **Name**: `VIRUSTOTAL_API_KEY`
   - **Secret**: Вставьте ваш API ключ из VirusTotal
5. Нажмите **Add secret**

### Шаг 4: Проверьте работу

1. Сделайте любой commit и push
2. Перейдите на вкладку **Actions** в репозитории
3. Вы должны увидеть запущенный workflow "VirusTotal Security Scan"
4. После завершения:
   - Проверьте результаты в логах
   - Посмотрите обновленный badge в README
   - Если это PR — посмотрите комментарий с результатами

## Как работает сканирование

```
commit/push
    ↓
GitHub Actions запускает workflow
    ↓
Создает архив расширения
    ↓
Загружает на VirusTotal
    ↓
Ожидает результатов анализа
    ↓
Проверяет результаты:
  - 0 malicious signatures ✅ → Push проходит
  - > 0 malicious signatures 🛑 → Workflow fails, merge блокируется
    ↓
Обновляет badge в репозитории
    ↓
Если PR — добавляет комментарий с результатами
```

## Обслуживание

### Обновление API ключа

Если вам нужно обновить ключ:

1. Перейдите в **Settings → Secrets and variables → Actions**
2. Нажмите на `VIRUSTOTAL_API_KEY`
3. Нажмите **Update secret**
4. Вставьте новый ключ

### Отключение сканирования (если необходимо)

Если вы хотите временно отключить сканирование:
- Удалите `VIRUSTOTAL_API_KEY` из Secrets
- Workflow продолжит работать, но пропустит сканирование и покажет warning

### Просмотр истории сканирований

1. Перейдите на вкладку **Actions**
2. Выберите **VirusTotal Security Scan**
3. Просмотрите историю запусков

## Что проверяется

Файлы, которые включены в сканирование:
- ✅ `plugins/chrome/background/` — Service Worker
- ✅ `plugins/chrome/content/` — Content Scripts
- ✅ `plugins/chrome/popup/` — UI файлы
- ✅ `plugins/chrome/src/` — Исходный код
- ✅ `plugins/chrome/manifest.json` — Конфигурация

Не сканируются (исключены):
- ❌ `.git/` — История Git
- ❌ `.github/` — Конфигурация GitHub
- ❌ `node_modules/` — Стороние пакеты
- ❌ `plugins/chrome/assets/images/demo.jpg` — Картинки

## Безопасность

- Ваш API ключ хранится **только в GitHub Secrets** и не видим публично
- Исходный код сканируется перед каждым merge
- Результаты доступны всем в логах Actions
- Ссылка на полный отчет VirusTotal публикуется в комментариях PR

## FAQ

### Почему сканирование заняло много времени?

VirusTotal может анализировать файл до 5-10 минут. Workflow ожидает до 1 минуты результатов, потом повторяет попытку.

### Что если VirusTotal API ключ не настроен?

Workflow будет пропущен с warning: `VirusTotal API key not configured. Skipping scan.` Это безопасно.

### Как поделиться результатами сканирования?

1. Откройте ссылку на иконке Status Badge на вкладке Actions
2. Oder используйте ссылку из комментария PR: `https://www.virustotal.com/gui/file/...`

### Можно ли сканировать локально перед push?

Да! Вы можете вручную загрузить ZIP архив расширения на [virustotal.com](https://www.virustotal.com/) и проверить результаты перед commit.

## Структура добавленных файлов

```
.github/
├── workflows/
│   ├── virustotal-scan.yml      ← Workflow сканирования
│   └── security-badges.yml      ← Workflow генерирования badges
└── badges/
    └── security-check.svg       ← SVG badge статуса
```

## Дополнительные ресурсы

- [VirusTotal API Docs](https://developers.virustotal.com/reference)
- [GitHub Actions Secrets](https://docs.github.com/en/actions/security-guides/encrypted-secrets)
- [GitHub Actions Documentation](https://docs.github.com/en/actions)
