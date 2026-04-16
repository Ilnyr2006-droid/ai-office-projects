import cors from "cors";
import express from "express";
import { clearChatMessages } from "./chat-memory.ts";
import { processChatMessages } from "./chat-service.ts";
import type { LeadRecord } from "./chat-types.ts";
import { config } from "./config.ts";
import { getCatalog, getLeads, saveLead, searchCatalog } from "./database.ts";
import { startTelegramSellerBot } from "./telegram-bot.ts";
import { sendLeadToTelegram } from "./telegram.ts";

type RequestPayload = Record<string, unknown> | null | undefined;

type ErrorWithMessage = Error & {
  code?: string;
};

const app = express();

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || config.allowedOrigins.length === 0) {
        return callback(null, true);
      }

      const isAllowed = config.allowedOrigins.some((allowedOrigin) => {
        if (allowedOrigin.includes("*")) {
          const regex = new RegExp(
            `^${allowedOrigin.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*")}$`
          );
          return regex.test(origin);
        }

        return allowedOrigin === origin;
      });

      return callback(isAllowed ? null : new Error("CORS blocked"), isAllowed);
    }
  })
);

app.get("/health", (_req, res) => {
  res.json({ ok: true, model: config.openAiModel });
});

app.post("/api/chat", async (req, res) => {
  try {
    const body = readPayload(req.body);
    const result = await processChatMessages({
      chatId: readString(body?.chatId),
      messages: Array.isArray(body?.messages) ? body.messages : []
    });

    res.json({
      reply: result.reply,
      attachments: result.attachments,
      chatId: result.chatId
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message === "messages is empty") {
      return res.status(400).json({ error: "messages is empty" });
    }

    console.error("[chat]", error);
    res.status(500).json({ error: "Не удалось получить ответ от ИИ." });
  }
});

app.post("/api/chat/reset", async (req, res) => {
  try {
    const body = readPayload(req.body);
    const chatId = readString(body?.chatId).trim();

    if (!chatId) {
      return res.status(400).json({ error: "chatId is required" });
    }

    await clearChatMessages(chatId);
    res.json({ ok: true, chatId });
  } catch (error) {
    console.error("[chat-reset]", error);
    res.status(500).json({ error: "Не удалось очистить память чата." });
  }
});

app.post("/api/lead", async (req, res) => {
  try {
    const lead = normalizeLead(req.body, "Tilda");

    if (!lead.phone && !lead.contact) {
      return res.status(400).json({ error: "Нужен телефон или другой контакт." });
    }

    await saveLead(lead);
    await sendLeadToTelegram(lead);
    res.json({ ok: true });
  } catch (error) {
    console.error("[lead]", error);
    res.status(500).json({ error: "Не удалось отправить заявку." });
  }
});

app.post("/api/tilda/lead", async (req, res) => {
  try {
    const body = readPayload(req.body);
    const lead = normalizeLead(
      {
        name: body?.name || body?.Name,
        phone: body?.phone || body?.Phone,
        contact: body?.contact || body?.telegram || body?.email || body?.Email,
        interest:
          body?.interest || body?.product || body?.message || body?.Comment || body?.textarea,
        notes: body?.notes || body?.formid || body?.formname
      },
      "Tilda form"
    );

    if (!lead.phone && !lead.contact) {
      return res.status(400).json({ error: "Нужен телефон или другой контакт." });
    }

    await saveLead(lead);
    await sendLeadToTelegram(lead);
    res.status(200).send("ok");
  } catch (error) {
    console.error("[tilda-lead]", error);
    res.status(500).send("error");
  }
});

app.get("/api/leads", async (_req, res) => {
  try {
    const leads = await getLeads();
    res.json({ leads });
  } catch (error) {
    console.error("[leads]", error);
    res.status(500).json({ error: "Не удалось загрузить заявки." });
  }
});

app.get("/api/catalog", async (req, res) => {
  try {
    const query = readString(req.query?.q).trim();
    const limit = Number(readString(req.query?.limit).trim()) || undefined;
    const catalog = query ? await searchCatalog(query, limit) : await getCatalog();
    res.json(catalog);
  } catch (error) {
    console.error("[catalog]", error);
    res.status(500).json({ error: "Не удалось загрузить каталог." });
  }
});

app.use((error: ErrorWithMessage, _req, res, _next) => {
  if (error?.message === "CORS blocked") {
    return res.status(403).json({ error: "Origin not allowed" });
  }

  console.error("[server]", error);
  return res.status(500).json({ error: "Internal server error" });
});

const server = app.listen(config.port, () => {
  console.log(`AI seller backend is running on port ${config.port}`);
  startTelegramSellerBot();
});

server.on("error", (error: ErrorWithMessage) => {
  if (error?.code === "EADDRINUSE") {
    console.error(
      `[server] Port ${config.port} is already in use. Stop the existing process or set PORT to a different value.`
    );
    process.exit(1);
  }

  console.error("[server]", error);
  process.exit(1);
});

function normalizeLead(payload: unknown, source: string): LeadRecord {
  const body = readPayload(payload);

  return {
    name: readString(body?.name),
    phone: readString(body?.phone),
    contact: readString(body?.contact),
    interest: readString(body?.interest),
    notes: readString(body?.notes),
    transcript: readString(body?.transcript),
    source: readString(body?.source || source)
  };
}

function readPayload(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

function readString(value: unknown): string {
  return String(value || "").trim();
}
