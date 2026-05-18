# AdFlow AI — MVP

Figma-плагин для семантического анализа рекламных макетов через GPT-5/5.5.
Это **минимальный MVP** для проверки концепции: фокус на этапе **Analyze** (анализ слоёв + структурные замечания). Полный функционал из ТЗ (Generate, 7 шаблонов, constraint solver, 10 ratio presets, Export) добавляется поверх этой базы.

## Что уже работает

- 🎨 Стильный UI плагина (тёмная тема, анимации, glassmorphism)
- 🧠 Отправка скриншота + дерева слоёв на GPT-5 vision
- 📋 Распознавание ролей: headline / subtitle / cta / logo / hero / product / decorative / …
- 🚨 Подсветка структурных проблем: no_cta, hierarchy_unclear, logo_too_small, …
- ⚡ Кнопка «Применить N имён» — переименовывает слои в Figma по `suggested_name`
- 🎯 Клик по слою в UI → фокус и зум на этом узле в Figma

---

## Шаг 1 — деплой backend на Vercel

### 1.1. Залей проект на GitHub
```bash
git init
git add .
git commit -m "AdFlow AI MVP"
git remote add origin https://github.com/<твой_логин>/adflow-ai.git
git push -u origin main
```

### 1.2. Подключи репо к Vercel
1. Зайди на https://vercel.com → **New Project** → импортируй репо.
2. Framework Preset: **Other** (Vercel сам подхватит `api/*.ts` как Serverless Functions).
3. Build / Output / Install commands оставь пустыми — для backend ничего не нужно.

### 1.3. Добавь environment variables

В **Project Settings → Environment Variables** на Vercel создай:

| Имя переменной | Значение | Обязательно? |
|---|---|---|
| `OPENAI_API_KEY` | `sk-...` ключ из https://platform.openai.com/api-keys | ✅ да |
| `OPENAI_MODEL` | `gpt-5` (или `gpt-5.5` когда выйдет; по умолчанию `gpt-5`) | опционально |
| `ALLOWED_ORIGINS` | `null,https://www.figma.com,https://figma.com` | опционально |

⚠️ **Никакой Figma токен здесь не нужен** — плагин Figma работает изнутри Figma через Plugin API, REST-токен ему не требуется.

### 1.4. Деплой
Push в `main` → Vercel автоматически деплоит. Получишь URL вида `https://adflow-ai-xxxx.vercel.app`.

Проверка:
```bash
curl -X POST https://adflow-ai-xxxx.vercel.app/api/analyze \
  -H "Content-Type: application/json" \
  -d '{"layoutJson":{},"screenshotBase64":""}'
```
Должно вернуться `400 Missing layoutJson...` — значит endpoint жив.

---

## Шаг 2 — подключение плагина к backend

Открой **`ui.html`** и поменяй URL backend:
```js
const BACKEND_URL = 'https://adflow-ai-xxxx.vercel.app';
```
на свой реальный Vercel URL.

Также в **`manifest.json`** поле `networkAccess.allowedDomains` уже стоит `["https://*.vercel.app"]` — этого достаточно, можно ничего не менять. Но для прод-версии лучше указать точный домен.

---

## Шаг 3 — установка плагина в Figma

### 3.1. Собери плагин
```bash
npm install
npm run build
```
Появится файл `code.js` рядом с `manifest.json`.

### 3.2. Импортируй в Figma desktop
1. Открой Figma desktop.
2. Меню → **Plugins** → **Development** → **Import plugin from manifest…**
3. Выбери `manifest.json` из этого репо.

### 3.3. Запуск
1. В Figma выдели любой Frame (например рекламный баннер).
2. **Plugins → Development → AdFlow AI**.
3. Нажми **«Анализировать через GPT-5.5»**.
4. Через ~10-20 секунд увидишь:
   - AI-резюме макета,
   - список слоёв с распознанными ролями (цветные бейджи + confidence dots),
   - список структурных замечаний.
5. Кликни **«Применить N имён»** → слои в Figma переименуются.

---

## Структура проекта

```
adflow-ai/
├── manifest.json         # Figma plugin manifest
├── code.ts               # main thread (Figma sandbox) — парсит frame, делает скриншот
├── code.js               # ← собирается из code.ts через `npm run build`
├── ui.html               # UI плагина (CSS + JS внутри)
├── api/
│   └── analyze.ts        # Vercel serverless: вызов OpenAI Responses API
├── build.mjs             # esbuild для сборки code.ts → code.js
├── package.json
├── tsconfig.json
└── vercel.json
```

---

## Что добавить дальше (по ТЗ)

В порядке приоритета:

1. **Generate endpoint** (`api/generate.ts`) — на основе semantic map выбирает template_id + tweaks.
2. **7 templates** в `/solver/templates/` — функции которые из semantic + ratio + tweaks возвращают список узлов с координатами.
3. **10 ratio presets** + **constraint solver** (safe zone, overlap, text fit).
4. **Создание фреймов в Figma** — `figma.createFrame()` + `loadFontAsync` для каждой вариации.
5. **Export All** с упаковкой в zip через JSZip.

База для всего этого уже есть: `parseNode()` в `code.ts` отдаёт `LayoutJSON` точно по схеме из ТЗ.

---

## Troubleshooting

**«Backend 502: OpenAI API error»**
- Проверь что `OPENAI_API_KEY` в Vercel валидный и имеет доступ к указанной модели.
- Если используешь модель которой ещё нет в твоём аккаунте (например `gpt-5.5`) — поменяй `OPENAI_MODEL` на доступную (`gpt-5`, `gpt-4o`).

**«Слишком много слоёв: NNN»**
- В MVP лимит 300 узлов. Для бóльших макетов нужна оптимизация дерева на стороне `code.ts`.

**Плагин не видит backend**
- Проверь что URL в `ui.html` совпадает с реальным Vercel URL.
- Проверь что `manifest.json → networkAccess.allowedDomains` покрывает домен.

**OpenAI Responses API недоступен**
- Если в твоём регионе/аккаунте `/v1/responses` не работает, замени в `api/analyze.ts` на стандартный `/v1/chat/completions` с `response_format: { type: 'json_object' }` (потребует небольшой рефакторинг payload).
