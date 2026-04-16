import db from "./database-sqlite.ts";
import type { ChatFollowUpCandidate, ChatMessage } from "./chat-types.ts";

const MAX_MESSAGES_PER_CHAT = 24;

type ChatMemoryRow = {
  messages: string;
  updated_at?: string;
  last_customer_message_at?: string;
  last_follow_up_at?: string;
};

export async function getChatMessages(chatId: string): Promise<ChatMessage[]> {
  const key = normalizeChatId(chatId);

  if (!key) {
    return [];
  }

  const row = db
    .prepare("SELECT messages FROM chat_memory WHERE chat_id = ?")
    .get(key) as ChatMemoryRow | undefined;

  if (!row) {
    return [];
  }

  try {
    const messages = JSON.parse(row.messages) as unknown;
    return normalizeMessages(messages);
  } catch (error) {
    console.error(`Error parsing messages for chat ${key}:`, error);
    return [];
  }
}

export async function saveChatMessages(
  chatId: string,
  messages: ChatMessage[] | unknown[]
): Promise<ChatMessage[]> {
  const key = normalizeChatId(chatId);

  if (!key) {
    return [];
  }

  const normalizedMessages = trimMessages(normalizeMessages(messages));
  const updatedAt = new Date().toISOString();
  const messagesJson = JSON.stringify(normalizedMessages);

  db.prepare(`
    INSERT INTO chat_memory (chat_id, updated_at, messages)
    VALUES (?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET
      updated_at = excluded.updated_at,
      messages = excluded.messages
  `).run(key, updatedAt, messagesJson);

  return normalizedMessages;
}

export async function markChatCustomerActivity(
  chatId: string,
  timestamp: string = new Date().toISOString()
): Promise<void> {
  const key = normalizeChatId(chatId);

  if (!key) {
    return;
  }

  db.prepare(`
    INSERT INTO chat_memory (chat_id, updated_at, last_customer_message_at, messages)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET
      updated_at = excluded.updated_at,
      last_customer_message_at = excluded.last_customer_message_at
  `).run(key, timestamp, timestamp, "[]");
}

export async function markChatFollowUpSent(
  chatId: string,
  timestamp: string = new Date().toISOString()
): Promise<void> {
  const key = normalizeChatId(chatId);

  if (!key) {
    return;
  }

  db.prepare(`
    INSERT INTO chat_memory (chat_id, updated_at, last_follow_up_at, messages)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET
      updated_at = excluded.updated_at,
      last_follow_up_at = excluded.last_follow_up_at
  `).run(key, timestamp, timestamp, "[]");
}

export async function listChatsNeedingFollowUp(
  inactiveBefore: string,
  limit = 50
): Promise<ChatFollowUpCandidate[]> {
  const rows = db
    .prepare(
      `
        SELECT chat_id, updated_at, last_customer_message_at, last_follow_up_at
        FROM chat_memory
        WHERE chat_id LIKE 'telegram:%'
          AND COALESCE(last_customer_message_at, '') <> ''
          AND last_customer_message_at <= ?
          AND (
            last_follow_up_at IS NULL
            OR last_follow_up_at = ''
            OR last_follow_up_at < last_customer_message_at
          )
        ORDER BY last_customer_message_at ASC
        LIMIT ?
      `
    )
    .all(inactiveBefore, Math.max(1, Number(limit) || 50)) as Array<ChatMemoryRow & { chat_id?: string }>;

  return rows.map((row) => ({
    chatId: String(row?.chat_id || "").trim(),
    updatedAt: String(row?.updated_at || "").trim() || undefined,
    lastCustomerMessageAt: String(row?.last_customer_message_at || "").trim() || undefined,
    lastFollowUpAt: String(row?.last_follow_up_at || "").trim() || undefined
  }));
}

export function isWeeklyFollowUpDue(
  lastCustomerMessageAt: string | undefined,
  lastFollowUpAt: string | undefined,
  now = Date.now(),
  inactivityMs = 7 * 24 * 60 * 60 * 1000
): boolean {
  const customerTs = Date.parse(String(lastCustomerMessageAt || ""));

  if (!Number.isFinite(customerTs) || customerTs > now - inactivityMs) {
    return false;
  }

  const followUpTs = Date.parse(String(lastFollowUpAt || ""));
  return !Number.isFinite(followUpTs) || followUpTs < customerTs;
}

export async function clearChatMessages(chatId: string): Promise<boolean> {
  const key = normalizeChatId(chatId);

  if (!key) {
    return false;
  }

  const result = db.prepare("DELETE FROM chat_memory WHERE chat_id = ?").run(key);
  return result.changes > 0;
}

export function normalizeMessages(messages: unknown): ChatMessage[] {
  return (Array.isArray(messages) ? messages : [])
    .filter(
      (message): message is { role?: unknown; content: string } =>
        Boolean(message) &&
        typeof message === "object" &&
        typeof (message as { content?: unknown }).content === "string"
    )
    .map((message): ChatMessage => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content.trim()
    }))
    .filter((message) => message.content);
}

export function mergeChatMessages(
  storedMessages: ChatMessage[] | unknown[],
  incomingMessages: ChatMessage[] | unknown[]
): ChatMessage[] {
  const normalizedStored = normalizeMessages(storedMessages);
  const normalizedIncoming = normalizeMessages(incomingMessages);

  if (normalizedIncoming.length === 0) {
    return trimMessages(normalizedStored);
  }

  if (normalizedIncoming.length === 1) {
    const [incomingMessage] = normalizedIncoming;
    const lastStoredMessage = normalizedStored[normalizedStored.length - 1];

    if (
      lastStoredMessage &&
      lastStoredMessage.role === incomingMessage.role &&
      lastStoredMessage.content === incomingMessage.content
    ) {
      return trimMessages(normalizedStored);
    }

    return trimMessages([...normalizedStored, incomingMessage]);
  }

  return trimMessages(normalizedIncoming);
}

function trimMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.slice(-MAX_MESSAGES_PER_CHAT);
}

function normalizeChatId(chatId: string): string {
  const value = String(chatId || "").trim();
  return value || "";
}
