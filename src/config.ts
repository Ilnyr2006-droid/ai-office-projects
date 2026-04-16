import dotenv from "dotenv";

dotenv.config();

if (!process.env.OPENAI_API_KEY) {
  console.warn("[config] Missing required env var: OPENAI_API_KEY");
}

if (!process.env.TELEGRAM_CHAT_BOT_TOKEN && !process.env.TELEGRAM_BOT_TOKEN) {
  console.warn("[config] Missing Telegram bot token: set TELEGRAM_CHAT_BOT_TOKEN or TELEGRAM_BOT_TOKEN");
}

if (!process.env.TELEGRAM_CHAT_ID) {
  console.warn(
    "[config] Missing TELEGRAM_CHAT_ID. The bot can still learn the manager group after the first message in that group."
  );
}

export const config = {
  port: Number(process.env.PORT || 3000),
  openAiApiKey: process.env.OPENAI_API_KEY || "",
  openAiModel: process.env.OPENAI_MODEL || "gpt-4o-mini",
  openAiEmbeddingModel: process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small",
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
  telegramChatId: process.env.TELEGRAM_CHAT_ID || "",
  telegramChatBotToken: process.env.TELEGRAM_CHAT_BOT_TOKEN || "",
  allowedOrigins: (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
  company: {
    name: process.env.COMPANY_NAME || "Leather Store",
    city: process.env.COMPANY_CITY || "Москва",
    phone: process.env.COMPANY_PHONE || "",
    catalogUrl: process.env.COMPANY_CATALOG_URL || "",
    delivery: process.env.COMPANY_DELIVERY || "Доставка по России"
  }
};
