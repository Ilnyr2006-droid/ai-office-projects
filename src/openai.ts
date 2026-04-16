import { config } from "./config.ts";
import { getKnowledgeContext } from "./database.ts";
import { buildSystemPrompt } from "./prompt.ts";
import type {
  AnswerManagerQuestionInput,
  CatalogProduct,
  ChatMessage,
  GenerateSellerReplyOptions,
  LeadRecord,
  SellerReplyGenerationResult
} from "./chat-types.ts";

type KnowledgeContextResult = {
  company?: Record<string, unknown>;
  text?: string;
  topProducts?: CatalogProduct[];
  relevantProducts?: CatalogProduct[];
};

type OpenAiChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
};

type OpenAiEmbeddingResponse = {
  data?: Array<{
    embedding?: number[];
  }>;
};

export async function generateSellerReply(
  messages: ChatMessage[],
  options: GenerateSellerReplyOptions = {}
): Promise<SellerReplyGenerationResult> {
  const latestUserMessage =
    [...messages].reverse().find((message) => message.role === "user")?.content || "";
  const queryEmbedding = await createEmbedding(latestUserMessage).catch((error: unknown) => {
    console.warn("[embeddings]", error instanceof Error ? error.message : String(error));
    return null;
  });
  const knowledge = (await getKnowledgeContext(latestUserMessage, {
    queryEmbedding
  })) as KnowledgeContextResult;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.openAiApiKey}`
    },
    body: JSON.stringify({
      model: config.openAiModel,
      temperature: 0.5,
      messages: [
        {
          role: "system",
          content: buildSystemPrompt(
            {
              ...config.company,
              ...(knowledge.company || {})
            },
            String(knowledge.text || ""),
            {
              topProducts: Array.isArray(knowledge.topProducts) ? knowledge.topProducts : [],
              canSendProductPhotos: Boolean(options.canSendProductPhotos)
            }
          )
        },
        ...messages
      ]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${errorText}`);
  }

  const data = (await response.json()) as OpenAiChatCompletionResponse;
  return {
    reply: data.choices?.[0]?.message?.content?.trim() || "Не удалось получить ответ.",
    topProducts: Array.isArray(knowledge.topProducts) ? knowledge.topProducts : [],
    relevantProducts: Array.isArray(knowledge.relevantProducts) ? knowledge.relevantProducts : []
  };
}

export async function answerManagerQuestion({
  question,
  lead,
  transcript,
  recentMessages
}: AnswerManagerQuestionInput): Promise<string> {
  const normalizedQuestion = String(question || "").trim();

  if (!normalizedQuestion) {
    return "Не вижу вопроса менеджера.";
  }

  if (!config.openAiApiKey) {
    return buildManagerFallback(lead, transcript, recentMessages);
  }

  const contextParts = [
    `ID заявки: ${String(lead?.id || "").trim() || "не указан"}`,
    `Имя клиента: ${String(lead?.name || "").trim() || "не указано"}`,
    `Интерес: ${String(lead?.interest || "").trim() || "не указан"}`,
    `Контакт: ${String(lead?.contact || lead?.phone || "").trim() || "не указан"}`,
    lead?.notes ? `Комментарий: ${String(lead.notes).trim()}` : "",
    transcript ? `Полный диалог:\n${transcript}` : "",
    Array.isArray(recentMessages) && recentMessages.length
      ? `Последние сообщения:\n${recentMessages
          .map((message) => `${message.role === "assistant" ? "Бот" : "Клиент"}: ${message.content}`)
          .join("\n")}`
      : ""
  ]
    .filter(Boolean)
    .join("\n\n");

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.openAiApiKey}`
    },
    body: JSON.stringify({
      model: config.openAiModel,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: [
            "Ты помощник менеджеров по продажам.",
            "Отвечай только на основе переданного контекста по клиенту и заявке.",
            "Если данных в переписке нет, прямо скажи, что этого нет в истории.",
            "Не придумывай факты, статусы оплаты, доставки, подтверждения заказа и контакты.",
            "Ответ должен быть кратким, предметным и на русском."
          ].join(" ")
        },
        {
          role: "user",
          content: `Контекст по клиенту:\n${contextParts}\n\nВопрос менеджера:\n${normalizedQuestion}`
        }
      ]
    })
  });

  if (!response.ok) {
    return buildManagerFallback(lead, transcript, recentMessages);
  }

  const data = ((await response.json().catch(() => null)) as OpenAiChatCompletionResponse | null);
  return data?.choices?.[0]?.message?.content?.trim() || buildManagerFallback(lead, transcript, recentMessages);
}

async function createEmbedding(input: string): Promise<number[] | null> {
  const normalizedInput = String(input || "").trim();

  if (!normalizedInput || !config.openAiApiKey) {
    return null;
  }

  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.openAiApiKey}`
    },
    body: JSON.stringify({
      model: config.openAiEmbeddingModel,
      input: normalizedInput
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI embeddings error ${response.status}: ${errorText}`);
  }

  const data = (await response.json()) as OpenAiEmbeddingResponse;
  return Array.isArray(data.data?.[0]?.embedding) ? data.data[0].embedding : null;
}

function buildManagerFallback(
  lead?: LeadRecord | null,
  transcript?: string,
  recentMessages?: ChatMessage[]
): string {
  const lastClientMessage = [...(Array.isArray(recentMessages) ? recentMessages : [])]
    .reverse()
    .find((message) => message.role === "user")?.content;

  const parts = [
    `Заявка: ${String(lead?.interest || "").trim() || "не указана"}.`,
    `Контакт: ${String(lead?.contact || lead?.phone || "").trim() || "не указан"}.`,
    lastClientMessage ? `Последнее сообщение клиента: ${lastClientMessage}` : "",
    transcript ? "Если нужен точный ответ, посмотрите историю заявки в сообщении выше." : ""
  ].filter(Boolean);

  return parts.join(" ");
}
