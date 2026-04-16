import test from "node:test";
import assert from "node:assert/strict";

import { isWeeklyFollowUpDue } from "../src/chat-memory.ts";
import { parseQuantityValue } from "../src/order-service.ts";
import { processChatMessages } from "../src/chat-service.ts";
import { getCatalog } from "../src/database.ts";
import { buildSystemPrompt } from "../src/prompt.ts";
import { buildTelegramProductCaption } from "../src/telegram-bot.ts";

const catalog = await getCatalog();

function getProductPhoto(name, color) {
  const product = catalog.products.find((item) => {
    if (item?.name !== name) {
      return false;
    }

    if (!color) {
      return true;
    }

    return Array.isArray(item?.colors) && item.colors.includes(color);
  });

  assert.ok(product, `Product not found in catalog: ${name} ${color || ""}`.trim());
  assert.ok(product.photo, `Product has no photo: ${name} ${color || ""}`.trim());
  return product.photo;
}

function buildJacketRecommendationReply() {
  return [
    "Для изготовления куртки я могу предложить следующие варианты кожи:",
    "",
    "1. **Soft White-Black**:",
    " - Цвет: Черный",
    "",
    "2. **Zberba black**:",
    " - Цвет: Черный",
    "",
    "3. **Zberba Burgundy**:",
    " - Цвет: Бордовый"
  ].join("\n");
}

function buildBagRecommendationReply() {
  return [
    "Для изготовления сумки я могу предложить следующие варианты кожи:",
    "",
    "1. **Обувная кожа**:",
    " - Цвет: Коричневый",
    "",
    "2. **Обувная кожа**:",
    " - Цвет: Красный"
  ].join("\n");
}

async function withMockedSellerReply(reply, run) {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () =>
    ({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: reply
            }
          }
        ]
      })
    }) as Response) as typeof globalThis.fetch;

  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("sends all photos from the previous recommendation list", async () => {
  const result = await withMockedSellerReply("Ниже отправляю фото.", () =>
    processChatMessages({
      messages: [
        { role: "assistant", content: buildJacketRecommendationReply() },
        { role: "user", content: "пришли фотки" }
      ]
    })
  );

  assert.deepEqual(
    result.attachments.map((item) => item.url),
    [
      getProductPhoto("Soft White-Black", "Черный"),
      getProductPhoto("Zberba black", "Черный"),
      getProductPhoto("Zberba Burgundy", "Бордовый")
    ]
  );
});

test("treats 'все из списка' as a follow-up to the last photo request", async () => {
  const result = await withMockedSellerReply("Ниже отправляю фото.", () =>
    processChatMessages({
      messages: [
        { role: "assistant", content: buildJacketRecommendationReply() },
        { role: "user", content: "пришли фотки" },
        {
          role: "assistant",
          content: "Пожалуйста, уточните, какой именно вариант кожи вас интересует."
        },
        { role: "user", content: "все из списка" }
      ]
    })
  );

  assert.deepEqual(
    result.attachments.map((item) => item.url),
    [
      getProductPhoto("Soft White-Black", "Черный"),
      getProductPhoto("Zberba black", "Черный"),
      getProductPhoto("Zberba Burgundy", "Бордовый")
    ]
  );
});

test("returns the requested numbered option from the previous list", async () => {
  const result = await withMockedSellerReply("Ниже отправляю фото.", () =>
    processChatMessages({
      messages: [
        { role: "assistant", content: buildBagRecommendationReply() },
        { role: "user", content: "пришлите пожалуйста фотку 2 варианта" }
      ]
    })
  );

  assert.deepEqual(result.attachments.map((item) => item.url), [
    getProductPhoto("Обувная кожа", "Красный")
  ]);
});

test("returns the remaining option for 'другого варианта'", async () => {
  const result = await withMockedSellerReply("Ниже отправляю фото.", () =>
    processChatMessages({
      messages: [
        { role: "assistant", content: buildBagRecommendationReply() },
        { role: "user", content: "пришлите пожалуйста фотку 2 варианта" },
        { role: "assistant", content: "Ниже отправляю фото." },
        { role: "user", content: "а фотку другого варианта можно?" }
      ]
    })
  );

  assert.deepEqual(result.attachments.map((item) => item.url), [
    getProductPhoto("Обувная кожа", "Коричневый")
  ]);
});

test("matches the exact color when products share the same name", async () => {
  const result = await withMockedSellerReply("Ниже отправляю фото.", () =>
    processChatMessages({
      messages: [{ role: "user", content: "пришли фото Обувная кожа, коричневая" }]
    })
  );

  assert.deepEqual(result.attachments.map((item) => item.url), [
    getProductPhoto("Обувная кожа", "Коричневый")
  ]);
  assert.equal(result.attachments[0]?.price, "от ~284 руб. / фут2");
  assert.deepEqual(result.attachments[0]?.colors, ["Коричневый"]);
});

test("sanitizes refusal text when attachments are available", async () => {
  const result = await withMockedSellerReply(
    "К сожалению, я не могу прислать фотографии. Сейчас пришлю фото, пожалуйста, подождите.",
    () =>
      processChatMessages({
        messages: [
          { role: "assistant", content: buildJacketRecommendationReply() },
          { role: "user", content: "пришли фотки" }
        ]
      })
  );

  assert.equal(result.reply, "Ниже отправляю фото.");
  assert.equal(result.attachments.length, 3);
});

test("parses quantity values from free-form order text", () => {
  assert.equal(parseQuantityValue("нужно 2.5 м2"), 2.5);
  assert.equal(parseQuantityValue("3 штуки"), 3);
  assert.equal(parseQuantityValue("пока не знаю"), null);
});

test("detects when weekly follow-up is due", () => {
  const now = Date.parse("2026-04-16T12:00:00.000Z");

  assert.equal(
    isWeeklyFollowUpDue("2026-04-07T10:00:00.000Z", "", now),
    true
  );
  assert.equal(
    isWeeklyFollowUpDue("2026-04-12T10:00:00.000Z", "", now),
    false
  );
  assert.equal(
    isWeeklyFollowUpDue("2026-04-07T10:00:00.000Z", "2026-04-08T10:00:00.000Z", now),
    false
  );
  assert.equal(
    isWeeklyFollowUpDue("2026-04-07T10:00:00.000Z", "2026-04-10T10:00:00.000Z", now),
    false
  );
});

test("builds telegram product card caption with price and parameters", () => {
  const caption = buildTelegramProductCaption({
    type: "image",
    url: "https://example.com/photo.jpg",
    name: "Обувная кожа",
    price: "от ~284 руб. / фут2",
    category: "Обувная",
    colors: ["Коричневый"],
    applications: ["Галантерейная"],
    thickness: "1.1 мм",
    materialType: "Овчина",
    stock: "уточнять у менеджера"
  });

  assert.ok(/Обувная кожа/.test(caption));
  assert.ok(/Цена: от ~284 руб\. \/ фут2/.test(caption));
  assert.ok(/Цвет: Коричневый/.test(caption));
  assert.ok(/Назначение: Галантерейная/.test(caption));
  assert.ok(!/Если хотите, посчитаю полную стоимость/.test(caption));
});

test("system prompt guides bag consultations away from generic eco-leather theory", () => {
  const prompt = buildSystemPrompt(
    {
      name: "Test Company",
      city: "Moscow",
      delivery: "По РФ"
    },
    ""
  );

  assert.ok(/не начинай ответ с общей теории вроде "натуральная кожа или экокожа"/.test(prompt));
  assert.ok(/не предлагай экокожу, искусственную кожу или другие типы материалов, если их нет/.test(prompt));
  assert.ok(/если запрос про сумку, рюкзак, кошелек или другую галантерею, по умолчанию ориентируй клиента на галантерейную кожу/.test(prompt));
});
