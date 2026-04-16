# AI Seller for Tilda

Backend для сайта на Tilda с двумя задачами:

- отвечать клиенту через `gpt-4o-mini`;
- отправлять заявки в Telegram.
- отвечать клиентам прямо в Telegram-боте с отдельной памятью на каждый чат.
- брать данные о товарах из экспорта Tilda Excel и FAQ из локальной JSON-БД.

## Что делает

- `POST /api/chat` принимает историю сообщений и возвращает ответ ИИ-продавца.
- `POST /api/lead` принимает контакт клиента и пересылает заявку в Telegram.
- `POST /api/tilda/lead` принимает обычную форму Tilda и тоже пересылает заявку в Telegram.
- `GET /api/leads` возвращает сохранённые заявки из локальной БД.
- `GET /health` нужен для проверки, что сервер запущен.
- если задан `TELEGRAM_CHAT_BOT_TOKEN`, сервер сам запускает Telegram long polling и отвечает пользователям бота.

## Быстрый старт

```bash
npm install
cp .env.example .env
npm run dev
```

Заполни в `.env`:

- `OPENAI_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `TELEGRAM_CHAT_BOT_TOKEN`
- `ALLOWED_ORIGINS`

База знаний лежит в `data/knowledge-base.json`.
Каталог товаров можно импортировать из Excel Tilda в `data/catalog.json`.
Если задан `OPENAI_API_KEY`, после импорта автоматически пересобирается `data/catalog-embeddings.json`.
Заявки сохраняются в `data/leads.json`.

Импорт каталога:

```bash
npm run import:catalog
```

Только импорт без пересборки embeddings:

```bash
npm run import:catalog:only
```

Синхронизация актуальных цен с сайта `ozelifkoja.ru` в уже импортированный каталог:

```bash
npm run sync:prices
```

Проверка без записи в `data/catalog.json`:

```bash
npm run sync:prices -- --dry-run
```

Можно ограничить выборку:

```bash
npm run sync:prices -- --match suede --limit 10
```

Если сайт отдаёт только цены не в рублях, можно включить пересчёт по фиксированному курсу:

```bash
USD_TO_RUB_RATE=95 npm run sync:prices
```

Или для проверки без записи:

```bash
USD_TO_RUB_RATE=95 npm run sync:prices -- --dry-run --match "Vip Black"
```

По умолчанию скрипт берёт файл `store-11012911-202604121317.xlsx` из корня проекта.
Синк цен проходит по `product.url` из `data/catalog.json`, обновляет `priceFrom` и цены вариантов, затем при наличии `OPENAI_API_KEY` пересобирает embeddings. Если задан `USD_TO_RUB_RATE` или `--usd-to-rub`, все цены без `RUB` будут конвертированы в рубли и помечены как ориентировочные через `~`.

## Формат API

### 1. Чат

`POST /api/chat`

```json
{
  "messages": [
    { "role": "user", "content": "Здравствуйте, нужна кожа для сумок" },
    { "role": "assistant", "content": "Подскажите, пожалуйста, какой цвет и объём вас интересуют?" },
    { "role": "user", "content": "Черная, 20 метров" }
  ]
}
```

Ответ:

```json
{
  "reply": "Для сумок подойдёт кожа средней плотности. Уточните, пожалуйста, нужна гладкая или фактурная поверхность, и какой бюджет вы рассматриваете?"
}
```

### 2. Заявка

`POST /api/lead`

```json
{
  "name": "Иван",
  "phone": "+79990000000",
  "contact": "@ivan",
  "interest": "Черная кожа для сумок, 20 метров",
  "notes": "Нужна цена и сроки",
  "transcript": "Клиент: Нужна кожа для сумок\nИИ: Уточните цвет\nКлиент: Черная, 20 метров",
  "source": "Tilda chat widget"
}
```

После отправки заявка:

- уходит в Telegram;
- сохраняется локально в `data/leads.json`.

### 3. Обычная форма Tilda

`POST /api/tilda/lead`

Tilda может отправлять туда `application/x-www-form-urlencoded`.

Подойдут поля:

- `name` или `Name`
- `phone` или `Phone`
- `email`
- `telegram`
- `message`
- `product`

Ответ сервера для Tilda: `ok`

### 4. Просмотр сохранённых заявок

`GET /api/leads`

Ответ:

```json
{
  "leads": [
    {
      "id": "uuid",
      "createdAt": "2026-04-12T10:00:00.000Z",
      "name": "Иван",
      "phone": "+79990000000"
    }
  ]
}
```

## Как заполнять БД

Открой `data/knowledge-base.json` и меняй:

- `company` для данных компании;
- `products` как резервный каталог, если импорт из Excel ещё не сделан;
- `faq` для типовых вопросов;
- `salesNotes` для правил продаж.

Если рядом есть `data/catalog.json`, `/api/chat` будет брать товары оттуда и подбирать релевантные позиции по запросу клиента.

## Подключение к Tilda

Вариант для кастомного JS на странице:

1. Храни историю сообщений на стороне виджета.
2. При сообщении пользователя отправляй `fetch` на `/api/chat`.
3. Когда клиент оставил телефон или нажал кнопку заявки, отправляй `fetch` на `/api/lead`.

Пример JS:

```html
<script>
  const API_URL = "https://your-domain.com";
  const messages = [];

  async function askSeller(text) {
    messages.push({ role: "user", content: text });

    const response = await fetch(`${API_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages })
    });

    const data = await response.json();
    messages.push({ role: "assistant", content: data.reply });
    return data.reply;
  }

  async function sendLead(payload) {
    const transcript = messages
      .map((item) => `${item.role === "user" ? "Клиент" : "ИИ"}: ${item.content}`)
      .join("\n");

    return fetch(`${API_URL}/api/lead`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...payload,
        transcript,
        source: "Tilda"
      })
    });
  }
</script>
```

Если нужна обычная форма Tilda без кастомного фронтенда:

1. Открой форму в Tilda.
2. Добавь отправку в `Webhook`.
3. Укажи URL `https://your-domain.com/api/tilda/lead`.
4. Передай в форме хотя бы телефон или email/telegram.

Тогда каждая заявка из формы будет уходить в Telegram автоматически.

## Telegram chat ID

Чтобы узнать `TELEGRAM_CHAT_ID`, можно:

1. создать бота через `@BotFather`;
2. написать этому боту любое сообщение;
3. открыть:

```text
https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getUpdates
```

4. взять `message.chat.id`.

## Telegram-бот для диалогов

Если в `.env` задан `TELEGRAM_CHAT_BOT_TOKEN`, при `npm run dev` или `npm start` сервер автоматически начинает слушать сообщения боту через long polling.

Что поддерживается:

- обычный текстовый диалог с тем же ИИ-продавцом, что и в `/api/chat`;
- отдельная память на каждый Telegram-чат;
- команда `/reset` для очистки памяти текущего диалога;
- команда `/start` с короткой инструкцией.

Пример:

1. Создай бота через `@BotFather`.
2. Подставь токен в `TELEGRAM_CHAT_BOT_TOKEN`.
3. Запусти сервер: `npm run dev`.
4. Напиши боту в Telegram: `Нужна черная кожа для сумки`.

## Что дальше

Обычно следующий шаг:

1. развернуть backend на сервере;
2. подключить его домен в Tilda;
3. передать Gemini этот README и endpoint'ы `/api/chat`, `/api/lead`, `/api/tilda/lead`.
