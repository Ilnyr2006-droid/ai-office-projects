const WORK_KEYWORDS = [
  "кожа",
  "экокожа",
  "натурал",
  "кож",
  "шкура",
  "спилок",
  "велюр",
  "замша",
  "наппа",
  "краст",
  "флотер",
  "сумк",
  "рюкзак",
  "аксессуар",
  "обув",
  "куртк",
  "одежд",
  "дублен",
  "головн",
  "мех",
  "фурнитур",
  "материал",
  "сырь",
  "толщин",
  "цвет",
  "образец",
  "образцу",
  "парти",
  "опт",
  "заказ",
  "пошив",
  "производ",
  "лекал",
  "доставк",
  "оплат",
  "самовывоз",
  "склад",
  "офис",
  "адрес",
  "москва",
  "сдэк",
  "цен",
  "стоим",
  "налич",
  "каталог",
  "менеджер",
  "контакт",
  "телефон",
  "рауль",
  "эмилия",
  "элхан",
  "озелиф",
  "компан"
];

const STRONG_OFFTOPIC_KEYWORDS = [
  "python",
  "питон",
  "javascript",
  "js",
  "typescript",
  "java",
  "c++",
  "c#",
  "php",
  "html",
  "css",
  "sql",
  "excel",
  "формула",
  "калькулятор",
  "программ",
  "напиши код",
  "код на",
  "скрипт",
  "алгоритм"
];

const FOLLOW_UP_HINTS = [
  "а если",
  "а еще",
  "а ещё",
  "тогда",
  "подойдет",
  "подойдёт",
  "есть ли",
  "сколько",
  "какая",
  "какой",
  "какие",
  "нужно",
  "подскажите",
  "хочу",
  "интересует",
  "и желательно",
  "можно",
  "нужна",
  "нужен",
  "нужны"
];

const GREETING_PATTERNS = [
  "привет",
  "здравствуйте",
  "добрый день",
  "добрый вечер",
  "доброе утро",
  "салам",
  "hello",
  "hi"
];

export function isWorkOnlyRequestAllowed(messages: any[] = []) {
  const normalizedMessages = Array.isArray(messages) ? messages : [];
  const latestUserMessage =
    [...normalizedMessages].reverse().find((message) => message.role === "user")?.content || "";
  const latestText = normalizeText(latestUserMessage);

  if (!latestText) {
    return true;
  }

  if (containsWorkKeywords(latestText)) {
    return true;
  }

  if (isGreeting(latestText)) {
    return true;
  }

  if (containsStrongOfftopicKeywords(latestText)) {
    return false;
  }

  return isWorkFollowUp(normalizedMessages, latestText);
}

export function getWorkOnlyRefusalMessage() {
  return [
    "Помогу по вопросам компании «Озелиф кожа»: подбор кожи и материалов, пошив, опт, доставка, оплата и контакты.",
    "Напишите, что вам нужно, и я постараюсь быстро сориентировать."
  ].join(" ");
}

function isWorkFollowUp(messages: any[], latestText: string) {
  if (!isLikelyFollowUp(latestText)) {
    return false;
  }

  const recentContext = messages.slice(-8, -1);
  return recentContext.some((message) => containsWorkKeywords(normalizeText(message?.content)));
}

function containsWorkKeywords(text: string) {
  return WORK_KEYWORDS.some((keyword) => text.includes(keyword));
}

function containsStrongOfftopicKeywords(text: string) {
  return STRONG_OFFTOPIC_KEYWORDS.some((keyword) => text.includes(keyword));
}

function isLikelyFollowUp(text: string) {
  if (text.length <= 40) {
    return true;
  }

  return FOLLOW_UP_HINTS.some((hint) => text.includes(hint));
}

function isGreeting(text: string) {
  return GREETING_PATTERNS.some((pattern) => text === pattern || text.startsWith(`${pattern} `));
}

function normalizeText(value: string | undefined) {
  return String(value || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ")
    .trim();
}
