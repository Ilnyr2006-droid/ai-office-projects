import {
  getChatMessages,
  mergeChatMessages,
  normalizeMessages,
  saveChatMessages
} from "./chat-memory.ts";
import { getCatalog, searchCatalog } from "./database.ts";
import { getWorkOnlyRefusalMessage, isWorkOnlyRequestAllowed } from "./domain-guard.ts";
import { generateSellerReply } from "./openai.ts";
import type {
  AttachmentProductsParams,
  CandidateFilters,
  CatalogProduct,
  ChatMessage,
  PreviousPhotoLookupParams,
  ProcessChatMessagesInput,
  ProcessChatMessagesResult,
  ProductAttachment,
  SellerReplyGenerationResult
} from "./chat-types.ts";

/**
 * @param {ProcessChatMessagesInput} input
 * @returns {Promise<ProcessChatMessagesResult>}
 */
export async function processChatMessages({
  chatId = "",
  messages
}: ProcessChatMessagesInput): Promise<ProcessChatMessagesResult> {
  const normalizedChatId = String(chatId || "").trim();
  const incomingMessages = normalizeMessages(messages);
  const storedMessages = normalizedChatId ? await getChatMessages(normalizedChatId) : [];
  const normalizedMessages = normalizedChatId
    ? mergeChatMessages(storedMessages, incomingMessages)
    : incomingMessages;

  if (normalizedMessages.length === 0) {
    throw new Error("messages is empty");
  }

  const latestUserMessage = getLatestUserMessage(normalizedMessages);
  const canSendProductPhotos = shouldAllowProductPhotos(latestUserMessage, normalizedMessages);
  const generationResult = (await isChatRequestAllowed(normalizedMessages))
    ? await generateSellerReply(normalizedMessages, {
        canSendProductPhotos
      })
    : { reply: getWorkOnlyRefusalMessage(), topProducts: [], relevantProducts: [] };
  const attachmentProducts = await resolveAttachmentProducts({
    message: latestUserMessage,
    messages: normalizedMessages,
    generationResult
  });
  const attachments = shouldAttachProductPhotos({
    message: latestUserMessage,
    reply: generationResult.reply,
    products: attachmentProducts,
    messages: normalizedMessages
  })
    ? buildProductAttachments(attachmentProducts, generationResult.reply)
    : [];
  const reply = sanitizeReplyForAttachments(generationResult.reply, attachments);
  const updatedMessages: ChatMessage[] = [
    ...normalizedMessages,
    { role: "assistant", content: reply }
  ];

  if (normalizedChatId) {
    await saveChatMessages(normalizedChatId, updatedMessages);
  }

  return {
    reply,
    attachments,
    chatId: normalizedChatId || null,
    messages: updatedMessages
  };
}

/**
 * @param {ChatMessage[]} messages
 * @returns {string}
 */
function getLatestUserMessage(messages) {
  return [...messages].reverse().find((message) => message.role === "user")?.content || "";
}

/**
 * @param {ChatMessage[]} messages
 * @param {string} message
 * @returns {ChatMessage[]}
 */
function getPreviousMessages(messages, message) {
  const list = Array.isArray(messages) ? messages : [];
  let currentIndex = -1;

  for (let index = list.length - 1; index >= 0; index -= 1) {
    const item = list[index];

    if (item?.role === "user" && String(item?.content || "") === String(message || "")) {
      currentIndex = index;
      break;
    }
  }

  return list.slice(0, currentIndex >= 0 ? currentIndex : list.length);
}

/**
 * @param {string} message
 * @param {ChatMessage[]} messages
 * @returns {boolean}
 */
function hasImplicitPhotoFollowUpIntent(message, messages) {
  const normalizedMessage = normalizeForMatching(message);

  if (!normalizedMessage || hasExplicitPhotoIntent(message)) {
    return false;
  }

  if (!/^(все|все из списка|из списка|все варианты|все сразу|все фото|оба|обе|оба варианта|обе позиции|все позиции)$/i.test(normalizedMessage)) {
    return false;
  }

  const previousMessages = getPreviousMessages(messages, message);
  const previousUserMessage = [...previousMessages]
    .reverse()
    .find((item) => item?.role === "user" && String(item?.content || "").trim());
  const previousAssistantMessage = [...previousMessages]
    .reverse()
    .find((item) => item?.role === "assistant" && String(item?.content || "").trim());

  if (!previousUserMessage || !previousAssistantMessage) {
    return false;
  }

  return (
    hasExplicitPhotoIntent(previousUserMessage.content) &&
    isClarifyingOnlyReply(previousAssistantMessage.content)
  );
}

/**
 * @param {AttachmentProductsParams} params
 * @returns {Promise<CatalogProduct[]>}
 */
async function resolveAttachmentProducts({ message, messages, generationResult }) {
  if (hasExplicitPhotoIntent(message) || hasImplicitPhotoFollowUpIntent(message, messages)) {
    const explicitPhotoProducts = await findExplicitPhotoProducts({
      message,
      messages
    });

    if (explicitPhotoProducts.length > 0) {
      return explicitPhotoProducts;
    }
  }

  if (Array.isArray(generationResult.relevantProducts) && generationResult.relevantProducts.length > 0) {
    return generationResult.relevantProducts;
  }

  return Array.isArray(generationResult.topProducts) ? generationResult.topProducts : [];
}

/**
 * @param {{ message: string, messages: ChatMessage[] }} params
 * @returns {Promise<CatalogProduct[]>}
 */
async function findExplicitPhotoProducts({ message, messages }) {
  const [directMatches, recentConversationProducts] = await Promise.all([
    findProductsFromMessage(message),
    findRecentConversationProducts(messages)
  ]);
  const requestedOptionNumber = extractRequestedOptionNumber(message);
  const wantsAlternativeOption = refersToAlternativeRecentOption(message);

  if (
    requestedOptionNumber > 0 &&
    requestedOptionNumber <= recentConversationProducts.length
  ) {
    return [recentConversationProducts[requestedOptionNumber - 1]];
  }

  if (wantsAlternativeOption && recentConversationProducts.length > 1) {
    const previousReferencedProduct = await findPreviousExplicitPhotoProduct({
      message,
      messages,
      recentConversationProducts
    });

    if (previousReferencedProduct) {
      const previousKey = getProductIdentityKey(previousReferencedProduct);
      const alternativeProduct = recentConversationProducts.find(
        (product) => getProductIdentityKey(product) !== previousKey
      );

      if (alternativeProduct) {
        return [alternativeProduct];
      }
    }
  }

  if (directMatches.length > 0 && recentConversationProducts.length > 0) {
    const recentNames = new Set(
      recentConversationProducts
        .map((product) => getProductIdentityKey(product))
        .filter(Boolean)
    );
    const intersectedMatches = directMatches.filter((product) =>
      recentNames.has(getProductIdentityKey(product))
    );

    if (intersectedMatches.length > 0) {
      return intersectedMatches;
    }
  }

  if (recentConversationProducts.length > 0) {
    return recentConversationProducts;
  }

  return directMatches;
}

/**
 * @param {string} message
 * @returns {Promise<CatalogProduct[]>}
 */
async function findProductsFromMessage(message) {
  const catalog = await getCatalog().catch(() => null);
  const products = Array.isArray(catalog?.products) ? catalog.products : [];
  const normalizedMessage = normalizeForMatching(message);
  const productQuery = extractPhotoProductQuery(message);
  const explicitCandidates = extractProductCandidates(message);

  if (explicitCandidates.length > 0) {
    const resolvedCandidates = resolveCatalogProductsByCandidates(products, explicitCandidates);

    if (resolvedCandidates.length > 0) {
      return resolvedCandidates.slice(0, 3);
    }
  }

  if (!normalizedMessage || !productQuery || productQuery.length < 3) {
    return [];
  }

  const queryTokens = productQuery.split(" ").filter((token) => token.length >= 3);

  if (queryTokens.length === 0) {
    return [];
  }

  return products
    .map((product) => {
      const name = normalizeForMatching(product?.name);
      const photo = getProductPhotoUrl(product);

      if (!name || !photo) {
        return null;
      }

      let score = 0;

      if (normalizedMessage.includes(name)) {
        score += 20;
      }

      if (name.includes(productQuery)) {
        score += 12;
      }

      if (productQuery.includes(name)) {
        score += 8;
      }

      for (const token of queryTokens) {
        if (name.includes(token)) {
          score += token.length >= 5 ? 4 : 2;
        }
      }

      return score > 0 ? { product, score, nameLength: name.length } : null;
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score || right.nameLength - left.nameLength)
    .map((match) => match.product)
    .slice(0, 3);
}

/**
 * @param {ChatMessage[]} messages
 * @returns {Promise<CatalogProduct[]>}
 */
async function findRecentConversationProducts(messages) {
  const assistantMessages = [...(Array.isArray(messages) ? messages : [])]
    .reverse()
    .filter((message) => message?.role === "assistant" && String(message?.content || "").trim());

  if (assistantMessages.length === 0) {
    return [];
  }

  const catalog = await getCatalog().catch(() => null);
  const products = Array.isArray(catalog?.products) ? catalog.products : [];
  const matches = [];
  const seen = new Set();

  for (const message of assistantMessages) {
    const normalizedContent = normalizeForMatching(message.content);

    if (!normalizedContent) {
      continue;
    }

    const structuredCandidates = extractStructuredProductCandidates(message.content);

    if (structuredCandidates.length > 0) {
      const resolvedStructuredCandidates = resolveCatalogProductsByCandidates(
        products,
        structuredCandidates
      );

      for (const product of resolvedStructuredCandidates) {
        const dedupeKey = getProductIdentityKey(product);

        if (!dedupeKey || seen.has(dedupeKey)) {
          continue;
        }

        seen.add(dedupeKey);
        matches.push(product);

        if (matches.length >= 3) {
          return matches;
        }
      }

      if (resolvedStructuredCandidates.length > 0) {
        return matches;
      }
    }

    const explicitCandidates = extractProductCandidates(message.content);

    if (explicitCandidates.length > 0) {
      const resolvedCandidates = resolveCatalogProductsByCandidates(products, explicitCandidates);

      for (const product of resolvedCandidates) {
        const dedupeKey = getProductIdentityKey(product);

        if (!dedupeKey || seen.has(dedupeKey)) {
          continue;
        }

        seen.add(dedupeKey);
        matches.push(product);

        if (matches.length >= 3) {
          return matches;
        }
      }

      if (resolvedCandidates.length > 0) {
        return matches;
      }
    }

    const matchedProducts = products
      .map((product) => {
        const name = normalizeForMatching(product?.name);
        const photo = getProductPhotoUrl(product);
        const index = findProductMentionIndex(product, normalizedContent);

        if (!name || !photo || index < 0) {
          return null;
        }

        return {
          product,
          index,
          nameLength: name.length
        };
      })
      .filter(Boolean)
      .sort((left, right) => left.index - right.index || right.nameLength - left.nameLength);

    for (const match of matchedProducts) {
      const dedupeKey = getProductIdentityKey(match.product);

      if (!dedupeKey || seen.has(dedupeKey)) {
        continue;
      }

      seen.add(dedupeKey);
      matches.push(match.product);

      if (matches.length >= 3) {
        return matches;
      }
    }
  }

  return matches;
}

/**
 * @param {CatalogProduct[]} products
 * @param {string=} reply
 * @returns {ProductAttachment[]}
 */
function buildProductAttachments(products, reply = "") {
  const list = Array.isArray(products) ? products : [];
  const seen = new Set();
  const prioritizedProducts = prioritizeProductsForReply(list, reply);

  return prioritizedProducts
    .map((product): ProductAttachment | null => {
      const photoUrl = getProductPhotoUrl(product);

      if (!photoUrl || seen.has(photoUrl)) {
        return null;
      }

      seen.add(photoUrl);

      return {
        type: "image",
        url: photoUrl,
        name: String(product?.name || "").trim(),
        category: String(product?.category || "").trim(),
        price: getProductPriceLabel(product),
        colors: Array.isArray(product?.colors)
          ? product.colors.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 3)
          : [],
        applications: Array.isArray(product?.applications)
          ? product.applications.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 2)
          : [],
        thickness: String(product?.thickness || "").trim(),
        materialType: String(product?.materialType || "").trim(),
        leatherType: String(product?.leatherType || "").trim(),
        stock: String(product?.stock || "").trim()
      };
    })
    .filter(Boolean)
    .slice(0, prioritizedProducts.length > 1 ? 3 : 1);
}

/**
 * @param {CatalogProduct | null | undefined} product
 * @returns {string}
 */
function getProductPriceLabel(product) {
  const pricing =
    product?.pricing && typeof product.pricing === "object" ? product.pricing : null;
  const fromText = String(pricing?.fromText || product?.priceFrom || "").trim();

  if (fromText) {
    return fromText;
  }

  const value = Number(pricing?.from ?? product?.priceFromValue);
  const unit = String(pricing?.unit || product?.unit || "").trim();
  const currency = String(pricing?.currency || "").trim().toUpperCase();
  const approximateMarker = pricing?.approximate ? "~" : "";

  if (!Number.isFinite(value) || value <= 0) {
    return "";
  }

  const amount = Number.isInteger(value) ? String(value) : value.toFixed(2);
  const money = currency === "RUB" ? `${approximateMarker}${amount} руб.` : `${approximateMarker}${amount}`;
  return unit ? `от ${money} / ${unit}` : `от ${money}`;
}

/**
 * @param {CatalogProduct | null | undefined} product
 * @returns {string}
 */
function getProductPhotoUrl(product) {
  const directPhoto = extractFirstPhotoUrl(product?.photo);

  if (directPhoto) {
    return directPhoto;
  }

  const photos = Array.isArray(product?.photos) ? product.photos : [];
  const firstPhoto = photos.map((item) => extractFirstPhotoUrl(item)).find(Boolean);

  if (firstPhoto) {
    return firstPhoto;
  }

  const mediaPhoto = Array.isArray(product?.media)
    ? product.media
        .map((item) =>
          String(item?.type || "").trim().toLowerCase() === "image"
            ? extractFirstPhotoUrl(item?.url)
            : ""
        )
        .find(Boolean)
    : "";

  return mediaPhoto || "";
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function extractFirstPhotoUrl(value) {
  const text = String(value || "").trim();

  if (!text) {
    return "";
  }

  const urlMatch = text.match(/https?:\/\/\S+/i);
  return urlMatch ? urlMatch[0].trim() : "";
}

/**
 * @param {string} reply
 * @param {ProductAttachment[]} attachments
 * @returns {string}
 */
function sanitizeReplyForAttachments(reply, attachments) {
  const text = String(reply || "").trim();

  if (!text) {
    return "Не удалось получить ответ.";
  }

  const cleaned = text
    .replace(
      /к сожалению,\s*я не могу\s+(?:отправить|прислать|предоставить)\s+(?:фотографии товаров|фотографии|изображения|изображение|фото)\.?\s*/gi,
      ""
    )
    .replace(
      /\bя\s+(?:не\s+могу|не\s+умею)\s+(?:отправить|прислать|показать|предоставить)\s+(?:фотографии|изображения|изображение|фото)[^.!\n]*[.!]?\s*/gi,
      ""
    )
    .replace(
      /(?:однако,\s*)?(?:вы можете|рекомендую)\s*обрат(?:ить(?:ся)?|иться)\s+к\s+менеджеру\s+для\s+получения\s+(?:изображения|изображений|фотографии|фотографий)(?:\s+товара)?(?:\s+и\s+дополнительной\s+информации\s+о\s+товаре)?\.?\s*/gi,
      ""
    )
    .replace(
      /(?:^|\s)(?:сейчас|я)\s+(?:отправлю|пришлю|скину)\s+(?:вам\s+)?(?:фото|фотографии|изображения)[^.!\n]*[.!]?\s*/gi,
      Array.isArray(attachments) && attachments.length > 0 ? "Ниже отправляю фото. " : ""
    )
    .replace(
      /пожалуйста,\s*подождите(?:\s*(?:немного|чуть-чуть))?[.!]?\s*/gi,
      ""
    )
    .replace(
      /если\s+хотите,\s*я?\s*могу\s+(?:предоставить\s+контактные\s+данные\s+менеджера|передать\s+ваши\s+контактные\s+данные\s+менеджеру(?:,\s*чтобы\s+он\s+связался\s+с\s+вами\s+и\s+предоставил\s+необходимую\s+информацию)?)\.?\s*/gi,
      ""
    )
    .replace(/^\s*(однако|если хотите)[,.]?\s*/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (cleaned) {
    return cleaned;
  }

  if (Array.isArray(attachments) && attachments.length > 0) {
    return "Ниже отправляю фото товара.";
  }

  return "Уточните название, цвет или назначение материала, и я подберу подходящий вариант.";
}

/**
 * @param {ChatMessage[]} messages
 * @returns {Promise<boolean>}
 */
async function isChatRequestAllowed(messages) {
  if (isWorkOnlyRequestAllowed(messages)) {
    return true;
  }

  const latestUserMessage =
    [...messages].reverse().find((message) => message.role === "user")?.content || "";

  if (!looksLikeCatalogLookup(latestUserMessage)) {
    return false;
  }

  const catalog = await searchCatalog(latestUserMessage, 1);
  return Array.isArray(catalog?.products) && catalog.products.length > 0;
}

/**
 * @param {string} message
 * @param {ChatMessage[]=} messages
 * @returns {boolean}
 */
function shouldAllowProductPhotos(message, messages = []) {
  const text = String(message || "").trim();

  if (!text) {
    return false;
  }

  if (looksLikeGreeting(text)) {
    return false;
  }

  const hasPhotoIntent =
    hasExplicitPhotoIntent(text) || hasImplicitPhotoFollowUpIntent(text, messages);

  return hasPhotoIntent || looksLikeCatalogLookup(text) || looksLikeRecommendationRequest(text);
}

/**
 * @param {{ message: string, reply: string, products: CatalogProduct[], messages?: ChatMessage[] }} params
 * @returns {boolean}
 */
function shouldAttachProductPhotos({ message, reply, products, messages = [] }) {
  const photoAllowedByMessage = shouldAllowProductPhotos(message, messages);
  const explicitPhotoIntent =
    hasExplicitPhotoIntent(message) || hasImplicitPhotoFollowUpIntent(message, messages);
  const mentionedProducts = findProductsMentionedInReply(products, reply);
  const hasProductRecommendationReply = looksLikeProductRecommendationReply(reply);

  if (looksLikeGreeting(message)) {
    return false;
  }

  if (explicitPhotoIntent) {
    return Array.isArray(products) && products.length > 0;
  }

  if (!photoAllowedByMessage || !looksLikeRecommendationRequest(message)) {
    return false;
  }

  if (isClarifyingOnlyReply(reply)) {
    return false;
  }

  if (mentionedProducts.length === 0 && !hasProductRecommendationReply) {
    return false;
  }

  return mentionedProducts.length >= 2 || hasProductRecommendationReply;
}

/**
 * @param {string} message
 * @returns {boolean}
 */
function hasExplicitPhotoIntent(message) {
  const normalized = String(message || "")
    .toLowerCase()
    .replace(/ё/g, "е");

  return /(^|\s)(фото|фотку|фотки|фотографи(?:я|и|ю|ей|ям|ями|ях)|изображени(?:е|я|й|ям|ями|ях)|картинк(?:а|и|у|е|ой|ами|ах)?|покажи|показать|show photo|photo|image)(\s|$|\?)/i.test(
    normalized
  );
}

/**
 * @param {string} message
 * @returns {string}
 */
function extractPhotoProductQuery(message) {
  return normalizeForMatching(
    String(message || "")
      .replace(
        /\b(пришли|пришлите|пришлика|пришщли|отправь|отправьте|скинь|скиньте|сбрось|покажи|показать|можно|пожалуйста|фото|фотку|фотки|фотография|фотографии|изображение|изображения|картинку|картинки|photo|image|show)\b/gi,
        " "
      )
      .replace(/[?"'`]+/g, " ")
  );
}

/**
 * @param {string} message
 * @returns {boolean}
 */
function looksLikeCatalogLookup(message) {
  const text = String(message || "").trim();

  if (!text || text.length > 120) {
    return false;
  }

  const normalized = text.toLowerCase().replace(/ё/g, "е");
  const tokenCount = normalized.split(/\s+/).filter(Boolean).length;
  const hasLatin = /[a-z]/i.test(normalized);
  const hasPriceIntent =
    /(^|\s)(цен|сколько|стоим|почем|price|cost|how much)(\s|$|\?)/i.test(normalized);

  if (hasPriceIntent && hasLatin) {
    return true;
  }

  return hasLatin && tokenCount <= 6;
}

/**
 * @param {string} message
 * @returns {boolean}
 */
function looksLikeRecommendationRequest(message) {
  const text = String(message || "").trim();

  if (!text || text.length > 280) {
    return false;
  }

  const normalized = text.toLowerCase().replace(/ё/g, "е");

  if (
    /(^|\s)(доставк|оплат|самовывоз|срок|наличи|адрес|контакт|телефон|менеджер)(\s|$|\?)/i.test(
      normalized
    )
  ) {
    return false;
  }

  return /(^|\s)(подобрат|вариант|какой|какая|какие|нужн|ищу|для|куртк|сумк|обув|диван|мебел|салон|ремень|кошелек|пошив|одежд)(\s|$|\?)/i.test(
    normalized
  );
}

/**
 * @param {CatalogProduct[]} products
 * @param {string=} reply
 * @returns {CatalogProduct[]}
 */
function prioritizeProductsForReply(products, reply = "") {
  const list = Array.isArray(products) ? products : [];
  const normalizedReply = normalizeForMatching(reply);

  if (!normalizedReply) {
    return list;
  }

  const mentioned = list.filter((product) => {
    return findProductMentionIndex(product, normalizedReply) >= 0;
  });

  return mentioned.length > 0 ? mentioned : list;
}

/**
 * @param {CatalogProduct[]} products
 * @param {string=} reply
 * @returns {CatalogProduct[]}
 */
function findProductsMentionedInReply(products, reply = "") {
  const list = Array.isArray(products) ? products : [];
  const normalizedReply = normalizeForMatching(reply);

  if (!normalizedReply) {
    return [];
  }

  return list.filter((product) => {
    return findProductMentionIndex(product, normalizedReply) >= 0;
  });
}

/**
 * @param {CatalogProduct} product
 * @param {string=} normalizedContent
 * @returns {number}
 */
function findProductMentionIndex(product, normalizedContent = "") {
  const content = String(normalizedContent || "").trim();
  const name = normalizeForMatching(product?.name);

  if (!content || !name) {
    return -1;
  }

  const exactIndex = content.indexOf(name);

  if (exactIndex >= 0) {
    return exactIndex;
  }

  const nameTokens = getSignificantNameTokens(name);

  if (nameTokens.length === 0) {
    return -1;
  }

  const matchedPositions = nameTokens
    .map((token) => content.indexOf(token))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right);

  const minimumTokenMatches = Math.min(nameTokens.length, nameTokens.length >= 3 ? 2 : 1);

  if (matchedPositions.length < minimumTokenMatches) {
    return -1;
  }

  return matchedPositions[0];
}

/**
 * @param {string} name
 * @returns {string[]}
 */
function getSignificantNameTokens(name) {
  return String(name || "")
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 4)
    .filter((token) => !PRODUCT_NAME_STOP_WORDS.has(token));
}

/**
 * @param {string} text
 * @returns {string[]}
 */
function extractProductCandidates(text) {
  const source = String(text || "");

  if (!source.trim()) {
    return [];
  }

  const candidates = [];
  const seen = new Set();
  const addCandidate = (value) => {
    const cleaned = String(value || "")
      .replace(/^\d+\.\s*/g, "")
      .replace(/\s+/g, " ")
      .trim();
    const normalized = normalizeForMatching(cleaned);

    if (!normalized || normalized.length < 3 || seen.has(normalized)) {
      return;
    }

    seen.add(normalized);
    candidates.push(cleaned);
  };

  for (const match of source.matchAll(/\*\*([^*]+)\*\*/g)) {
    addCandidate(match[1]);
  }

  for (const match of source.matchAll(/(?:^|\n)\s*\d+\.\s*([^\n:.-][^\n]*?)(?=\s*(?:[:\-]|$))/g)) {
    addCandidate(match[1]);
  }

  const cleanedSource = String(text || "")
    .replace(
      /\b(пришли|пришлите|пришлика|пришщли|отправь|отправьте|скинь|скиньте|сбрось|покажи|показать|можно|пожалуйста|фото|фотку|фотки|фотография|фотографии|изображение|изображения|картинку|картинки|photo|image|show)\b/gi,
      " "
    )
    .replace(
      /\b(вариант|варианта|варианту|вариантом|варианте|номер|номером|другого|другой|другую|другои)\b/gi,
      " "
    )
    .replace(/\b\d+(?:-?(?:й|я|ое))?\b/g, " ")
    .replace(/[?"'`]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (cleanedSource) {
    addCandidate(cleanedSource);
  }

  return candidates;
}

/**
 * @param {string} text
 * @returns {string[]}
 */
function extractStructuredProductCandidates(text) {
  const source = String(text || "");

  if (!source.trim()) {
    return [];
  }

  const blocks = source.match(/(?:^|\n)\s*\d+\.\s[\s\S]*?(?=(?:\n\s*\d+\.\s)|$)/g) || [];
  const candidates = [];
  const seen = new Set();

  for (const block of blocks) {
    const normalizedBlock = normalizeForMatching(block);

    if (!normalizedBlock) {
      continue;
    }

    const titleMatch = block.match(/\*\*([^*]+)\*\*/);
    const fallbackMatch = block.match(/^\s*\d+\.\s*([^\n:]+)/m);
    const title = String(titleMatch?.[1] || fallbackMatch?.[1] || "")
      .replace(/\s+/g, " ")
      .trim();
    const colorMatch = block.match(/(?:^|\n)\s*[-*]?\s*цвет\s*:\s*([^\n]+)/i);
    const color = String(colorMatch?.[1] || "")
      .replace(/\s+/g, " ")
      .trim();
    const candidate = color ? `${title}\nЦвет: ${color}` : title;
    const normalizedCandidate = normalizeForMatching(candidate);

    if (!normalizedCandidate || normalizedCandidate.length < 3 || seen.has(normalizedCandidate)) {
      continue;
    }

    seen.add(normalizedCandidate);
    candidates.push(candidate);
  }

  return candidates;
}

/**
 * @param {CatalogProduct[]} products
 * @param {string[]} candidates
 * @returns {CatalogProduct[]}
 */
function resolveCatalogProductsByCandidates(products, candidates) {
  const list = Array.isArray(products) ? products : [];
  const result = [];
  const seen = new Set();

  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const match = findBestCatalogProductMatch(list, candidate);
    const dedupeKey = getProductIdentityKey(match);

    if (!match || !dedupeKey || seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    result.push(match);
  }

  return result;
}

/**
 * @param {CatalogProduct[]} products
 * @param {string} candidate
 * @returns {CatalogProduct | null}
 */
function findBestCatalogProductMatch(products, candidate) {
  const normalizedCandidate = normalizeForMatching(candidate);
  const candidateFilters = extractCandidateProductFilters(candidate);

  if (!normalizedCandidate) {
    return null;
  }

  const exactMatch = products.find((product) => {
    const name = normalizeForMatching(product?.name);
    return name && name === normalizedCandidate && getProductPhotoUrl(product);
  });

  if (exactMatch) {
    return exactMatch;
  }

  const candidateTokens = getSignificantNameTokens(normalizedCandidate);
  const rankedMatches = products
    .map((product) => {
      const name = normalizeForMatching(product?.name);
      const photo = getProductPhotoUrl(product);

      if (!name || !photo || !productMatchesCandidateFilters(product, candidateFilters)) {
        return null;
      }

      let score = 0;

      if (name.includes(normalizedCandidate)) {
        score += 20;
      }

      if (normalizedCandidate.includes(name)) {
        score += 12;
      }

      const nameTokens = getSignificantNameTokens(name);
      const overlappingTokens = candidateTokens.filter((token) => nameTokens.includes(token));

      if (overlappingTokens.length > 0) {
        score += overlappingTokens.reduce((sum, token) => sum + (token.length >= 5 ? 4 : 2), 0);
      }

      const minimumTokenMatches = getMinimumCandidateTokenMatches(candidateTokens, candidateFilters);

      if (candidateTokens.length > 0 && overlappingTokens.length < minimumTokenMatches) {
        return null;
      }

      return score > 0
        ? {
            product,
            score,
            nameLength: name.length
          }
        : null;
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score || right.nameLength - left.nameLength);

  return rankedMatches[0]?.product || null;
}

/**
 * @param {string} candidate
 * @returns {CandidateFilters}
 */
function extractCandidateProductFilters(candidate) {
  const explicitColorSource = String(candidate || "").match(/цвет\s*:\s*([^\n,]+)/i)?.[1] || "";
  const colorSource = explicitColorSource || String(candidate || "");
  const normalizedCandidate = normalizeForMatching(candidate);

  if (!normalizedCandidate) {
    return { colors: [] };
  }

  return {
    colors: extractColorHints(colorSource)
  };
}

/**
 * @param {string[]} candidateTokens
 * @param {CandidateFilters} filters
 * @returns {number}
 */
function getMinimumCandidateTokenMatches(candidateTokens, filters) {
  const tokenCount = Array.isArray(candidateTokens) ? candidateTokens.length : 0;
  const hasAttributeFilters = (Array.isArray(filters?.colors) ? filters.colors : []).length > 0;

  if (tokenCount === 0) {
    return 0;
  }

  if (hasAttributeFilters) {
    return 1;
  }

  return Math.min(tokenCount, 2);
}

/**
 * @param {CatalogProduct} product
 * @param {CandidateFilters} filters
 * @returns {boolean}
 */
function productMatchesCandidateFilters(product, filters) {
  const requestedColors = Array.isArray(filters?.colors) ? filters.colors : [];

  if (requestedColors.length === 0) {
    return true;
  }

  const productColors = extractProductColors(product);

  return requestedColors.every((color) => productColors.has(color));
}

/**
 * @param {CatalogProduct} product
 * @returns {Set<string>}
 */
function extractProductColors(product) {
  const values = [
    ...(Array.isArray(product?.colors) ? product.colors : []),
    ...(Array.isArray(product?.attributes?.colors) ? product.attributes.colors : [])
  ];
  const colorSet = new Set();

  for (const value of values) {
    for (const color of extractColorHints(value)) {
      colorSet.add(color);
    }
  }

  return colorSet;
}

/**
 * @param {CatalogProduct | null | undefined} product
 * @returns {string}
 */
function getProductIdentityKey(product) {
  if (!product) {
    return "";
  }

  const name = normalizeForMatching(product?.name);
  const colors = [...extractProductColors(product)].sort().join("|");
  const photo = getProductPhotoUrl(product);

  return [name, colors, photo].filter(Boolean).join("::");
}

/**
 * @param {string} message
 * @returns {number}
 */
function extractRequestedOptionNumber(message) {
  const normalized = String(message || "")
    .toLowerCase()
    .replace(/ё/g, "е");
  const variantPattern =
    "(?:вариант|варианта|варианту|вариантом|варианте|номер|номера|номеру|номером|номере)";

  if (!normalized || !(new RegExp(`(^|\\s)${variantPattern}(\\s|$)`).test(normalized))) {
    return 0;
  }

  const match =
    normalized.match(new RegExp(`(?:^|\\s)${variantPattern}\\s*№?\\s*(\\d+)(?:\\s|$)`)) ||
    normalized.match(new RegExp(`(?:^|\\s)(\\d+)(?:-?й|-?я|-?ое)?\\s+${variantPattern}(?:\\s|$)`)) ||
    normalized.match(/(?:^|\s)№\s*(\d+)(?:\s|$)/);

  return Number.parseInt(match?.[1] || "", 10) || 0;
}

/**
 * @param {string} message
 * @returns {boolean}
 */
function refersToAlternativeRecentOption(message) {
  const normalized = normalizeForMatching(message);

  if (!normalized) {
    return false;
  }

  return (
    /(^|\s)друг(ого|ой|ую|ои)(\s|$)/.test(normalized) &&
    /(^|\s)вариант(?:а|у|ом|е)?(\s|$)/.test(normalized)
  );
}

/**
 * @param {PreviousPhotoLookupParams} params
 * @returns {Promise<CatalogProduct | null>}
 */
async function findPreviousExplicitPhotoProduct({ message, messages, recentConversationProducts }) {
  const list = Array.isArray(messages) ? messages : [];
  let currentIndex = -1;

  for (let index = list.length - 1; index >= 0; index -= 1) {
    const item = list[index];

    if (item?.role === "user" && String(item?.content || "") === String(message || "")) {
      currentIndex = index;
      break;
    }
  }

  const previousUserMessages = list
    .slice(0, currentIndex >= 0 ? currentIndex : list.length)
    .filter((item) => item?.role === "user" && hasExplicitPhotoIntent(item?.content))
    .reverse();

  for (const previousMessage of previousUserMessages) {
    const optionNumber = extractRequestedOptionNumber(previousMessage.content);

    if (optionNumber > 0 && optionNumber <= recentConversationProducts.length) {
      return recentConversationProducts[optionNumber - 1];
    }

    const directMatches = await findProductsFromMessage(previousMessage.content);

    if (directMatches.length === 0) {
      continue;
    }

    const recentKeys = new Set(recentConversationProducts.map((product) => getProductIdentityKey(product)));
    const intersectedMatch = directMatches.find((product) => recentKeys.has(getProductIdentityKey(product)));

    if (intersectedMatch) {
      return intersectedMatch;
    }
  }

  return null;
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function extractColorHints(value) {
  const normalized = normalizeForMatching(value);

  if (!normalized) {
    return [];
  }

  return PRODUCT_COLOR_ALIASES.filter(([, aliases]) =>
    aliases.some((alias) => normalized.includes(alias))
  ).map(([color]) => color);
}

/**
 * @param {string=} reply
 * @returns {boolean}
 */
function isClarifyingOnlyReply(reply = "") {
  const normalized = normalizeForMatching(reply);

  if (!normalized) {
    return false;
  }

  const clarificationSignals = [
    "какой тип кожи",
    "какая кожа",
    "натуральная кожа или экокожа",
    "уточните",
    "предпочитаемый цвет",
    "предпочитаемыи цвет",
    "толщина материала",
    "какой цвет",
    "какая толщина",
    "какой материал"
  ];

  return clarificationSignals.some((signal) => normalized.includes(signal));
}

/**
 * @param {string=} reply
 * @returns {boolean}
 */
function looksLikeProductRecommendationReply(reply = "") {
  const text = String(reply || "").trim();
  const normalized = normalizeForMatching(text);

  if (!normalized) {
    return false;
  }

  if (/^\s*\d+\.\s*\*\*.+?\*\*:/m.test(text)) {
    return true;
  }

  const recommendationSignals = [
    "могу предложить несколько вариантов",
    "есть несколько подходящих вариантов",
    "вот несколько подходящих вариантов",
    "подходящие варианты кожи",
    "варианты кожи для"
  ];

  if (recommendationSignals.some((signal) => normalized.includes(signal))) {
    return true;
  }

  let detailSignalCount = 0;

  if (/(^|\s)(цена|стоимость)(\s|:)/i.test(text)) {
    detailSignalCount += 1;
  }

  if (/(^|\s)(толщина)(\s|:)/i.test(text)) {
    detailSignalCount += 1;
  }

  if (/(^|\s)(цвет)(\s|:)/i.test(text)) {
    detailSignalCount += 1;
  }

  return detailSignalCount >= 2;
}

/**
 * @param {string} message
 * @returns {boolean}
 */
function looksLikeGreeting(message) {
  const normalized = String(message || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .trim();

  if (!normalized) {
    return false;
  }

  return [
    "привет",
    "здравствуйте",
    "добрый день",
    "добрый вечер",
    "доброе утро",
    "салам",
    "hello",
    "hi"
  ].some((greeting) => normalized === greeting || normalized.startsWith(`${greeting} `));
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeForMatching(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** @type {Set<string>} */
const PRODUCT_NAME_STOP_WORDS = new Set([
  "кожа",
  "материал",
  "дубленочный",
  "дубленочная",
  "натуральная",
  "овчина",
  "кожаи"
]);

/** @type {[string, string[]][]} */
const PRODUCT_COLOR_ALIASES: Array<[string, string[]]> = [
  ["черный", ["черный", "черная", "черное", "черные", "black"]],
  ["коричневый", ["коричневый", "коричневая", "коричневое", "коричневые", "brown"]],
  ["бежевый", ["бежевый", "бежевая", "бежевое", "бежевые", "beige"]],
  ["серый", ["серый", "серая", "серое", "серые", "grey", "gray"]],
  ["белый", ["белый", "белая", "белое", "белые", "white"]],
  ["синий", ["синий", "синяя", "синее", "синие", "blue"]],
  ["красный", ["красный", "красная", "красное", "красные", "red"]],
  ["зеленый", ["зеленый", "зеленая", "зеленое", "зеленые", "green"]]
];
