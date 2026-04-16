import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import db from "../src/database-sqlite.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.resolve(__dirname, "../data");

async function readJsonFile(fileName, fallback = {}) {
  const filePath = path.join(dataDir, fileName);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function migrate() {
  console.log("Starting migration to SQLite...");

  // 1. Migrate Chat Memory
  const chatMemory = await readJsonFile("chat-memory.json", {});
  const insertChatMemory = db.prepare(`
    INSERT OR REPLACE INTO chat_memory (chat_id, updated_at, messages)
    VALUES (?, ?, ?)
  `);

  db.transaction(() => {
    for (const [chatId, value] of Object.entries(chatMemory)) {
      insertChatMemory.run(chatId, value.updatedAt || new Date().toISOString(), JSON.stringify(value.messages || []));
    }
  })();
  console.log(`Migrated ${Object.keys(chatMemory).length} chat memory entries.`);

  // 2. Migrate Order Sessions
  const orderSessions = await readJsonFile("order-sessions.json", {});
  const insertOrderSession = db.prepare(`
    INSERT OR REPLACE INTO order_sessions (chat_id, updated_at, data)
    VALUES (?, ?, ?)
  `);

  db.transaction(() => {
    for (const [chatId, value] of Object.entries(orderSessions)) {
      const { updatedAt, ...data } = value;
      insertOrderSession.run(chatId, updatedAt || new Date().toISOString(), JSON.stringify(data));
    }
  })();
  console.log(`Migrated ${Object.keys(orderSessions).length} order sessions.`);

  // 3. Migrate Leads
  const leads = await readJsonFile("leads.json", []);
  const insertLead = db.prepare(`
    INSERT OR REPLACE INTO leads (id, created_at, name, phone, contact, interest, notes, transcript, source, data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.transaction(() => {
    for (const lead of leads) {
      const { id, createdAt, name, phone, contact, interest, notes, transcript, source, ...otherData } = lead;
      insertLead.run(
        id,
        createdAt || new Date().toISOString(),
        name || null,
        phone || null,
        contact || null,
        interest || null,
        notes || null,
        transcript || null,
        source || null,
        JSON.stringify(otherData)
      );
    }
  })();
  console.log(`Migrated ${leads.length} leads.`);

  // 4. Migrate Telegram Relay
  const relayState = await readJsonFile("telegram-relay.json", {});
  
  if (relayState.managerGroupChatId) {
    db.prepare(`INSERT OR REPLACE INTO telegram_relay_config (id, manager_group_chat_id) VALUES (1, ?)`).run(relayState.managerGroupChatId);
  }

  const threads = relayState.threads || {};
  const insertThread = db.prepare(`INSERT OR REPLACE INTO telegram_relay_threads (lead_id, updated_at, data) VALUES (?, ?, ?)`);
  db.transaction(() => {
    for (const [leadId, thread] of Object.entries(threads)) {
      const { updatedAt, ...data } = thread;
      insertThread.run(leadId, updatedAt || new Date().toISOString(), JSON.stringify(data));
    }
  })();

  const groupIndex = relayState.groupMessageIndex || {};
  const insertGroupIndex = db.prepare(`INSERT OR REPLACE INTO telegram_relay_group_index (chat_id, message_id, lead_id) VALUES (?, ?, ?)`);
  db.transaction(() => {
    for (const [key, leadId] of Object.entries(groupIndex)) {
      const [chatId, messageId] = key.split(":");
      if (chatId && messageId) {
        insertGroupIndex.run(chatId, messageId, leadId);
      }
    }
  })();

  const clientIndex = relayState.clientChatIndex || {};
  const insertClientIndex = db.prepare(`INSERT OR REPLACE INTO telegram_relay_client_index (client_chat_id, lead_id) VALUES (?, ?)`);
  db.transaction(() => {
    for (const [clientChatId, leadId] of Object.entries(clientIndex)) {
      insertClientIndex.run(clientChatId, leadId);
    }
  })();
  
  console.log("Telegram relay state migrated.");
  console.log("Migration finished successfully!");
}

migrate().catch(err => {
  console.error("Migration failed:", err);
  process.exit(1);
});
