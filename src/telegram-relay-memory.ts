import db from "./database-sqlite.ts";
import type {
  LeadRecord,
  TelegramLeadThread,
  TelegramUser
} from "./chat-types.ts";

type ManagerGroupRow = {
  manager_group_chat_id?: string;
};

type LeadIdRow = {
  lead_id: string;
};

type ThreadRow = {
  data: string;
  updated_at: string;
};

export async function getManagerGroupChatId(): Promise<string> {
  const row = db
    .prepare("SELECT manager_group_chat_id FROM telegram_relay_config WHERE id = 1")
    .get() as ManagerGroupRow | undefined;

  return normalizeChatId(row?.manager_group_chat_id);
}

export async function saveManagerGroupChatId(chatId: string | number): Promise<string> {
  const normalizedChatId = normalizeChatId(chatId);

  if (!normalizedChatId) {
    return "";
  }

  db.prepare(`
    INSERT INTO telegram_relay_config (id, manager_group_chat_id)
    VALUES (1, ?)
    ON CONFLICT(id) DO UPDATE SET manager_group_chat_id = excluded.manager_group_chat_id
  `).run(normalizedChatId);

  return normalizedChatId;
}

export async function registerTelegramLeadThread({
  lead,
  clientChatId,
  groupChatId,
  groupMessageId,
  telegramUser
}: {
  lead: LeadRecord;
  clientChatId: string | number;
  groupChatId: string | number;
  groupMessageId: string | number;
  telegramUser?: TelegramUser;
}): Promise<TelegramLeadThread | null> {
  const normalizedLeadId = String(lead?.id || "").trim();
  const normalizedClientChatId = normalizeChatId(clientChatId);
  const normalizedGroupChatId = normalizeChatId(groupChatId);
  const normalizedGroupMessageId = normalizeMessageId(groupMessageId);

  if (
    !normalizedLeadId ||
    !normalizedClientChatId ||
    !normalizedGroupChatId ||
    !normalizedGroupMessageId
  ) {
    return null;
  }

  const existingThread = await getThreadById(normalizedLeadId);
  const groupMessageIds = Array.isArray(existingThread?.groupMessageIds)
    ? existingThread.groupMessageIds.map(normalizeMessageId).filter(Boolean)
    : [];

  if (!groupMessageIds.includes(normalizedGroupMessageId)) {
    groupMessageIds.push(normalizedGroupMessageId);
  }

  const threadData: TelegramLeadThread = {
    leadId: normalizedLeadId,
    clientChatId: normalizedClientChatId,
    groupChatId: normalizedGroupChatId,
    rootGroupMessageId: normalizedGroupMessageId,
    groupMessageIds,
    pendingManagerQuestion: String(existingThread?.pendingManagerQuestion || "").trim(),
    leadSnapshot: buildLeadSnapshot(lead),
    clientSnapshot: buildClientSnapshot(telegramUser, normalizedClientChatId),
    createdAt: existingThread?.createdAt || new Date().toISOString()
  };

  const updatedAt = new Date().toISOString();
  const transaction = db.transaction(() => {
    db.prepare(`
      INSERT INTO telegram_relay_threads (lead_id, updated_at, data)
      VALUES (?, ?, ?)
      ON CONFLICT(lead_id) DO UPDATE SET
        updated_at = excluded.updated_at,
        data = excluded.data
    `).run(normalizedLeadId, updatedAt, JSON.stringify(threadData));

    db.prepare(`
      INSERT INTO telegram_relay_client_index (client_chat_id, lead_id)
      VALUES (?, ?)
      ON CONFLICT(client_chat_id) DO UPDATE SET lead_id = excluded.lead_id
    `).run(normalizedClientChatId, normalizedLeadId);

    for (const messageId of groupMessageIds) {
      db.prepare(`
        INSERT INTO telegram_relay_group_index (chat_id, message_id, lead_id)
        VALUES (?, ?, ?)
        ON CONFLICT(chat_id, message_id) DO UPDATE SET lead_id = excluded.lead_id
      `).run(normalizedGroupChatId, messageId, normalizedLeadId);
    }
  });

  transaction();

  return { ...threadData, updatedAt };
}

export async function getTelegramLeadThreadByClientChatId(
  chatId: string | number
): Promise<TelegramLeadThread | null> {
  const normalizedChatId = normalizeChatId(chatId);

  if (!normalizedChatId) {
    return null;
  }

  const row = db
    .prepare("SELECT lead_id FROM telegram_relay_client_index WHERE client_chat_id = ?")
    .get(normalizedChatId) as LeadIdRow | undefined;

  if (!row) {
    return null;
  }

  return getThreadById(row.lead_id);
}

export async function getTelegramLeadThreadByGroupMessage(
  chatId: string | number,
  messageId: string | number
): Promise<TelegramLeadThread | null> {
  const normalizedChatId = normalizeChatId(chatId);
  const normalizedMessageId = normalizeMessageId(messageId);

  if (!normalizedChatId || !normalizedMessageId) {
    return null;
  }

  const row = db
    .prepare("SELECT lead_id FROM telegram_relay_group_index WHERE chat_id = ? AND message_id = ?")
    .get(normalizedChatId, normalizedMessageId) as LeadIdRow | undefined;

  if (!row) {
    return null;
  }

  return getThreadById(row.lead_id);
}

export async function addTelegramLeadThreadGroupMessage(
  leadId: string,
  chatId: string | number,
  messageId: string | number
): Promise<TelegramLeadThread | null> {
  const normalizedLeadId = String(leadId || "").trim();
  const normalizedChatId = normalizeChatId(chatId);
  const normalizedMessageId = normalizeMessageId(messageId);

  if (!normalizedLeadId || !normalizedChatId || !normalizedMessageId) {
    return null;
  }

  const thread = await getThreadById(normalizedLeadId);

  if (!thread) {
    return null;
  }

  const groupMessageIds = Array.isArray(thread.groupMessageIds)
    ? thread.groupMessageIds.map(normalizeMessageId).filter(Boolean)
    : [];

  if (!groupMessageIds.includes(normalizedMessageId)) {
    groupMessageIds.push(normalizedMessageId);
  }

  const { updatedAt: _updatedAt, ...threadData } = thread;
  const nextThreadData: TelegramLeadThread = {
    ...threadData,
    groupMessageIds,
    groupChatId: normalizedChatId
  };
  const updatedAt = new Date().toISOString();

  const transaction = db.transaction(() => {
    db.prepare(`
      UPDATE telegram_relay_threads
      SET updated_at = ?, data = ?
      WHERE lead_id = ?
    `).run(updatedAt, JSON.stringify(nextThreadData), normalizedLeadId);

    db.prepare(`
      INSERT INTO telegram_relay_group_index (chat_id, message_id, lead_id)
      VALUES (?, ?, ?)
      ON CONFLICT(chat_id, message_id) DO UPDATE SET lead_id = excluded.lead_id
    `).run(normalizedChatId, normalizedMessageId, normalizedLeadId);
  });

  transaction();

  return { ...nextThreadData, updatedAt };
}

export async function updateTelegramLeadThread(
  leadId: string,
  patch: Partial<TelegramLeadThread>
): Promise<TelegramLeadThread | null> {
  const normalizedLeadId = String(leadId || "").trim();

  if (!normalizedLeadId || !patch || typeof patch !== "object") {
    return null;
  }

  const thread = await getThreadById(normalizedLeadId);

  if (!thread) {
    return null;
  }

  const { updatedAt: _updatedAt, ...oldData } = thread;
  const newData: TelegramLeadThread = { ...oldData, ...patch };
  const updatedAt = new Date().toISOString();

  db.prepare(`
    UPDATE telegram_relay_threads
    SET updated_at = ?, data = ?
    WHERE lead_id = ?
  `).run(updatedAt, JSON.stringify(newData), normalizedLeadId);

  return { ...newData, updatedAt };
}

async function getThreadById(leadId: string): Promise<TelegramLeadThread | null> {
  const row = db
    .prepare("SELECT data, updated_at FROM telegram_relay_threads WHERE lead_id = ?")
    .get(leadId) as ThreadRow | undefined;

  if (!row) {
    return null;
  }

  try {
    const data = JSON.parse(row.data) as unknown;
    const thread = normalizeThread(data);
    return thread ? { ...thread, updatedAt: row.updated_at } : null;
  } catch (error) {
    console.error(`Error parsing thread data for lead ${leadId}:`, error);
    return null;
  }
}

function normalizeThread(value: unknown): TelegramLeadThread | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const thread = value as Partial<TelegramLeadThread>;
  const leadId = String(thread.leadId || "").trim();
  const clientChatId = normalizeChatId(thread.clientChatId);
  const groupChatId = normalizeChatId(thread.groupChatId);
  const rootGroupMessageId = normalizeMessageId(thread.rootGroupMessageId);
  const createdAt = String(thread.createdAt || "").trim();

  if (!leadId || !clientChatId || !groupChatId || !rootGroupMessageId || !createdAt) {
    return null;
  }

  return {
    leadId,
    clientChatId,
    groupChatId,
    rootGroupMessageId,
    groupMessageIds: Array.isArray(thread.groupMessageIds)
      ? thread.groupMessageIds.map(normalizeMessageId).filter(Boolean)
      : [],
    pendingManagerQuestion: String(thread.pendingManagerQuestion || "").trim(),
    leadSnapshot: buildLeadSnapshot(thread.leadSnapshot),
    clientSnapshot: buildClientSnapshot(thread.clientSnapshot, clientChatId),
    createdAt,
    updatedAt: String(thread.updatedAt || "").trim() || undefined
  };
}

function buildLeadSnapshot(lead: Partial<LeadRecord> | null | undefined): LeadRecord {
  return {
    id: String(lead?.id || "").trim(),
    createdAt: String(lead?.createdAt || "").trim(),
    name: String(lead?.name || "").trim(),
    phone: String(lead?.phone || "").trim(),
    contact: String(lead?.contact || "").trim(),
    interest: String(lead?.interest || "").trim(),
    notes: String(lead?.notes || "").trim(),
    transcript: String(lead?.transcript || "").trim(),
    source: String(lead?.source || "").trim()
  };
}

function buildClientSnapshot(
  telegramUser: Partial<TelegramUser> | { username?: string; fullName?: string; clientChatId?: string } | null | undefined,
  clientChatId: string
): TelegramLeadThread["clientSnapshot"] {
  const username = String(telegramUser?.username || "").trim();
  const fullName = hasFullName(telegramUser)
    ? String(telegramUser.fullName || "").trim()
    : [telegramUser?.first_name, telegramUser?.last_name]
        .map((value) => String(value || "").trim())
        .filter(Boolean)
        .join(" ");

  return {
    username,
    fullName,
    clientChatId
  };
}

function normalizeChatId(chatId: string | number | undefined): string {
  return String(chatId || "").trim();
}

function normalizeMessageId(messageId: string | number | undefined): string {
  const value = Number(messageId);
  return Number.isInteger(value) && value > 0 ? String(value) : "";
}

function hasFullName(
  value: Partial<TelegramUser> | { username?: string; fullName?: string; clientChatId?: string } | null | undefined
): value is { username?: string; fullName?: string; clientChatId?: string } {
  return Boolean(value && typeof value === "object" && "fullName" in value);
}
