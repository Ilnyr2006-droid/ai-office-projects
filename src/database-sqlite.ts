import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.resolve(__dirname, "../data");

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, "app.db");
const db = new Database(dbPath);

// Enable WAL mode for performance and better concurrency
db.pragma('journal_mode = WAL');

// Initialize schema
db.exec(`
  CREATE TABLE IF NOT EXISTS chat_memory (
    chat_id TEXT PRIMARY KEY,
    updated_at TEXT,
    last_customer_message_at TEXT,
    last_follow_up_at TEXT,
    messages TEXT
  );

  CREATE TABLE IF NOT EXISTS order_sessions (
    chat_id TEXT PRIMARY KEY,
    updated_at TEXT,
    data TEXT
  );

  CREATE TABLE IF NOT EXISTS leads (
    id TEXT PRIMARY KEY,
    created_at TEXT,
    name TEXT,
    phone TEXT,
    contact TEXT,
    interest TEXT,
    notes TEXT,
    transcript TEXT,
    source TEXT,
    data TEXT
  );

  CREATE TABLE IF NOT EXISTS telegram_relay_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    manager_group_chat_id TEXT
  );

  CREATE TABLE IF NOT EXISTS telegram_relay_threads (
    lead_id TEXT PRIMARY KEY,
    updated_at TEXT,
    data TEXT
  );

  CREATE TABLE IF NOT EXISTS telegram_relay_group_index (
    chat_id TEXT,
    message_id TEXT,
    lead_id TEXT,
    PRIMARY KEY (chat_id, message_id)
  );

  CREATE TABLE IF NOT EXISTS telegram_relay_client_index (
    client_chat_id TEXT PRIMARY KEY,
    lead_id TEXT
  );
`);

ensureColumn("chat_memory", "last_customer_message_at", "TEXT");
ensureColumn("chat_memory", "last_follow_up_at", "TEXT");

function ensureColumn(tableName: string, columnName: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: string }>;
  const hasColumn = columns.some((column) => String(column?.name || "").trim() === columnName);

  if (!hasColumn) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

export default db;
