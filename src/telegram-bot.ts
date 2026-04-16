import { config } from "./config.ts";
import {
  clearChatMessages,
  getChatMessages,
  isWeeklyFollowUpDue,
  listChatsNeedingFollowUp,
  markChatCustomerActivity,
  markChatFollowUpSent
} from "./chat-memory.ts";
import { processChatMessages } from "./chat-service.ts";
import type {
  ProductAttachment,
  TelegramApiMessageResult,
  TelegramApiResponse,
  TelegramLeadThread,
  TelegramMessage,
  TelegramUpdate
} from "./chat-types.ts";
import { clearOrderSession } from "./order-memory.ts";
import { handleTelegramOrderFlow } from "./order-service.ts";
import { answerManagerQuestion } from "./openai.ts";
import {
  addTelegramLeadThreadGroupMessage,
  getTelegramLeadThreadByClientChatId,
  getTelegramLeadThreadByGroupMessage,
  saveManagerGroupChatId,
  updateTelegramLeadThread
} from "./telegram-relay-memory.ts";

const POLL_TIMEOUT_SECONDS = 30;
const RETRY_DELAY_MS = 3000;
const FOLLOW_UP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FOLLOW_UP_INACTIVITY_MS = 7 * 24 * 60 * 60 * 1000;
const MANAGER_TO_CLIENT_RE =
  /^(?:\/client(?:\s+|$)|\/askclient(?:\s+|$)|клиенту\s*[:\-]\s*|спроси(?:\s+у\s+клиента)?\s*[:\-]\s*|уточни(?:\s+у\s+клиента)?\s*[:\-]\s*)/i;
const MANAGER_SUMMARY_RE = /^(?:\/summary|\/card|сводка|что\s+по\s+клиенту)\b/i;

type TelegramCallPayload = Record<string, unknown>;

type TelegramAttachmentDelivery = {
  attempted: number;
  sent: number;
  failed: number;
};

export function startTelegramSellerBot(): void {
  if (!config.telegramChatBotToken) {
    console.log("[telegram-bot] TELEGRAM_CHAT_BOT_TOKEN is not set, bot polling skipped");
    return;
  }

  let offset = 0;
  let stopped = false;
  let initialized = false;

  const poll = async () => {
    while (!stopped) {
      try {
        if (!initialized) {
          await initializeTelegramBot();
          initialized = true;
        }

        const updates = await getUpdates(offset, POLL_TIMEOUT_SECONDS);

        for (const update of updates) {
          offset = Math.max(offset, Number(update.update_id || 0) + 1);
          await handleTelegramUpdate(update);
        }
      } catch (error) {
        console.error("[telegram-bot]", formatTelegramError(error));
        initialized = false;
        await delay(RETRY_DELAY_MS);
      }
    }
  };

  void poll();
  void runFollowUpLoop();

  const stop = () => {
    stopped = true;
  };

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  console.log("[telegram-bot] Polling started");
}

async function initializeTelegramBot(): Promise<void> {
  try {
    const botProfile = await callTelegram<{ username?: string }>("getMe");
    const webhookInfo = await callTelegram<{ url?: string }>("getWebhookInfo");
    const webhookUrl = String(webhookInfo?.result?.url || "").trim();

    if (webhookUrl) {
      console.log(`[telegram-bot] Active webhook found: ${webhookUrl}`);
      await callTelegram("deleteWebhook", { drop_pending_updates: false });
      console.log("[telegram-bot] Webhook removed, long polling enabled");
    }

    const username = botProfile?.result?.username ? `@${botProfile.result.username}` : "unknown";
    console.log(`[telegram-bot] Authorized as ${username}`);
  } catch (error) {
    throw new Error(`Initialization failed: ${formatTelegramError(error)}`);
  }
}

async function handleTelegramUpdate(update: TelegramUpdate): Promise<void> {
  const message = update?.message;
  const chatType = String(message?.chat?.type || "").trim();
  const chatId = String(message?.chat?.id || "").trim();
  const text = String(message?.text || "").trim();

  if (!chatId || !text) {
    return;
  }

  if (chatType === "group" || chatType === "supergroup") {
    await handleManagerGroupMessage(message || {}, chatId, text);
    return;
  }

  await handlePrivateTelegramMessage(message || {}, chatId, text);
}

async function handlePrivateTelegramMessage(
  message: TelegramMessage,
  chatId: string,
  text: string
): Promise<void> {
  await markChatCustomerActivity(buildTelegramChatKey(chatId));
  const relayThread = await getTelegramLeadThreadByClientChatId(chatId);

  if (text === "/start") {
    await sendTelegramMessage(
      chatId,
      [
        "Здравствуйте! Я помогу подобрать кожу по цвету, назначению, толщине и типу материала.",
        "Напишите, что именно вам нужно, например: `нужна черная кожа для сумки`.",
        "Чтобы запустить отдельное оформление заявки, напишите `/order`.",
        "Команда `/cancel` отменяет оформление заказа, а `/reset` очищает память текущего диалога."
      ].join("\n\n")
    );
    return;
  }

  if (text === "/reset") {
    await clearChatMessages(buildTelegramChatKey(chatId));
    await clearOrderSession(chatId);

    if (relayThread?.leadId) {
      await updateTelegramLeadThread(relayThread.leadId, {
        pendingManagerQuestion: ""
      });
    }

    await sendTelegramMessage(chatId, "Память этого чата очищена. Можете начать новый запрос.");
    return;
  }

  let orderFlowResult: { handled: true; reply: string } | null = null;

  try {
    orderFlowResult = await handleTelegramOrderFlow({
      chatId,
      text,
      telegramUser: message?.from
    });
  } catch (error) {
    console.error("[telegram-bot:order]", error);
    await sendTelegramMessage(
      chatId,
      "Не удалось передать заявку менеджеру. Добавьте бота в рабочую группу и отправьте там любое сообщение, затем повторите попытку."
    );
    return;
  }

  if (orderFlowResult?.handled) {
    await sendTelegramMessage(chatId, orderFlowResult.reply);
    return;
  }

  if (relayThread?.pendingManagerQuestion) {
    await notifyManagersAboutClientReply({
      thread: relayThread,
      clientMessage: text
    });
    await updateTelegramLeadThread(relayThread.leadId, {
      pendingManagerQuestion: ""
    });
    await sendTelegramMessage(chatId, "Спасибо, передал ответ менеджеру.");
    return;
  }

  await sendChatAction(chatId, "typing");

  try {
    const result = await processChatMessages({
      chatId: buildTelegramChatKey(chatId),
      messages: [{ role: "user", content: text }]
    });

    await sendTelegramMessage(chatId, result.reply);
    const attachmentDelivery = await sendTelegramAttachments(chatId, result.attachments);

    if (attachmentDelivery.attempted > 0 && attachmentDelivery.sent === 0) {
      await sendTelegramMessage(
        chatId,
        "Не удалось отправить фото автоматически. Напишите название кожи, и я повторю отправку."
      );
    }
  } catch (error) {
    console.error("[telegram-bot:reply]", error);
    await sendTelegramMessage(
      chatId,
      "Не удалось обработать сообщение. Попробуйте повторить запрос чуть позже."
    );
  }
}

async function handleManagerGroupMessage(
  message: TelegramMessage,
  chatId: string,
  text: string
): Promise<void> {
  await saveManagerGroupChatId(chatId);

  const replyToMessageId = Number(message?.reply_to_message?.message_id || 0);
  const thread = replyToMessageId
    ? await getTelegramLeadThreadByGroupMessage(chatId, replyToMessageId)
    : null;

  if (!thread) {
    return;
  }

  const clientPrompt = extractClientPrompt(text);

  if (clientPrompt) {
    await sendTelegramMessage(thread.clientChatId, clientPrompt);
    await updateTelegramLeadThread(thread.leadId, {
      pendingManagerQuestion: clientPrompt
    });
    const confirmation = await sendTelegramMessage(chatId, `Отправил клиенту: ${clientPrompt}`, {
      replyToMessageId: Number(message.message_id || replyToMessageId || 0)
    });
    await rememberThreadGroupMessage(thread.leadId, chatId, confirmation?.message_id);
    return;
  }

  if (!looksLikeManagerQuestion(text)) {
    return;
  }

  await sendChatAction(chatId, "typing");

  const answer = await buildManagerAnswer(thread, text);
  const reply = await sendTelegramMessage(chatId, answer, {
    replyToMessageId: Number(message.message_id || replyToMessageId || 0)
  });
  await rememberThreadGroupMessage(thread.leadId, chatId, reply?.message_id);
}

async function runFollowUpLoop(): Promise<void> {
  while (true) {
    try {
      await sendInactiveChatFollowUps();
    } catch (error) {
      console.warn("[telegram-bot:follow-up]", formatTelegramError(error));
    }

    await delay(FOLLOW_UP_INTERVAL_MS);
  }
}

async function sendInactiveChatFollowUps(now = Date.now()): Promise<void> {
  const inactiveBefore = new Date(now - FOLLOW_UP_INACTIVITY_MS).toISOString();
  const candidates = await listChatsNeedingFollowUp(inactiveBefore, 50);

  for (const candidate of candidates) {
    if (
      !isWeeklyFollowUpDue(
        candidate.lastCustomerMessageAt,
        candidate.lastFollowUpAt,
        now,
        FOLLOW_UP_INACTIVITY_MS
      )
    ) {
      continue;
    }

    const chatId = extractTelegramChatId(candidate.chatId);

    if (!chatId) {
      continue;
    }

    const followUpText = [
      "Здравствуйте!",
      "У нас диалог остановился больше недели назад.",
      "Если хотите, я могу предложить новые товары, посчитать полную стоимость заказа или помочь оформить заявку."
    ].join(" ");

    try {
      await sendTelegramMessage(chatId, followUpText);
      await markChatFollowUpSent(candidate.chatId, new Date(now).toISOString());
    } catch (error) {
      console.warn("[telegram-bot:follow-up]", formatTelegramError(error));
    }
  }
}

function buildTelegramChatKey(chatId: string): string {
  return `telegram:${String(chatId || "").trim()}`;
}

function extractTelegramChatId(chatKey: string): string {
  const normalized = String(chatKey || "").trim();
  return normalized.startsWith("telegram:") ? normalized.slice("telegram:".length) : "";
}

async function getUpdates(offset: number, timeout: number): Promise<TelegramUpdate[]> {
  const response = await callTelegram<TelegramUpdate[]>("getUpdates", {
    offset,
    timeout,
    allowed_updates: ["message"]
  });

  if (!response.ok) {
    throw new Error(`Telegram getUpdates failed: ${response.description || "unknown error"}`);
  }

  return Array.isArray(response.result) ? response.result : [];
}

async function sendChatAction(chatId: string, action: string): Promise<void> {
  await callTelegram("sendChatAction", {
    chat_id: chatId,
    action
  }).catch((error: unknown) => {
    console.warn("[telegram-bot:action]", error instanceof Error ? error.message : String(error));
  });
}

async function sendTelegramMessage(
  chatId: string,
  text: string,
  options: { replyToMessageId?: number } = {}
): Promise<TelegramApiMessageResult | undefined> {
  const payload: TelegramCallPayload = {
    chat_id: chatId,
    text
  };

  const replyToMessageId = Number(options?.replyToMessageId || 0);

  if (replyToMessageId > 0) {
    payload.reply_to_message_id = replyToMessageId;
  }

  const response = await callTelegram<TelegramApiMessageResult>("sendMessage", payload);

  if (!response.ok) {
    throw new Error(`Telegram sendMessage failed: ${response.description || "unknown error"}`);
  }

  return response.result;
}

async function sendTelegramAttachments(
  chatId: string,
  attachments: ProductAttachment[]
): Promise<TelegramAttachmentDelivery> {
  const items = (Array.isArray(attachments) ? attachments : []).filter((item) => {
    return String(item?.type || "").trim() === "image" && String(item?.url || "").trim();
  });
  let attempted = 0;
  let sent = 0;

  if (items.length === 0) {
    return { attempted, sent, failed: 0 };
  }

  attempted = items.length;

  for (const item of items) {
    try {
      const response = await callTelegram("sendPhoto", {
        chat_id: chatId,
        photo: String(item.url).trim(),
        caption: buildTelegramProductCaption(item)
      });

      if (!response?.ok) {
        console.warn("[telegram-bot:photo]", response?.description || "unknown sendPhoto error");
        continue;
      }

      sent += 1;
    } catch (error) {
      console.warn("[telegram-bot:photo]", formatTelegramError(error));
    }
  }

  return {
    attempted,
    sent,
    failed: attempted - sent
  };
}

export function buildTelegramProductCaption(attachment: ProductAttachment): string {
  const lines = [
    String(attachment?.name || "").trim(),
    attachment?.price ? `Цена: ${String(attachment.price).trim()}` : "",
    attachment?.category ? `Категория: ${String(attachment.category).trim()}` : "",
    Array.isArray(attachment?.colors) && attachment.colors.length > 0
      ? `Цвет: ${attachment.colors.slice(0, 3).join(", ")}`
      : "",
    Array.isArray(attachment?.applications) && attachment.applications.length > 0
      ? `Назначение: ${attachment.applications.slice(0, 2).join(", ")}`
      : "",
    attachment?.thickness ? `Толщина: ${String(attachment.thickness).trim()}` : "",
    attachment?.materialType ? `Сырье: ${String(attachment.materialType).trim()}` : "",
    attachment?.leatherType ? `Тип кожи: ${String(attachment.leatherType).trim()}` : "",
    attachment?.stock ? `Наличие: ${String(attachment.stock).trim()}` : ""
  ].filter(Boolean);

  return lines.join("\n").slice(0, 1024);
}

async function callTelegram<T = unknown>(
  method: string,
  payload: TelegramCallPayload = {}
): Promise<TelegramApiResponse<T>> {
  const response = await fetch(`https://api.telegram.org/bot${config.telegramChatBotToken}/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const data = (await response.json().catch(() => null)) as TelegramApiResponse<T> | null;

  if (!response.ok) {
    throw new Error(`Telegram API error ${response.status}: ${data?.description || "invalid response"}`);
  }

  return data || {};
}

function formatTelegramError(error: unknown): string {
  const message =
    error instanceof Error ? error.message : String(error || "unknown error");

  if (message.includes("401")) {
    return `${message}. Проверь TELEGRAM_CHAT_BOT_TOKEN.`;
  }

  if (message.includes("409")) {
    return `${message}. Похоже, этот бот уже запущен в другом процессе или у него конфликтующий getUpdates/webhook.`;
  }

  return message;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function extractClientPrompt(text: string): string {
  const normalizedText = String(text || "").trim();

  if (!normalizedText) {
    return "";
  }

  if (!MANAGER_TO_CLIENT_RE.test(normalizedText)) {
    return "";
  }

  return normalizedText.replace(MANAGER_TO_CLIENT_RE, "").trim();
}

function looksLikeManagerQuestion(text: string): boolean {
  const normalizedText = String(text || "").trim();

  if (!normalizedText) {
    return false;
  }

  return MANAGER_SUMMARY_RE.test(normalizedText) || normalizedText.includes("?");
}

async function buildManagerAnswer(thread: TelegramLeadThread, text: string): Promise<string> {
  const question = MANAGER_SUMMARY_RE.test(String(text || "").trim())
    ? "Дай короткую сводку по клиенту: что он хочет, какие контакты оставил и что было в последних сообщениях."
    : text;
  const recentMessages = await getChatMessages(buildTelegramChatKey(thread.clientChatId));

  return answerManagerQuestion({
    question,
    lead: thread.leadSnapshot,
    transcript: thread.leadSnapshot?.transcript || "",
    recentMessages: recentMessages.slice(-12)
  });
}

async function notifyManagersAboutClientReply({
  thread,
  clientMessage
}: {
  thread: TelegramLeadThread;
  clientMessage: string;
}): Promise<void> {
  const groupChatId = String(thread?.groupChatId || "").trim();
  const rootGroupMessageId = Number(thread?.rootGroupMessageId || 0);
  const prompt = String(thread?.pendingManagerQuestion || "").trim();

  if (!groupChatId || rootGroupMessageId <= 0) {
    return;
  }

  const lines = [
    "Клиент ответил на уточнение.",
    prompt ? `Вопрос менеджера: ${prompt}` : "",
    `Ответ клиента: ${clientMessage}`
  ].filter(Boolean);

  const reply = await sendTelegramMessage(groupChatId, lines.join("\n"), {
    replyToMessageId: rootGroupMessageId
  });
  await rememberThreadGroupMessage(thread.leadId, groupChatId, reply?.message_id);
}

async function rememberThreadGroupMessage(
  leadId: string,
  chatId: string,
  messageId?: number
): Promise<void> {
  if (!leadId || !chatId || !messageId) {
    return;
  }

  await addTelegramLeadThreadGroupMessage(leadId, chatId, messageId);
}
