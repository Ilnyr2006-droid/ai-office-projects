import db from "./database-sqlite.ts";
import type { OrderSession } from "./chat-types.ts";

type OrderSessionRow = {
  data: string;
  updated_at: string;
};

export async function getOrderSession(chatId: string): Promise<OrderSession | null> {
  const key = normalizeChatId(chatId);

  if (!key) {
    return null;
  }

  const row = db
    .prepare("SELECT data, updated_at FROM order_sessions WHERE chat_id = ?")
    .get(key) as OrderSessionRow | undefined;

  if (!row) {
    return null;
  }

  try {
    const data = JSON.parse(row.data) as unknown;
    return {
      ...normalizeSession(data),
      updatedAt: row.updated_at
    };
  } catch (error) {
    console.error(`Error parsing order session for chat ${key}:`, error);
    return null;
  }
}

export async function saveOrderSession(
  chatId: string,
  session: OrderSession | null | undefined
): Promise<OrderSession | null> {
  const key = normalizeChatId(chatId);

  if (!key || !session || typeof session !== "object") {
    return null;
  }

  const { updatedAt: _updatedAt, ...sessionData } = normalizeSession(session);
  const updatedAt = new Date().toISOString();
  const dataJson = JSON.stringify(sessionData);

  db.prepare(`
    INSERT INTO order_sessions (chat_id, updated_at, data)
    VALUES (?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET
      updated_at = excluded.updated_at,
      data = excluded.data
  `).run(key, updatedAt, dataJson);

  return { ...sessionData, updatedAt };
}

export async function clearOrderSession(chatId: string): Promise<boolean> {
  const key = normalizeChatId(chatId);

  if (!key) {
    return false;
  }

  const result = db.prepare("DELETE FROM order_sessions WHERE chat_id = ?").run(key);
  return result.changes > 0;
}

function normalizeSession(session: unknown): OrderSession {
  const value = session && typeof session === "object" ? (session as Partial<OrderSession>) : {};

  return {
    interest: String(value.interest || "").trim(),
    quantity: String(value.quantity || "").trim(),
    name: String(value.name || "").trim(),
    contact: String(value.contact || "").trim(),
    updatedAt: String(value.updatedAt || "").trim() || undefined
  };
}

function normalizeChatId(chatId: string): string {
  return String(chatId || "").trim();
}
