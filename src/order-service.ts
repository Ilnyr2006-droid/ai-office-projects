import { getChatMessages } from "./chat-memory.ts";
import type { CatalogProduct, LeadRecord, OrderSession, TelegramUser } from "./chat-types.ts";
import { saveLead, searchCatalog } from "./database.ts";
import { clearOrderSession, getOrderSession, saveOrderSession } from "./order-memory.ts";
import { sendLeadToTelegram } from "./telegram.ts";
import { registerTelegramLeadThread } from "./telegram-relay-memory.ts";

const ORDER_CANCEL_RE = /^(\/cancel|отмена|отменить|стоп|хватит)$/i;
const ORDER_START_RE = /^\/order(?:\s|$)/i;
const ORDER_CONFIRM_RE = /^(\/confirm|подтверждаю|подтвердить|да|давай|оформляй|оформить)$/i;
const ORDER_EDIT_RE = /^(\/edit|изменить|исправить|другое|неверно|нет)$/i;
const NON_PRODUCT_ORDER_TOPIC_RE =
  /(^|\s)(доставк|оплат|самовывоз|срок|адрес|контакт|телефон|менеджер|консультац|образец|образцы)(\s|$|\?)/i;
const PHONE_RE = /(?:\+?\d[\d\s()\-]{7,}\d)/;
const GENERIC_INTEREST_RE =
  /^(его|ее|её|их|это|этот|эту|этого|этой|такой|такую|товар|позицию|вариант)(?:\s+товар)?$/i;

export async function handleTelegramOrderFlow({
  chatId,
  text,
  telegramUser
}: {
  chatId: string;
  text: string;
  telegramUser?: TelegramUser;
}): Promise<{ handled: true; reply: string } | null> {
  const normalizedChatId = String(chatId || "").trim();
  const normalizedText = String(text || "").trim();

  if (!normalizedChatId || !normalizedText) {
    return null;
  }

  if (ORDER_CANCEL_RE.test(normalizedText)) {
    const hadSession = await clearOrderSession(normalizedChatId);

    if (!hadSession) {
      return null;
    }

    return {
      handled: true,
      reply:
        "Оформление заказа отменено. Если захотите вернуться, напишите /order или просто скажите, что хотите оформить заказ."
    };
  }

  const existingSession = await getOrderSession(normalizedChatId);

  if (existingSession) {
    return continueOrderFlow({
      chatId: normalizedChatId,
      text: normalizedText,
      telegramUser,
      session: existingSession
    });
  }

  if (!ORDER_START_RE.test(normalizedText)) {
    return null;
  }

  if (looksLikeNonProductOrderRequest(normalizedText)) {
    return null;
  }

  const session = createEmptySession();
  const seedInterest = await resolveOrderInterest(normalizedChatId, normalizedText);

  if (seedInterest) {
    session.interest = seedInterest;
  }

  await saveOrderSession(normalizedChatId, session);

  if (!session.interest) {
    return {
      handled: true,
      reply:
        "Помогу оформить заказ. Напишите, какой товар нужен: название кожи, цвет, толщину или назначение."
    };
  }

  return {
    handled: true,
    reply: [
      `Оформляем заказ. Товар: ${session.interest}.`,
      "Напишите количество, метраж или короткий комментарий по заказу."
    ].join("\n")
  };
}

async function continueOrderFlow({
  chatId,
  text,
  telegramUser,
  session
}: {
  chatId: string;
  text: string;
  telegramUser?: TelegramUser;
  session: OrderSession;
}): Promise<{ handled: true; reply: string } | null> {
  const nextSession = normalizeSession(session);

  if (!nextSession.interest) {
    nextSession.interest = text;
    await saveOrderSession(chatId, nextSession);
    return {
      handled: true,
      reply: "Принял. Теперь напишите количество, метраж или короткий комментарий по заказу."
    };
  }

  if (!nextSession.quantity) {
    nextSession.quantity = text;
    hydrateOrderPricing(nextSession, await lookupCatalogProduct(nextSession.interest));
    await saveOrderSession(chatId, nextSession);
    return {
      handled: true,
      reply: buildOrderSummaryReply(nextSession)
    };
  }

  if (nextSession.awaitingConfirmation) {
    if (ORDER_EDIT_RE.test(text)) {
      nextSession.quantity = "";
      nextSession.totalPriceValue = null;
      nextSession.totalPriceLabel = "";
      nextSession.awaitingConfirmation = false;
      await saveOrderSession(chatId, nextSession);
      return {
        handled: true,
        reply: "Хорошо, давайте поправим заказ. Напишите количество, метраж или комментарий заново."
      };
    }

    if (!ORDER_CONFIRM_RE.test(text)) {
      return {
        handled: true,
        reply: "Если все верно, напишите `подтвердить`. Если хотите изменить количество или товар, напишите `изменить`."
      };
    }

    nextSession.awaitingConfirmation = false;
    await saveOrderSession(chatId, nextSession);
    return {
      handled: true,
      reply: "Отлично. Как к вам обращаться? Напишите имя."
    };
  }

  if (!nextSession.name) {
    nextSession.name = text;
    await saveOrderSession(chatId, nextSession);
    return {
      handled: true,
      reply: "Оставьте телефон или Telegram для связи."
    };
  }

  if (!nextSession.contact) {
    nextSession.contact = text;
    const lead = await submitOrder(chatId, nextSession, telegramUser);
    await clearOrderSession(chatId);
    return {
      handled: true,
      reply: buildSuccessReply(lead)
    };
  }

  return null;
}

async function submitOrder(
  chatId: string,
  session: OrderSession,
  telegramUser?: TelegramUser
): Promise<LeadRecord> {
  const transcript = await buildTranscript(chatId);
  const contactValue = String(session.contact || "").trim();
  const phone = extractPhone(contactValue);
  const telegramContact = buildTelegramContact(telegramUser, chatId, contactValue, phone);
  const notes = [
    session.quantity ? `Количество/детали: ${session.quantity}` : "",
    session.unitPriceLabel ? `Цена за единицу: ${session.unitPriceLabel}` : "",
    session.totalPriceLabel ? `Итого: ${session.totalPriceLabel}` : "",
    Array.isArray(session.suggestedAddons) && session.suggestedAddons.length
      ? `Можно предложить дополнительно: ${session.suggestedAddons.join(", ")}`
      : "",
    telegramContact ? `Telegram: ${telegramContact}` : ""
  ]
    .filter(Boolean)
    .join("\n");

  const lead = await saveLead({
    name: String(session.name || "").trim(),
    phone,
    contact: phone ? telegramContact || contactValue : contactValue || telegramContact,
    interest: String(session.interest || "").trim(),
    notes,
    transcript,
    source: "Telegram bot order"
  });

  const telegramResponse = await sendLeadToTelegram(lead, {
    clientChatId: chatId,
    telegramUser
  });
  const leadMessage = telegramResponse?.result;

  if (leadMessage?.chat?.id && leadMessage?.message_id) {
    await registerTelegramLeadThread({
      lead,
      clientChatId: chatId,
      groupChatId: leadMessage.chat.id,
      groupMessageId: leadMessage.message_id,
      telegramUser
    });
  }

  return lead;
}

async function buildTranscript(chatId: string): Promise<string> {
  const messages = await getChatMessages(`telegram:${chatId}`);

  return messages
    .slice(-12)
    .map((message) => `${message.role === "assistant" ? "Менеджер-бот" : "Клиент"}: ${message.content}`)
    .join("\n");
}

function buildSuccessReply(lead: LeadRecord): string {
  const contactHint =
    lead.phone || lead.contact ? "Менеджер свяжется с вами по оставленному контакту." : "";
  return ["Заказ принят и отправлен менеджеру.", contactHint].filter(Boolean).join(" ");
}

function buildTelegramContact(
  telegramUser: TelegramUser | undefined,
  chatId: string,
  fallbackContact: string,
  phone: string
): string {
  const username = String(telegramUser?.username || "").trim();
  const fullName = [telegramUser?.first_name, telegramUser?.last_name]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(" ");
  const parts = [username ? `@${username}` : "", fullName, `chat_id=${chatId}`].filter(Boolean);
  const preferred = parts.join(", ");

  if (phone) {
    return preferred || "";
  }

  const fallback = String(fallbackContact || "").trim();
  return [fallback && fallback !== preferred ? fallback : "", preferred].filter(Boolean).join(", ");
}

function extractInterestFromStart(text: string): string {
  const normalized = String(text || "").trim();
  const cleaned = normalized
    .replace(ORDER_START_RE, " ")
    .replace(/(^|\s)(пожалуйста|плиз|pls)(?=\s|$)/gi, " ")
    .replace(/(^|\s)(у\s+вас(?:\s+есть)?|у\s+тебя(?:\s+есть)?)(?=\s|$)/gi, " ")
    .replace(/(^|\s)(можно|хочу|нужно|надо)(?=\s|$)/gi, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
    .trim();

  return cleaned && cleaned.length >= 3 ? cleaned : "";
}

async function resolveOrderInterest(chatId: string, text: string): Promise<string> {
  const directInterest = extractInterestFromStart(text);

  if (directInterest && !isGenericInterest(directInterest)) {
    return directInterest;
  }

  const contextualInterest = await inferInterestFromRecentMessages(chatId);

  if (contextualInterest) {
    return contextualInterest;
  }

  return isGenericInterest(directInterest) ? "" : directInterest;
}

async function inferInterestFromRecentMessages(chatId: string): Promise<string> {
  const messages = await getChatMessages(`telegram:${chatId}`);
  const recentMessages = [...messages].reverse().slice(0, 8);

  for (const message of recentMessages) {
    const productName = await findExplicitProductName(message.content);

    if (productName) {
      return productName;
    }
  }

  return "";
}

async function findExplicitProductName(text: string): Promise<string> {
  const normalizedText = String(text || "").trim();

  if (!normalizedText || normalizedText.length < 3) {
    return "";
  }

  const results = await searchCatalog(normalizedText, 5);
  const haystack = normalizeSearchText(normalizedText);

  for (const product of Array.isArray(results?.products) ? results.products : []) {
    const productName = String(product?.name || "").trim();

    if (productName && haystack.includes(normalizeSearchText(productName))) {
      return productName;
    }
  }

  return "";
}

function isGenericInterest(value: string): boolean {
  const normalized = normalizeSearchText(value).replace(/\s+товар$/, "").trim();
  return !normalized || GENERIC_INTEREST_RE.test(normalized) || looksLikeNonProductOrderRequest(normalized);
}

function looksLikeNonProductOrderRequest(value: string): boolean {
  const normalized = normalizeSearchText(value);

  if (!normalized) {
    return false;
  }

  if (!NON_PRODUCT_ORDER_TOPIC_RE.test(normalized)) {
    return false;
  }

  return !/(^|\s)(кожа|кожи|товар|материал|замша|шкура|овчина|краст|куртк|сумк|ремень|обув|мебел)(\s|$)/i.test(
    normalized
  );
}

function normalizeSearchText(value: string): string {
  return String(value || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractPhone(value: string): string {
  const match = String(value || "").match(PHONE_RE);
  return match ? match[0].replace(/\s+/g, " ").trim() : "";
}

function createEmptySession(): OrderSession {
  return {
    interest: "",
    quantity: "",
    name: "",
    contact: "",
    productName: "",
    unitPriceValue: null,
    unitPriceLabel: "",
    totalPriceValue: null,
    totalPriceLabel: "",
    suggestedAddons: [],
    awaitingConfirmation: false
  };
}

function normalizeSession(session: Partial<OrderSession> | null | undefined): OrderSession {
  return {
    interest: String(session?.interest || "").trim(),
    quantity: String(session?.quantity || "").trim(),
    name: String(session?.name || "").trim(),
    contact: String(session?.contact || "").trim(),
    productName: String(session?.productName || "").trim(),
    unitPriceValue: Number.isFinite(Number(session?.unitPriceValue)) ? Number(session?.unitPriceValue) : null,
    unitPriceLabel: String(session?.unitPriceLabel || "").trim(),
    totalPriceValue: Number.isFinite(Number(session?.totalPriceValue)) ? Number(session?.totalPriceValue) : null,
    totalPriceLabel: String(session?.totalPriceLabel || "").trim(),
    suggestedAddons: Array.isArray(session?.suggestedAddons)
      ? session.suggestedAddons.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 2)
      : [],
    awaitingConfirmation: Boolean(session?.awaitingConfirmation)
  };
}

async function lookupCatalogProduct(interest: string): Promise<CatalogProduct | null> {
  const normalizedInterest = String(interest || "").trim();

  if (!normalizedInterest) {
    return null;
  }

  const results = await searchCatalog(normalizedInterest, 6);
  const products = Array.isArray(results?.products) ? results.products : [];
  const normalizedNeedle = normalizeSearchText(normalizedInterest);

  const exactMatch =
    products.find((product) => normalizeSearchText(String(product?.name || "")) === normalizedNeedle) ||
    products.find((product) => normalizedNeedle.includes(normalizeSearchText(String(product?.name || ""))));

  return exactMatch || products[0] || null;
}

function hydrateOrderPricing(session: OrderSession, product: CatalogProduct | null): void {
  const pricing = getProductPricing(product);
  const quantityValue = parseQuantityValue(session.quantity);
  const addons = getSuggestedAddons(product);

  if (product?.name) {
    session.productName = String(product.name).trim();
  }

  session.unitPriceValue = pricing.value;
  session.unitPriceLabel = pricing.label;
  session.suggestedAddons = addons;

  if (pricing.value && quantityValue) {
    session.totalPriceValue = roundPrice(pricing.value * quantityValue);
    session.totalPriceLabel = formatMoney(session.totalPriceValue, pricing.currency, pricing.unit, quantityValue);
  } else {
    session.totalPriceValue = null;
    session.totalPriceLabel = "";
  }

  session.awaitingConfirmation = true;
}

function buildOrderSummaryReply(session: OrderSession): string {
  const title = session.productName || session.interest;
  const lines = [
    "Собрал заказ.",
    title ? `Товар: ${title}` : "",
    session.quantity ? `Количество: ${session.quantity}` : "",
    session.unitPriceLabel ? `Цена за единицу: ${session.unitPriceLabel}` : "",
    session.totalPriceLabel
      ? `Ориентировочная полная стоимость: ${session.totalPriceLabel}`
      : "Полную стоимость пока точно не считаю: не хватает точной цены за единицу или корректного количества."
  ];

  if (Array.isArray(session.suggestedAddons) && session.suggestedAddons.length) {
    lines.push(`К заказу могу сразу предложить: ${session.suggestedAddons.join(", ")}.`);
  }

  lines.push("Если все верно, напишите `подтвердить`. Если нужно изменить количество или товар, напишите `изменить`.");
  return lines.filter(Boolean).join("\n");
}

export function parseQuantityValue(value: string): number | null {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(",", ".")
    .trim();
  const match = normalized.match(/(\d+(?:\.\d+)?)/);

  if (!match) {
    return null;
  }

  const amount = Number(match[1]);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function getProductPricing(product: CatalogProduct | null): {
  value: number | null;
  currency: string;
  unit: string;
  label: string;
} {
  const pricing = product?.pricing || null;
  const value = Number(pricing?.from ?? product?.priceFromValue);
  const currency = normalizeCurrency(String(pricing?.currency || ""));
  const unit = String(pricing?.unit || product?.unit || "").trim();
  const approximate = Boolean(pricing?.approximate);
  const label =
    Number.isFinite(value) && value > 0
      ? `${approximate ? "~" : ""}${formatMoney(value, currency, unit)}`
      : String(pricing?.fromText || product?.priceFrom || "").trim();

  return {
    value: Number.isFinite(value) && value > 0 ? value : null,
    currency,
    unit,
    label
  };
}

function getSuggestedAddons(product: CatalogProduct | null): string[] {
  const variants = Array.isArray((product as { variants?: Array<{ title?: unknown }> } | null)?.variants)
    ? ((product as { variants?: Array<{ title?: unknown }> }).variants || [])
        .map((item) => String(item?.title || "").trim())
        .filter(Boolean)
        .slice(0, 2)
    : [];

  if (variants.length > 0) {
    return variants;
  }

  const category = String(product?.category || "").trim();
  return category ? [`другой вариант из категории ${category}`] : [];
}

function normalizeCurrency(currency: string): string {
  const normalized = String(currency || "").trim().toUpperCase();

  if (normalized === "RUB" || normalized === "RUR" || normalized === "₽" || normalized === "РУБ") {
    return "RUB";
  }

  return normalized;
}

function formatMoney(value: number, currency = "RUB", unit = "", quantity?: number): string {
  const amount = Number.isInteger(value) ? String(value) : value.toFixed(2);
  const suffix = unit ? ` / ${unit}` : "";
  const quantitySuffix = Number.isFinite(quantity) ? ` за ${quantity} ${unit || "ед."}` : "";
  const money = normalizeCurrency(currency) === "RUB" || !currency ? `${amount} руб.` : `${amount} ${currency}`;
  return `${money}${suffix}${quantitySuffix}`.trim();
}

function roundPrice(value: number): number {
  return Math.round(value * 100) / 100;
}
