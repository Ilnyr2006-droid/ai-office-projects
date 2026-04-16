import { config } from "./config.ts";
import type { LeadRecord, TelegramApiMessageResult, TelegramLeadOptions } from "./chat-types.ts";
import { getManagerGroupChatId } from "./telegram-relay-memory.ts";

function escapeHtml(value: unknown): string {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export async function sendLeadToTelegram(
  lead: LeadRecord,
  options: TelegramLeadOptions = {}
): Promise<{ result?: TelegramApiMessageResult }> {
  const chatId = await resolveLeadTargetChatId(options);
  const token = resolveTelegramToken();

  if (!token) {
    throw new Error("Telegram bot token is not configured");
  }

  if (!chatId) {
    throw new Error("Telegram target chat id is not configured");
  }

  const clientInstructions = buildClientInstructions(options);
  const lines = [
    "<b>Новая заявка</b>",
    "",
    `<b>ID заявки:</b> ${escapeHtml(lead.id || "Не указан")}`,
    `<b>Имя:</b> ${escapeHtml(lead.name || "Не указано")}`,
    `<b>Телефон:</b> ${escapeHtml(lead.phone || "Не указан")}`,
    `<b>Контакт:</b> ${escapeHtml(lead.contact || "Не указан")}`,
    `<b>Интерес:</b> ${escapeHtml(lead.interest || "Не указан")}`,
    `<b>Источник:</b> ${escapeHtml(lead.source || "Tilda")}`
  ];

  if (lead.notes) {
    lines.push(`<b>Комментарий:</b> ${escapeHtml(lead.notes)}`);
  }

  if (lead.transcript) {
    lines.push("");
    lines.push("<b>Диалог:</b>");
    lines.push(escapeHtml(lead.transcript));
  }

  if (clientInstructions) {
    lines.push("");
    lines.push(clientInstructions);
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      chat_id: chatId,
      text: lines.join("\n"),
      parse_mode: "HTML"
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Telegram API error ${response.status}: ${errorText}`);
  }

  return (await response.json()) as { result?: TelegramApiMessageResult };
}

function buildClientInstructions(options: TelegramLeadOptions): string {
  const clientChatId = String(options?.clientChatId || "").trim();

  if (!clientChatId) {
    return "";
  }

  const username = String(options?.telegramUser?.username || "").trim();

  return [
    "<b>Работа с клиентом через бота:</b>",
    `- ответьте на это сообщение текстом вида <code>клиенту: Уточните, пожалуйста, цвет</code>, и бот отправит вопрос клиенту;`,
    "- ответьте на это сообщение вопросом со знаком <code>?</code>, и бот кратко ответит по диалогу клиента;",
    `<b>Чат клиента:</b> ${escapeHtml(username ? `@${username}, ` : "")}${escapeHtml(`chat_id=${clientChatId}`)}`
  ].join("\n");
}

function resolveTelegramToken(): string {
  return String(config.telegramChatBotToken || config.telegramBotToken || "").trim();
}

async function resolveLeadTargetChatId(options: TelegramLeadOptions = {}): Promise<string> {
  const forbiddenChatIds = new Set(
    [options?.clientChatId, ...(Array.isArray(options?.forbiddenChatIds) ? options.forbiddenChatIds : [])]
      .map((value) => String(value || "").trim())
      .filter(Boolean)
  );
  const explicitTargetChatId = String(options?.targetChatId || "").trim();

  if (explicitTargetChatId && !forbiddenChatIds.has(explicitTargetChatId)) {
    return explicitTargetChatId;
  }

  const rememberedGroupChatId = await getManagerGroupChatId();

  if (rememberedGroupChatId && !forbiddenChatIds.has(rememberedGroupChatId)) {
    return rememberedGroupChatId;
  }

  const configuredChatId = String(config.telegramChatId || "").trim();

  if (configuredChatId && !forbiddenChatIds.has(configuredChatId)) {
    return configuredChatId;
  }

  return "";
}
